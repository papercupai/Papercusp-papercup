/**
 * Guarded operator read/admit/retire surface for the one persisted frozen repair queue.
 *
 * `admit` (P-002 of frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-004/D-010) is
 * THE door through which a fix reaches a frozen candidate's judged lineage: exactly the named
 * paths, taken from the integration branch (or an explicitly pinned ancestor commit), replayed onto the queue's `repairHead` by
 * `admitPathsOntoRepairHead`. Nothing here fast-forwards, merges, or reads the tip as a whole —
 * the pre-D-004 `converge` (fast-forward repairHead to the staging tip) is gone, and `converge`
 * is now only an alias for `admit` so a stale runbook still lands on the right door.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import type { AbortCompletionContext, AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveCheckpointRouting, resolvePotSuiteCommand } from '../../harness/routines/hive-release-env';
import type { GateVerdictTarget } from '../../release/gate-verdict-target';
import { getTask } from '../../task-manager/store';
import { newTaskId } from '../../task-manager/types';
import {
  applyFrozenCandidateRepairQueueTransition,
  readFrozenCandidateRepairQueueState,
  retireFrozenCandidateRepairQueue,
  writeFrozenCandidateRepairQueue,
} from '../../harness/routines/release-actions';
import { integrationRoot } from '../../release-deploy-launch';
import { releaseFixerSpawnAlive } from '../../release/fixer-liveness';
import { verifyOwnerForceDirective } from '../work_items/release-force-guard';
import { checkpointPidIdentity, readStoredQualification } from '../../release/checkpoint-qualification-transaction';
import { isPidAlive } from '../../release/in-flight-candidate';
import {
  describeUnreadableFrozenCandidateRepairQueue,
  diagnoseFrozenCandidateRepairQueue,
  frozenRepairAdmissionHandoffBlock,
  frozenRepairHeadAwaitsVerification,
  markFrozenRepairAdmitted,
  normalizeRepoPath,
  settleFrozenRepairAdmission,
  summarizeAdmissionRadius,
  type FrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueueRead,
  type FrozenRepairAdmission,
  type FrozenRepairAdmissionPrecheck,
  FROZEN_REPAIR_PRECHECK_RESERVATION_PREFIX,
} from '../../release/frozen-candidate-repair-queue';
import {
  parseFrozenRepairEditHunk,
  readFrozenRepairEditLedger,
  recordFrozenRepairEdit,
  resolveFrozenRepairEditAgent,
  sqlFrozenRepairSessionBindingLookup,
  type FrozenRepairEditLedgerRow,
} from '../../release/frozen-repair-edit-ledger';
import {
  attributeUnledgeredPaths,
  findCarriedLedgerRowIds,
  summarizeForeignHunks,
  SOLE_EDITOR_WINDOW_MARGIN_MS,
  type EditAttributionRow,
  type HunkExactSuccess,
} from '../../release/hunk-exact-admission';
import {
  MAX_ADMISSION_SOURCES,
  normalizeAdmissionSources,
  type MultiSourceSuccess,
} from '../../release/multi-source-admission';
import { integrationBranch } from '../../release/judged-sha-containment';
import { realAdmissionGit } from '../../release/repair-head-admission';
// WI-10005223: admission and frozen-lineage Git work runs on the admission worker thread,
// never on the operator main thread (a single admit measured up to 61.8s of blocked event loop).
import {
  AdmissionOffthreadTimeoutError,
  AdmissionOffthreadTimeoutUnavailableError,
  runAdmissionJob,
} from '../../release/admission-offthread';
import { ADMISSION_RADIUS_CAP, type AdmissionJobKind, type AdmissionJobOf } from '../../release/admission-jobs';
import { isCohortTestPath } from '../../release/cohort-drag-patch-routing';
import { isCheckpointRunLockHeldCheap } from '../../release-checkpoint-lock';
import { createAdmissionStepClock } from '../../release/admission-step-clock';
import {
  ADMISSION_PREVIEW_INLINE_BUDGET_MS,
  createRoutineMetadataAdmissionPreviewStore,
  deferredAdmissionPreviewPayload,
  describeAdmissionPreviewOperation,
  emitAdmissionPreviewSettled,
  runAdmissionPreviewOperation,
  type AdmissionPreviewStore,
} from '../../release/admission-preview-operation';
import {
  ADMISSION_PRECHECK_MAX_FILES,
  ADMISSION_PRECHECK_PER_FILE_BUDGET_MS,
  ADMISSION_PRECHECK_SETUP_BUDGET_MS,
  evaluateFixPrecheck,
  precheckPopulation,
  resolveCanonicalIntegrationRoot,
  type FixPrecheckPopulation,
  type FixPrecheckVerdict,
} from '../../release/admission-fix-precheck';
import { ratchetAllowsPublication } from '../../release/admission-ratchet';
import { canonicalJson } from '@papercusp/hash-chain';
import {
  admissionPrecheckMeasurementIdentity,
  ADMISSION_TEST_ENVIRONMENT,
  settleAdmissionPrecheck,
  startAdmissionPrecheckWorker,
  validateAdmissionPrecheckResults,
  type AdmissionPrecheckWorkerInput,
} from '../../release/admission-fix-precheck-managed';
import { checkpointRootMirror } from '../../release-checkpoint-launch';
import { scheduleRepairAutoVerify } from '../../release/repair-auto-verify';
import {
  describeDependencyPrediction,
  isDependencyInputPath,
  predictDependencyGeneration,
  type DependencyGenerationPrediction,
} from '../../release/dependency-admission-prediction';
import { claimRepairManifestLeg, renderAdmitCommand } from '../../release/repair-manifest';
import { parseRepairTickLegs, sameHeadContradictionAnnotation } from '../../release/repair-tick-legs-snapshot';
import { readIdentity } from '../locks/identity';
import { readGateOwnership, shouldStandDownForLivePeer } from '../../coord/gate-ownership';
import { executeWithGateActionReceipt } from '../../release/gate-action-receipt';
import { asRecord, completedResultPayload } from '../abort-completion-payload';

// Bounded result doors keep leading fields. Put the small authorization verdict
// before queue diagnostics so a large repairQueue cannot erase whether this
// caller is the delegated fixer. Keep the bulky contextual fields last.
const PRIORITY_CONTEXT_KEYS = ['callerAuthorization'];
const TRAILING_CONTEXT_KEYS = ['target', 'source', 'repairQueue', 'repairQueueRead', 'timings'];
export function decisionFieldsFirst(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const rec = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (!TRAILING_CONTEXT_KEYS.includes(key) && !PRIORITY_CONTEXT_KEYS.includes(key)) out[key] = value;
  }
  for (const key of PRIORITY_CONTEXT_KEYS) if (key in rec) out[key] = rec[key];
  for (const key of TRAILING_CONTEXT_KEYS) if (key in rec) out[key] = rec[key];
  return out;
}
const json = (payload: unknown) => ({ data: decisionFieldsFirst(payload) });
const target = (ctx: { workspaceId?: unknown; harnessSlug?: string | null } = {}): GateVerdictTarget => ({
  workspaceId: typeof ctx.workspaceId === 'string' && ctx.workspaceId.trim() && ctx.workspaceId !== '*'
    ? ctx.workspaceId : activeWorkspaceId(),
  installSlug: resolveConcreteHarnessSlug(undefined, ctx) ?? operatorHomeHarnessSlug(),
});

/**
 * A completed `release:repair-queue` call can outlive dispatch's deadline after it has
 * committed a queue or edit-ledger write. Surface only the durable identity returned by
 * that exact operation; a success-shaped response without one is not proof of persistence.
 */
export function repairQueueAbortCompletionReceipt(
  _args: unknown,
  result: ToolResult,
  context: AbortCompletionContext,
): AbortCompletionReceipt {
  if (context.toolName !== 'release:repair-queue' || !context.callId.trim()) {
    return {
      status: 'recovery-incomplete',
      reason: 'release:repair-queue receipt did not receive the dispatch attempt identity',
      failures: ['missing-attempt-identity'],
    };
  }
  const payload = completedResultPayload(result);
  if (!payload) {
    return {
      status: 'recovery-incomplete',
      reason: 'release:repair-queue result did not contain a parseable completion payload',
      failures: ['missing-result-payload'],
    };
  }

  const completionReceipt = asRecord(payload.completionReceipt);
  const effectRef = typeof completionReceipt?.effectRef === 'string' ? completionReceipt.effectRef.trim() : '';
  if (completionReceipt?.status === 'recorded' && effectRef.startsWith('release:repair-queue:')) {
    return { status: 'recorded', effectRef };
  }
  if (completionReceipt?.status === 'not-recorded') {
    return {
      status: 'not-recorded',
      ...(typeof completionReceipt.reason === 'string' ? { reason: completionReceipt.reason } : {}),
    };
  }

  const op = payload.op;
  if (
    op === 'get' ||
    payload.dryRun === true ||
    payload.alreadyClear === true ||
    payload.verdict === 'no-frozen-queue' ||
    (payload.pending === true && payload.verdict === 'precheck-running') ||
    (op === 'record-edit' && payload.recorded === true && payload.inserted === false) ||
    (op === 'retire' && payload.retired === false && payload.casMiss === true) ||
    (payload.refused === true && payload.effectMayHaveRun === false)
  ) {
    return { status: 'not-recorded', reason: 'completed response proves this attempt made no repair-queue write' };
  }

  return {
    status: 'recovery-incomplete',
    reason: 'release:repair-queue result did not prove whether its write committed',
    failures: [effectRef ? 'invalid-completion-receipt' : 'missing-completion-receipt'],
  };
}
const FULL_COMMIT_SHA = /^[0-9a-f]{40,64}$/;
// Stay ahead of the observed 300s MCP client deadline. This applies to read-only previews only.
const ADMISSION_PREVIEW_JOB_TIMEOUT_MS = 4 * 60 * 1000;
const queueIdentityFields = {
  /** The frozen queue snapshot the caller read before building this admission. */
  expectedCandidate: z
    .string()
    .regex(/^[0-9a-fA-F]{40,64}$/)
    .optional(),
  expectedRepairHead: z
    .string()
    .regex(/^[0-9a-fA-F]{40,64}$/)
    .optional(),
  expectedUpdatedAtMs: z.number().int().nonnegative().optional(),
};
type QueueIdentityArgs = {
  expectedCandidate?: string;
  expectedRepairHead?: string;
  expectedUpdatedAtMs?: number;
};
type QueueIdentity = {
  expectedCandidate: string;
  expectedRepairHead: string;
  expectedUpdatedAtMs: number;
};

/**
 * The identity tuple is optional for backwards-compatible reads/dry-runs, but it is never
 * partially meaningful. The schema rejects partial tuples; this runtime helper keeps direct
 * handler calls equally fail-closed when a caller bypasses the parser in a unit test.
 */
function readQueueIdentity(args: QueueIdentityArgs): QueueIdentity | null {
  const fields: Array<keyof QueueIdentityArgs> = ['expectedCandidate', 'expectedRepairHead', 'expectedUpdatedAtMs'];
  const supplied = fields.filter((field) => args[field] !== undefined);
  if (supplied.length === 0) return null;
  if (supplied.length !== fields.length) {
    throw new Error(
      'release:repair-queue admit expectedCandidate, expectedRepairHead, and expectedUpdatedAtMs must be supplied together',
    );
  }
  return {
    expectedCandidate: args.expectedCandidate!,
    expectedRepairHead: args.expectedRepairHead!,
    expectedUpdatedAtMs: args.expectedUpdatedAtMs!,
  };
}

async function emitRetiredUnjudgedRepairHeadTerminal(
  queue: FrozenCandidateRepairQueue,
  pipeline: string,
): Promise<{
  status: 'emitted' | 'partial' | 'failed';
  sha: string;
  emittedKeys: string[];
  failedKeys: string[];
}> {
  const summary = `${pipeline} frozen repair head ${queue.repairHead.slice(0, 8)} was retired before verification; no verdict rendered`;
  const payload = {
    sha: queue.repairHead,
    from: queue.candidate,
    pipeline,
    reason: 'repair-queue-retired-before-verification',
    summary,
    runId: null,
  };
  const cancelSiblingKeysFor = [
    'release:green',
    `release:green:${pipeline}`,
    'green-checkpoint:red',
    `green-checkpoint:red:${pipeline}`,
    'green-checkpoint:held',
    `green-checkpoint:held:${pipeline}`,
  ];
  const keys = ['green-checkpoint:inconclusive', `green-checkpoint:inconclusive:${pipeline}`];
  const emittedKeys: string[] = [];
  const failedKeys: string[] = [];

  try {
    const { emitAwaitedEvent } = await import('../../events/await/engine');
    for (const key of keys) {
      try {
        await emitAwaitedEvent({
          key,
          summary,
          payload,
          source: 'release:repair-queue-retire',
          cancelSiblingKeysFor,
        });
        emittedKeys.push(key);
      } catch (error) {
        failedKeys.push(key);
        console.warn(
          `[release:repair-queue] inconclusive retire wake failed for ${queue.repairHead} on ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    failedKeys.push(...keys);
    console.warn(
      `[release:repair-queue] inconclusive retire wake setup failed for ${queue.repairHead}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    status: failedKeys.length === 0 ? 'emitted' : emittedKeys.length > 0 ? 'partial' : 'failed',
    sha: queue.repairHead,
    emittedKeys,
    failedKeys,
  };
}

/**
 * Upper bound on `paths` for one admit/converge call. Admission refuses an incomplete
 * sibling closure (`admission-incomplete`) and pairs sources with their tests, so a
 * cohort must land in ONE call. If this bound sat below a real closure, that fix could
 * never be admitted at all. The old bound of 50 did exactly that on 2026-10-21: the
 * plan-types cohort needed 52 and a sources-only split was refused and grew its tests
 * back (WI-6554700010019489). Keep it well above observed closures; the call's cost
 * scales with path count, so callers on a short transport deadline should batch.
 */
export const REPAIR_QUEUE_ADMIT_MAX_PATHS = 200;

/** R-2: one source of a multi-source admit. Mode rules are checked by normalizeAdmissionSources. */
const admissionSourcesSchema = z
  .array(
    z.object({
      paths: z.array(z.string().min(1)).min(1).max(REPAIR_QUEUE_ADMIT_MAX_PATHS),
      wholeBlob: z.boolean().optional(),
      sourceCommit: z.string().regex(FULL_COMMIT_SHA).optional(),
      patchCommit: z.string().regex(FULL_COMMIT_SHA).optional(),
      patchCommits: z.array(z.string().regex(FULL_COMMIT_SHA)).min(1).max(20).optional(),
    }),
  )
  .min(1)
  .max(MAX_ADMISSION_SOURCES);

/** The union of the sources' paths, first-appearance order — what `paths` defaults to. */
function sourcesPathUnion(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const union: string[] = [];
  for (const s of sources) {
    const paths = s && typeof s === 'object' ? (s as { paths?: unknown }).paths : undefined;
    if (!Array.isArray(paths)) continue;
    for (const p of paths) if (typeof p === 'string' && !union.includes(p)) union.push(p);
  }
  return union;
}

const argsSchema = z.preprocess(
  (value) => {
    // The read branch has no arguments. Treat an omitted op on an otherwise
    // empty object as the read operation, while leaving malformed branch
    // payloads subject to the discriminated-union requirements below.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length === 0) {
        return { op: 'get' };
      }
      // `status` is the read verb across the sibling release:* family —
      // `release:deploy { op: 'status' }` is the documented read for the very
      // same intent — so agents reach for it here and get an invalid_input
      // refusal naming an enum with no `status` in it. Measured 3x in 24h from
      // 2 distinct agents. Accept it as an alias for the read branch rather
      // than leaving the family's naming split. The result `op` echoes the
      // normalized `get`, so downstream readers see one canonical value.
      if (record.op === 'status') {
        return { ...record, op: 'get' };
      }
      // R-2: a multi-source admit may omit `paths`; it is the union of the sources' paths.
      if ((record.op === 'admit' || record.op === 'converge') && record.paths === undefined) {
        const union = sourcesPathUnion(record.sources);
        if (union.length > 0) return { ...record, paths: union };
      }
    }
    return value;
  },
  z
    .discriminatedUnion('op', [
      z.object({
        op: z.literal('get'),
        /** R-1: read the settled verdict of a dry run that returned `previewOperation`. */
        previewOperationId: z.string().min(4).max(80).optional(),
      }),
      z.object({
        op: z.literal('admit'),
        /** Repo-relative paths your fix touched — the admission allowlist. REQUIRED: an admission is by explicit path. */
        paths: z.array(z.string().min(1)).min(1).max(REPAIR_QUEUE_ADMIT_MAX_PATHS),
        reason: z.string().min(8).max(2000).optional(),
        confirm: z.boolean().optional(),
        /** Optional work-item reference linking this admission to its tracked fix. */
        workItem: z.string().max(120).optional(),
        ...queueIdentityFields,
        /** P-020 (D-008 3a): ALSO replay these agents' ledgered hunks — a genuinely shared fix. Never implied. */
        includeHunksFrom: z.array(z.string().min(1).max(200)).max(20).optional(),
        /** Exact hunk ledger row ids from a reviewed preview; keeps source stable across R6. */
        ledgerRowIds: z.array(z.number().int().positive().safe()).min(1).max(10000).optional(),
        /** P-020 (D-008 3b): admit staging's WHOLE blob (may carry foreign work). Requires `reason`; the ledger records every foreign hunk it carries. */
        wholeBlob: z.boolean().optional(),
        /** Pin whole-blob reads to one immutable integration-branch ancestor so a reviewed preview cannot drift with staging. */
        sourceCommit: z.string().regex(FULL_COMMIT_SHA).optional(),
        /** Explicit reviewed single-commit delta from staging history when hook capture is missing. Requires reason; incompatible with other source options. */
        patchCommit: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional(),
        /** Ordered reviewed deltas for dependent fixes; every selected path must change in each commit. */
        patchCommits: z.array(z.string().regex(FULL_COMMIT_SHA)).min(1).max(20).optional(),
        /** R-2: several sources applied in order as ONE admission commit and one pre-check. Each names paths plus wholeBlob(+sourceCommit) or patchCommit(s). */
        sources: admissionSourcesSchema.optional(),
        /** P-006 (R6, D-002): opt OUT of the admission pre-check for a deliberate wide admission. Requires `precheckReason`; recorded on the ledger entry. */
        skipPrecheck: z.boolean().optional(),
        precheckReason: z.string().min(8).max(2000).optional(),
        /** Retry a terminal failed or deferred pre-check for the same immutable built commit. A running one is never duplicated. */
        retryPrecheck: z.boolean().optional(),
      }),
      z.object({
        /** Alias of admit, kept so a stale runbook lands on the same door. Identical semantics. */
        op: z.literal('converge'),
        paths: z.array(z.string().min(1)).min(1).max(REPAIR_QUEUE_ADMIT_MAX_PATHS),
        reason: z.string().min(8).max(2000).optional(),
        confirm: z.boolean().optional(),
        /** Optional work-item reference linking this aliased admission to its tracked fix. */
        workItem: z.string().max(120).optional(),
        ...queueIdentityFields,
        includeHunksFrom: z.array(z.string().min(1).max(200)).max(20).optional(),
        ledgerRowIds: z.array(z.number().int().positive().safe()).min(1).max(10000).optional(),
        wholeBlob: z.boolean().optional(),
        sourceCommit: z.string().regex(FULL_COMMIT_SHA).optional(),
        patchCommit: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional(),
        patchCommits: z.array(z.string().regex(FULL_COMMIT_SHA)).min(1).max(20).optional(),
        sources: admissionSourcesSchema.optional(),
        skipPrecheck: z.boolean().optional(),
        precheckReason: z.string().min(8).max(2000).optional(),
        retryPrecheck: z.boolean().optional(),
      }),
      z.object({
        /**
         * P-021 (D-007 #1): claim one repair-manifest leg. Claiming a leg claims its subject
         * paths — the caller's presence `current_files` is set to them so peers see the lane.
         * `release:true` gives the leg back (only the holder may).
         */
        op: z.literal('claim-leg'),
        /** The manifest row's `legId` (from get → repairQueue.manifest.rows[].legId). */
        leg: z.string().min(1).max(300),
        release: z.boolean().optional(),
      }),
      z.object({
        /**
         * P-019 (D-008 layer 1) — HOOK PLUMBING, never called by hand. The PostToolUse
         * edit hook records the exact hunk of one Edit/Write made while a candidate is frozen,
         * attributed to the calling per-session owner. P-020's hunk-exact admission replays it.
         */
        op: z.literal('record-edit'),
        /** Repo-relative path the edit touched (normalized server-side). */
        path: z.string().min(1).max(1024),
        hunk: z.unknown(),
        /** The client's tool_use_id — with editIndex, the idempotency key for a retried hook call. */
        toolUseId: z.string().max(200).optional(),
        editIndex: z.number().int().nonnegative().optional(),
        atMs: z.number().int().positive().optional(),
        /** The candidate the hook's marker named; a mismatch with the live queue is reported, never trusted. */
        candidate: z
          .string()
          .regex(/^[0-9a-fA-F]{40,64}$/)
          .optional(),
        workItem: z.string().max(120).optional(),
      }),
      z.object({
        op: z.literal('retire'),
        expectedCandidate: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
        expectedRepairHead: z.string().regex(/^[0-9a-fA-F]{40,64}$/),
        expectedUpdatedAtMs: z.number().int().nonnegative(),
        reason: z.string().min(8).max(2000),
        confirm: z.boolean().optional(),
        directiveRef: z.number().int().positive().optional()
          .describe('confirm:true needs this: the id of an open owner-typed directive addressed to you'),
      }),
    ])
    .superRefine((value, refinementCtx) => {
      if (value.op !== 'admit' && value.op !== 'converge') return;
      if (value.sources !== undefined) {
        const issue = (message: string) =>
          refinementCtx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message });
        if (
          value.wholeBlob !== undefined || value.sourceCommit !== undefined || value.patchCommit !== undefined ||
          value.patchCommits !== undefined || value.includeHunksFrom !== undefined || value.ledgerRowIds !== undefined
        ) {
          issue('sources replaces wholeBlob, sourceCommit, patchCommit(s), includeHunksFrom and ledgerRowIds — name each mode inside its source');
        }
        if (!value.reason || value.reason.trim().length < 8) issue('a multi-source admit needs a reason of at least 8 characters');
        const normalized = normalizeAdmissionSources(value.sources);
        if (!normalized.ok) {
          issue(normalized.sourceIndex !== undefined ? `source #${normalized.sourceIndex}: ${normalized.detail}` : normalized.detail);
        } else {
          const given = new Set(value.paths);
          if (given.size !== normalized.paths.length || normalized.paths.some((p) => !given.has(p))) {
            issue('paths must equal the union of the sources\' paths (omit paths to use that union)');
          }
        }
        return;
      }
      if (
        (value.patchCommit !== undefined || value.patchCommits !== undefined) &&
        (value.wholeBlob === true ||
          (value.patchCommit !== undefined && value.patchCommits !== undefined) ||
          (value.patchCommits !== undefined && new Set(value.patchCommits).size !== value.patchCommits.length) ||
          value.sourceCommit !== undefined ||
          value.includeHunksFrom !== undefined ||
          value.ledgerRowIds !== undefined ||
          !value.reason ||
          value.reason.trim().length < 8)
      ) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['patchCommit'],
          message: 'Use one reviewed patch source: patchCommit or distinct ordered patchCommits, without other source modes (wholeBlob, sourceCommit, includeHunksFrom, ledgerRowIds), and give a reason of at least 8 characters',
        });
      }
      if (value.sourceCommit !== undefined && value.wholeBlob !== true) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceCommit'],
          message: 'sourceCommit is only valid with wholeBlob:true',
        });
      }
      if (value.ledgerRowIds !== undefined && value.wholeBlob === true) {
        refinementCtx.addIssue({ code: z.ZodIssueCode.custom, path: ['ledgerRowIds'],
          message: 'ledgerRowIds is only valid for hunk-exact admission' });
      }
      const fields: Array<keyof QueueIdentityArgs> = ['expectedCandidate', 'expectedRepairHead', 'expectedUpdatedAtMs'];
      const supplied = fields.filter((field) => value[field] !== undefined).length;
      if (supplied === 0 || supplied === fields.length) return;
      for (const field of fields) {
        if (value[field] === undefined) {
          refinementCtx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: 'expectedCandidate, expectedRepairHead, and expectedUpdatedAtMs must be supplied together',
          });
        }
      }
    }),
);

export type FrozenRepairFixerAuthorizationStatus =
  | 'not-applicable'
  | 'unsigned-caller'
  | 'missing-spawn-id'
  | 'no-repair-queue'
  | 'wrong-phase'
  | 'queue-unassigned'
  | 'different-fixer'
  | 'queue-unreadable'
  | 'authorized-delegate';

export interface FrozenRepairFixerAuthorization {
  status: FrozenRepairFixerAuthorizationStatus;
  authorized: boolean | null;
  callerSpawnId: string | null;
  queueFixerSpawnId: string | null;
  safeAction: string;
}

/**
 * Authenticate a frozen-candidate release-fixer against the queue that launched it.
 *
 * A live su owns LIVE_GATE_OPS while the queue delegates the file/test repair to one
 * child. The generic ownership cell cannot distinguish that child from an unrelated
 * would-be fixer, so the child used to see the parent's live hold and self-cancel.
 * The signed MCP spawn id is the non-forgeable join: only the queue's current
 * `fixerSpawnId` is the delegated worker. Every missing/mismatched state fails closed.
 */
export function assessFrozenRepairFixerAuthorization(
  queue: FrozenCandidateRepairQueue | null,
  caller: {
    role?: string | null;
    spawnId?: string | null;
    sigVerifiedSpawn?: boolean | null;
    isSuperuser?: boolean | null;
  },
): FrozenRepairFixerAuthorization {
  const callerSpawnId = typeof caller.spawnId === 'string' && caller.spawnId.trim() ? caller.spawnId.trim() : null;
  const queueFixerSpawnId = queue?.fixerSpawnId ?? null;
  const result = (
    status: FrozenRepairFixerAuthorizationStatus,
    authorized: boolean | null,
    safeAction: string,
  ): FrozenRepairFixerAuthorization => ({
    status,
    authorized,
    callerSpawnId,
    queueFixerSpawnId,
    safeAction,
  });

  // EI-22208176411693669: the superuser-bearer transport (`?superuser=1` + loopback
  // bearer, _mcp-handler.ts's SU-bearer branch) never carries a verified per-spawn
  // signature — sigVerifiedSpawn is unconditionally absent/false there — and its
  // `?role=` query param is DELIBERATELY only a `tools/list` catalog-narrowing hint
  // (token-usage-reduction P-011), never a security identity assertion; dispatch
  // capability on that branch is already unconditional (isSuperuser bypasses role
  // gates platform-wide). So this caller can never legitimately reach
  // 'authorized-delegate' through the signed-spawn check no matter which role its
  // catalog was narrowed to — including 'release-fixer', which previously slipped
  // past the check below and landed on the fail-closed 'unsigned-caller' verdict
  // even when the caller genuinely was the queue's own delegated fixer. Route it to
  // 'not-applicable' like any other non-release-fixer-role caller: the buildReleaseFixerKickoff
  // brief already documents the fallback (compare fixerSpawnId to PAPERCUSP_SID
  // directly), and the converge write-gate independently authorizes this transport tier.
  if (caller.isSuperuser === true) {
    return result(
      'not-applicable',
      null,
      'This caller reached the queue over the superuser-bearer transport, which carries no verified per-spawn signature regardless of its ?role= catalog hint — the signed-delegate check does not apply here. Compare repairQueue.fixerSpawnId directly against your own PAPERCUSP_SID to confirm you remain the delegated fixer; converge is independently authorized for this transport tier.',
    );
  }
  if (caller.role !== 'release-fixer') {
    return result(
      'not-applicable',
      null,
      'This caller is not a release-fixer; use the ordinary operator/su queue policy.',
    );
  }
  if (caller.sigVerifiedSpawn !== true) {
    return result(
      'unsigned-caller',
      false,
      'STOP: the caller has no verified signed-spawn provenance, so it cannot inherit delegated repair authority.',
    );
  }
  if (!callerSpawnId) {
    return result('missing-spawn-id', false, 'STOP: the signed request carried no usable spawn id.');
  }
  if (!queue) {
    return result('no-repair-queue', false, 'STOP: no frozen repair queue currently delegates work.');
  }
  if (queue.phase !== 'awaiting-fixer') {
    return result('wrong-phase', false, `STOP: the repair queue is ${queue.phase}, not awaiting-fixer.`);
  }
  if (!queue.fixerSpawnId) {
    return result(
      'queue-unassigned',
      false,
      'STOP: the queue has not durably assigned a fixer spawn yet; retry the read after dispatch finalization rather than guessing.',
    );
  }
  if (queue.fixerSpawnId !== callerSpawnId) {
    return result('different-fixer', false, `STOP: this queue is delegated to ${queue.fixerSpawnId}, not this caller.`);
  }
  return result(
    'authorized-delegate',
    true,
    "Proceed only with the assigned repair: author on the shared staging checkout and land it with op:'admit' (path-exact; there is no repair worktree). A separate held-live LIVE_GATE_OPS owner is your delegator, not a competing fixer. Do not claim the gate, launch a checkpoint, mutate deployment, or work outside this queue identity.",
  );
}

/**
 * P-027 (D-014): before the door decides anything, make the row agree with the lineage ref.
 * A row that fell BEHIND the ref (a pre-D-014 run write-back dropped an admission the ref kept)
 * would otherwise refuse every admit with `lineage-ref-moved` until a human reset the ref by
 * hand. The rebuild is derived from the commits and persisted through the CAS transition, so a
 * concurrent writer is carried, not overwritten; a refusal (`ref-behind-row`, foreign commit,
 * git fault) leaves the row untouched and is reported on the inspect. Never fatal: an inspect
 * that cannot reconcile still answers with the row as stored.
 */
async function reconcileQueueRowWithLineage(
  queueTarget: ReturnType<typeof target>,
  queue: FrozenCandidateRepairQueue,
  root: string,
): Promise<{
  queue: FrozenCandidateRepairQueue;
  ledger: { status: string; reconciled: number; detail: string } | null;
}> {
  try {
    const { applyFrozenCandidateRepairQueueTransition } = await import('../../harness/routines/release-actions');
    const reconcile = (fresh: FrozenCandidateRepairQueue) =>
      runAdmissionJob(
        { kind: 'reconcile-lineage', queue: fresh, root },
        { timeoutMs: 120_000, stepName: 'lineage-reconcile' },
      );
    // This job only reads Git state, so it is safe to abandon on timeout. The timeout also
    // prevents the admission worker's load-failure fallback from running sync Git inline.
    const probe = await reconcile(queue);
    if (probe.status === 'in-sync') return { queue, ledger: null };
    if (probe.status !== 'reconciled') {
      return { queue, ledger: { status: probe.status, reconciled: 0, detail: probe.detail } };
    }
    let last = probe;
    const outcome = await applyFrozenCandidateRepairQueueTransition(queueTarget, async (fresh) => {
      last = await reconcile(fresh);
      return last.queue;
    });
    return {
      queue: outcome.queue ?? last.queue,
      ledger: { status: last.status, reconciled: last.reconciled.length, detail: last.detail },
    };
  } catch (err) {
    return {
      queue,
      ledger: { status: 'reconcile-failed', reconciled: 0, detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

type AdmissionRetractionProof = 'recorded' | 'parent' | 'head-moved' | 'unknown';

type AdmissionRetractionDecision = {
  /** The admission is already represented by the fresh row, so the ref must stay published. */
  persisted: boolean;
  /** `null` means no compensating ref write was attempted. */
  retracted: boolean | null;
  proof: AdmissionRetractionProof;
  detail: string;
  fresh: FrozenCandidateRepairQueue | null;
};

/**
 * Decide whether a published admission may be compensated after its queue-row write became
 * ambiguous. Retracting is safe only when a fresh, readable row still proves it is at the
 * admission's parent. A recorded admission and every other fresh head preserve the ref, and an
 * unreadable/absent row is unknown rather than evidence that nothing was written.
 */
async function settleFailedAdmissionRef(
  queueTarget: ReturnType<typeof target>,
  root: string,
  candidate: string,
  published: string,
  previousRepairHead: string,
  freshHint?: FrozenCandidateRepairQueue | null,
): Promise<AdmissionRetractionDecision> {
  let fresh = freshHint;
  if (fresh === undefined) {
    let read: FrozenCandidateRepairQueueRead;
    try {
      read = await readFrozenCandidateRepairQueueState(queueTarget);
    } catch (err) {
      return {
        persisted: false,
        retracted: null,
        proof: 'unknown',
        detail: `fresh queue re-read failed: ${err instanceof Error ? err.message : String(err)}`,
        fresh: null,
      };
    }
    if (read.status !== 'value') {
      return {
        persisted: false,
        retracted: null,
        proof: 'unknown',
        detail:
          read.status === 'absent'
            ? 'fresh queue re-read found no row; the admission state is unknown'
            : `fresh queue re-read was unreadable (${read.reason}); the admission state is unknown`,
        fresh: null,
      };
    }
    fresh = read.queue;
  }

  if (fresh === null) {
    return {
      persisted: false,
      retracted: null,
      proof: 'unknown',
      detail: 'fresh queue state was absent; the admission state is unknown',
      fresh: null,
    };
  }

  const recorded = (fresh.admissions ?? []).some(
    (admission) =>
      admission.toRepairHead === published && admission.fromRepairHead === previousRepairHead,
  );
  if (fresh.repairHead === published && recorded) {
    return {
      persisted: true,
      retracted: null,
      proof: 'recorded',
      detail: `fresh row records admission ${published.slice(0, 12)}; preserved the published lineage ref`,
      fresh,
    };
  }

  if (recorded) {
    return {
      persisted: false,
      retracted: null,
      proof: 'unknown',
      detail:
        `fresh row carries admission ${published.slice(0, 12)} but its repairHead is ` +
        `${fresh.repairHead.slice(0, 12)}; preserved the published lineage ref`,
      fresh,
    };
  }

  if (fresh.repairHead !== previousRepairHead) {
    return {
      persisted: false,
      retracted: null,
      proof: 'head-moved',
      detail:
        `fresh row is at ${fresh.repairHead.slice(0, 12)}, not the admission parent ` +
        `${previousRepairHead.slice(0, 12)}; preserved the published lineage ref`,
      fresh,
    };
  }

  let retracted: boolean;
  try {
    retracted = await runAdmissionJob({
      kind: 'retract',
      input: { root, candidate, published, previousRepairHead },
    });
  } catch (err) {
    return {
      persisted: false,
      retracted: null,
      proof: 'parent',
      detail:
        `fresh row still proves the admission parent, but retraction failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      fresh,
    };
  }
  return {
    persisted: false,
    retracted,
    proof: 'parent',
    detail: retracted
      ? `fresh row still proves the admission parent ${previousRepairHead.slice(0, 12)}; retracted the published lineage ref`
      : `fresh row still proves the admission parent ${previousRepairHead.slice(0, 12)}, but the lineage ref CAS did not retract`,
    fresh,
  };
}

/**
 * WI-10007509: mark the queue entries the latest repair tick passed at the live repairHead.
 * Same routine-row read as release-actions.ts's fixer dispatch (`gate_health.repairTickLegs`).
 * A failed read returns `unknown`, never "no contradiction".
 */
async function readSameHeadContradiction(
  installSlug: string,
  queue: { repairHead: string; failingTests?: readonly string[] | null },
): Promise<
  | ReturnType<typeof sameHeadContradictionAnnotation>
  | { status: 'unknown'; reason: 'repair-tick-legs-read-failed'; detail: string }
> {
  try {
    const rows = (await getOrgPg().sql.unsafe(
      `SELECT metadata->'gate_health'->'repairTickLegs' AS legs
         FROM harness_shared.routines
        WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'`,
      [installSlug],
    )) as Array<{ legs: unknown }>;
    return sameHeadContradictionAnnotation(queue.failingTests, parseRepairTickLegs(rows[0]?.legs), queue.repairHead);
  } catch (err) {
    return { status: 'unknown', reason: 'repair-tick-legs-read-failed', detail: String(err) };
  }
}

async function inspectQueue(queueTarget: GateVerdictTarget, root: string) {
  const read = await readFrozenCandidateRepairQueueState(queueTarget);
  let queue = read.status === 'value' ? read.queue : null;
  let ledger: { status: string; reconciled: number; detail: string } | null = null;
  if (queue) ({ queue, ledger } = await reconcileQueueRowWithLineage(queueTarget, queue, root));
  // New R6 runs live in task-manager scopes and persist progress/verdict by operationId.
  // The launcher host PID is only the pre-spawn race guard; after the task row exists,
  // replacing that host must not cancel or fail an active pre-check.
  const pending = queue?.admissionPrecheck;
  if (queue && pending?.status === 'running') {
    let managedTask: Awaited<ReturnType<typeof getTask>> | null = null;
    let taskReadError: unknown;
    if (pending.runnerTaskId) {
      try {
        managedTask = await getTask(pending.runnerTaskId);
      } catch (err) {
        taskReadError = err;
      }
    }
    if (taskReadError) {
      ledger = {
        status: 'precheck-task-read-failed',
        reconciled: 0,
        detail: `Could not inspect managed runner ${pending.runnerTaskId}: ${String(taskReadError)}`,
      };
    }

    const managedTaskLive = managedTask?.state === 'pending' || managedTask?.state === 'running';
    const managedTaskEnded = Boolean(managedTask && !managedTaskLive);
    let launcherHostDead = false;
    if (!managedTask && !taskReadError && pending.runnerPidIdentity && pending.runnerPid) {
      const alive = isPidAlive(pending.runnerPid);
      const observedIdentity = alive === true ? checkpointPidIdentity(pending.runnerPid) : null;
      launcherHostDead = alive === false || (observedIdentity !== null && observedIdentity !== pending.runnerPidIdentity);
    }
    const runnerLost = !taskReadError && (managedTaskEnded || launcherHostDead);
    if (runnerLost) {
      const detail = managedTaskEnded
        ? `Managed R6 pre-check task ${pending.runnerTaskId} ended as ${managedTask!.state} ` +
          `(exit=${managedTask!.exitCode ?? 'unknown'}${managedTask!.exitReason ? `, reason=${managedTask!.exitReason}` : ''}) ` +
          `before persisting a verdict for ${pending.builtCommit.slice(0, 12)}.`
        : `R6 pre-check launcher host process ${pending.runnerPid} ended or was replaced before ` +
          `managed task ${pending.runnerTaskId ?? '(legacy runner)'} was registered; no verdict exists for ${pending.builtCommit.slice(0, 12)}.`;
      const verdict = evaluateFixPrecheck(
        precheckPopulation({ signature: queue.signature, admittedPaths: pending.files, ...(pending.radius ? { radius: pending.radius } : {}) }),
        { ran: false, reason: 'runner-failed', detail: `${detail} The admission remains fail-closed; retryPrecheck:true resumes matching durable evidence or starts a fresh measurement.` },
      );
      try {
        await settleAdmissionPrecheck(queueTarget, pending.operationId, verdict);
        const refreshed = await readFrozenCandidateRepairQueueState(queueTarget);
        if (refreshed.status === 'value') queue = refreshed.queue;
      } catch (err) {
        ledger = {
          status: 'precheck-reconcile-failed',
          reconciled: 0,
          detail: `Could not persist managed-runner failure for ${pending.operationId}: ${String(err)}`,
        };
      }
    }
  }
  let fixerAlive: boolean | null | undefined;
  if (queue?.fixerSpawnId) {
    fixerAlive = await releaseFixerSpawnAlive(getOrgPg().sql, queue.fixerSpawnId).catch(() => null);
  }
  return {
    target: queueTarget,
    read,
    queue,
    fixerAlive,
    /** P-027: null when the row already agreed with the lineage ref; otherwise what the reconcile did or refused. */
    ledger,
    diagnostic: diagnoseFrozenCandidateRepairQueue(queue, { nowMs: Date.now(), fixerAlive }),
  };
}

async function inspectFixerLiveness(queue: FrozenCandidateRepairQueue | null) {
  if (!queue?.fixerSpawnId) return null;
  return releaseFixerSpawnAlive(getOrgPg().sql, queue.fixerSpawnId).catch(() => null);
}

/**
 * P-006 (R6): the compact pre-check record carried on the ledger entry, the audit row and the result.
 * P-007 (green-main-cycle-time-2026-10-08#D-040): every branch also carries the admission's radius
 * summary, so a later red round can tell an over-cap (unguarded) admission from a guarded one.
 * Exported for its tests only.
 */
export function precheckRecordOf(
  verdict: FixPrecheckVerdict | null,
  ctx: { skipPrecheck: boolean; precheckReason: string; dryRun: boolean; population: FixPrecheckPopulation },
): NonNullable<FrozenRepairAdmission['precheck']> {
  const summary = summarizeAdmissionRadius(ctx.population.radius);
  const radius = summary ? { radius: summary } : {};
  if (verdict === null) {
    if (ctx.skipPrecheck)
      return { ran: false, reason: 'skipped', precheckReason: ctx.precheckReason, wouldRun: ctx.population.files, ...radius };
    if (ctx.population.files.length === 0) return { ran: false, reason: 'nothing-to-run', ...radius };
    return { ran: false, reason: ctx.dryRun ? 'dry-run' : 'not-run', wouldRun: ctx.population.files, ...radius };
  }
  if (verdict.ran) {
    return {
      ran: true,
      commit: verdict.commit,
      passing: verdict.passing,
      failing: verdict.failing,
      unmeasured: verdict.unmeasured,
      ...(verdict.ok ? { fixes: verdict.fixes } : {}),
      ...radius,
    };
  }
  return {
    ran: false,
    reason: verdict.reason,
    ...('detail' in verdict ? { detail: verdict.detail } : {}),
    wouldRun: ctx.population.files,
    ...radius,
  };
}

// Setup and per-file budgets are imported from the runner (admission-fix-precheck.ts) so
// this deadline can never drift from the budgets the runner actually enforces (WI-10006014).
const ADMISSION_PRECHECK_SETTLEMENT_BUDGET_MS = 60_000;

function sameAdmissionPrecheck(
  state: FrozenRepairAdmissionPrecheck | undefined,
  input: {
    root: string;
    candidate: string;
    repairHead: string;
    builtCommit: string;
    builtTree: string;
    files: readonly string[];
    actor: string;
    sourceCommit: string;
    radius: FixPrecheckPopulation['radius'];
    signature: FrozenCandidateRepairQueue['signature'];
  },
): state is FrozenRepairAdmissionPrecheck {
  if (!state || state.testEnvironment !== ADMISSION_TEST_ENVIRONMENT) return false;
  // Resume retains the original measured commit. A rebuilt synthetic commit may
  // have a new message/time but must prove the same TREE (checked below).
  // WI-6554700010030176: the source commit is NOT part of that proof. For a path
  // admission input.sourceCommit is the staging tip at admit time, which git-sync
  // advances every few minutes; requiring it to match discarded a passed 151-file
  // pre-check whose built tree was byte-identical, so any pre-check spanning one
  // git-sync commit could never be confirmed. The measured tree is the content that
  // was tested, and the identity hash below still binds the stored measurement to
  // its own operation (including the source it was measured from).
  if (state.measurement && (
    // EI-27114233692780034: state.radius is a jsonb read-back (keys re-ordered), so compare canonically.
    canonicalJson(state.radius) !== canonicalJson(input.radius) ||
    state.measurement.identity !== admissionPrecheckMeasurementIdentity(state, input.signature)
  )) return false;
  const measuredTree = (() => {
    if (state.builtTree !== undefined) return state.builtTree;
    if (state.builtCommit === input.builtCommit) return input.builtTree;
    const result = realAdmissionGit(['rev-parse', '--verify', `${state.builtCommit}^{tree}`], { cwd: input.root });
    const tree = result.stdout.trim();
    return result.status === 0 && /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  })();
  return (
    state.candidate === input.candidate &&
    state.repairHead === input.repairHead &&
    // EI-23137352034265370: source-tip/reason provenance lives in the synthetic commit
    // message, so two builds can have different commit ids while carrying the exact same
    // admission tree on the same repairHead. Legacy markers resolve their commit tree here.
    measuredTree === input.builtTree &&
    state.actor === input.actor &&
    state.files.length === input.files.length &&
    state.files.every((file, index) => file === input.files[index])
  );
}

function admissionPrecheckDeadline(startedAtMs: number, files: readonly string[]): number {
  return (
    startedAtMs +
    ADMISSION_PRECHECK_SETUP_BUDGET_MS +
    files.length * ADMISSION_PRECHECK_PER_FILE_BUDGET_MS +
    ADMISSION_PRECHECK_SETTLEMENT_BUDGET_MS
  );
}

async function recordAudit(actor: string, details: Record<string, unknown>): Promise<boolean> {
  try {
    const id = `repair-queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await getOrgPg().sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        Date.now(),
        actor,
        'release:repair-queue',
        'green-checkpoint:repair-queue',
        JSON.stringify(details),
        activeWorkspaceId(),
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export default defineTool({
  name: 'release:repair-queue',
  timeoutSec: 295,
  profile: 'engineer',
  description:
    'Inspect, admit exact paths onto, claim a manifest leg of, or retire the frozen repair queue for the selected harness (operator home if unscoped). For gate-red fixes, `admit{paths}` is the only door: it replays named integration-branch paths onto repairHead as one proved commit. Dry-run unless `confirm:true`. R6 test files first return `precheck-running`; no background leg publishes. `converge` aliases `admit`; `retire` uses exact-identity CAS and is dry-run unless confirmed.',
  capability: 'operator:write',
  abortCompletionReceipt: repairQueueAbortCompletionReceipt,
  effectForCall: (args) => {
    const op = (args as { op?: unknown }).op;
    return op === undefined ||
      op === 'get' ||
      ((op === 'admit' || op === 'converge') && (args as { confirm?: unknown }).confirm !== true)
      ? 'read'
      : 'write';
  },
  requirePrincipal: false,
  // The release-fixer's runbook uses the read/dry-run and confirmed admit
  // paths; its existing operator:write cap keeps the write branch guarded.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  rolesQuota: { operator: { perRun: 20 } },
  guidance: {
    when: 'After a gate-red fix is committed on staging, use `admit{paths}` for exactly the changed files; also inspect a frozen, blocked, or dead-fixer queue.',
    notWhen:
      'Use the selected harness scope, not a harness/workspace key in the payload. Never catch up to tip, retire live/unknown work, launch a checkpoint, or deploy.',
    chaining:
      '`get` → preview `admit{paths, expectedCandidate, expectedRepairHead, expectedUpdatedAtMs}` → verify proof → repeat with `confirm:true`. Pin whole-blob source with `wholeBlob:true, sourceCommit:<reviewed ancestor SHA>, reason`. On `precheck-running`, read `get`; confirm only after pass with fresh identity. Retry only a terminal failed pre-check. For missed hooks, `patchCommit:<full SHA>, reason` replays one delta; `patchCommits:[<older SHA>,<newer SHA>], reason` replays dependent deltas before one R6/publication; each path must change in each commit. One commit from mixed sources: `sources:[{paths, wholeBlob|patchCommit(s)}], reason` (all-or-nothing). Retire only with `retireAllowed` and exact identity.',
    returns:
      '{ ok, op, verdict?, repairQueueRead?, admitted?, precheckOperation?, previewOperation?, admissionPreview?, dryRun?, judgedSha?, nextAction?, containment?, proof?, inconclusiveTerminal? }. A slow dry run returns `previewOperation`; read `get{previewOperationId}` for its `admissionPreview` or await its settle event. Read `nextAction`; a successful retire of an unjudged repairHead emits the exact-SHA inconclusive terminal and reports its wake status.',
    seeAlso: ['release:deploy', 'dev:pipeline_position', 'release:trace'],
  },
  args: argsSchema,
  result: z
    .object({
      ok: z.boolean().optional(),
      op: z.enum(['get', 'admit', 'claim-leg', 'record-edit', 'retire']).optional(),
      recorded: z.boolean().optional(),
      target: z.unknown().optional(),
      repairQueue: z.unknown().nullable().optional(),
      repairQueueRead: z.unknown().optional(),
      callerAuthorization: z.unknown().optional(),
      verdict: z.string().optional(),
      admitted: z.boolean().optional(),
      precheckOperation: z.unknown().optional(),
      // R-1: a dry run that outlasts the inline budget returns this handle; `get` reads it back.
      previewOperation: z.unknown().optional(),
      admissionPreview: z.unknown().optional(),
      dryRun: z.boolean().optional(),
      judgedSha: z.string().nullable().optional(),
      source: z.unknown().optional(),
      nextAction: z.unknown().nullable().optional(),
      containment: z.unknown().nullable().optional(),
      proof: z.unknown().optional(),
      admission: z.unknown().optional(),
      lineageRef: z.string().optional(),
      wouldMoveRepairHead: z.unknown().optional(),
      movedRepairHead: z.unknown().optional(),
      persisted: z.boolean().optional(),
      auditRecorded: z.boolean().optional(),
      note: z.string().optional(),
      reason: z.string().optional(),
      detail: z.string().optional(),
      stray: z.array(z.string()).optional(),
      retired: z.boolean().optional(),
      // WI-1105109: the post-retire procedure statement. Declared rather than left to
      // .passthrough() so it is part of the contract a test can pin.
      nextStep: z.string().optional(),
      alreadyClear: z.boolean().optional(),
      refused: z.boolean().optional(),
      casMiss: z.boolean().optional(),
      current: z.unknown().nullable().optional(),
      completionReceipt: z.object({
        status: z.enum(['recorded', 'not-recorded', 'recovery-incomplete']),
        effectRef: z.string().optional(),
        reason: z.string().optional(),
        failures: z.array(z.string()).optional(),
      }).optional(),
      inconclusiveTerminal: z.object({
        status: z.enum(['emitted', 'partial', 'failed']),
        sha: z.string(),
        emittedKeys: z.array(z.string()),
        failedKeys: z.array(z.string()),
      }).optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const queueTarget = target(ctx);
    const core = async () => {
    let scopeRoot = integrationRoot();
    let toolingRoot = scopeRoot;
    let testCommand: string[] | undefined;
    let precheckClearEnv: string[] = [];
    if (queueTarget.installSlug !== operatorHomeHarnessSlug()) {
      const routing = await resolveCheckpointRouting(queueTarget, scopeRoot);
      if (routing.skip) return json({ ok: false, refused: true, reason: 'checkpoint_routing_skip',
        target: queueTarget, detail: routing.skip.reason });
      scopeRoot = routing.extraEnv.PAPERCUSP_INTEGRATION_ROOT ?? routing.root;
      toolingRoot = routing.root;
      precheckClearEnv = routing.clearEnv;
      const suite = await resolvePotSuiteCommand(queueTarget.installSlug, queueTarget.workspaceId);
      testCommand = suite?.trim().split(/\s+/).filter(Boolean);
    }
    // WI-10005695: admit/converge report per-step timings (response `timings`) and log a step
    // that is still running after 30s, so a call whose client gives up is still localizable.
    const clock =
      args.op === 'admit' || args.op === 'converge'
        ? createAdmissionStepClock({
            context:
              `op=${args.op} paths=${Array.isArray(args.paths) ? args.paths.length : 0} ` +
              `dryRun=${args.confirm !== true} wholeBlob=${args.wholeBlob === true}`,
          })
      : null;
    try {
    const inspected = clock
      ? await clock.step('inspect-queue', () => inspectQueue(queueTarget, scopeRoot))
      : await inspectQueue(queueTarget, scopeRoot);
    const compactRead =
      inspected.read.status === 'value'
        ? { status: 'value' as const, schemaVersion: inspected.read.queue.schemaVersion }
        : inspected.read;
    const renderedQueue = inspected.read.status === 'unreadable' ? inspected.read : inspected.diagnostic;
    const callerAuthorization: FrozenRepairFixerAuthorization =
      inspected.read.status === 'unreadable'
        ? {
            status: 'queue-unreadable',
            authorized: false,
            callerSpawnId: typeof ctx.spawnId === 'string' && ctx.spawnId.trim() ? ctx.spawnId.trim() : null,
            queueFixerSpawnId: null,
            safeAction:
              `STOP: ${describeUnreadableFrozenCandidateRepairQueue(inspected.read)}. ` +
              'Do not infer that the queue is clear; use a reader that understands this schema.',
          }
        : assessFrozenRepairFixerAuthorization(inspected.queue, {
            role: ctx.role,
            spawnId: ctx.spawnId,
            sigVerifiedSpawn: ctx.sigVerifiedSpawn,
            isSuperuser: ctx.isSuperuser,
          });
    if (args.op === 'get') {
      const sameHeadContradicted = inspected.queue
        ? await readSameHeadContradiction(inspected.target.installSlug, inspected.queue)
        : null;
      const admissionPreview = args.previewOperationId
        ? await readAdmissionPreview(
            admissionPreviewStoreFor(queueTarget),
            args.previewOperationId,
            inspected.queue?.repairHead ?? null,
          )
        : undefined;
      return json({
        ok: true,
        op: 'get',
        ...(admissionPreview ? { admissionPreview } : {}),
        target: inspected.target,
        repairQueue: renderedQueue,
        repairQueueRead: compactRead,
        callerAuthorization,
        // WI-10007509: signature entries the latest repair tick passed at this exact repairHead.
        // Absent ⇒ no such contradiction was measured; `unknown` ⇒ the measurement was unreadable.
        ...(sameHeadContradicted ? { sameHeadContradicted } : {}),
        // P-027 (D-014): ledger/ref agreement. Absent ⇒ in sync on this read; `reconciled` ⇒ the
        // row was rebuilt from the lineage ref just now; any other status ⇒ a disagreement this
        // read refused to repair, with the reason.
        ...(inspected.ledger ? { lineageLedger: inspected.ledger } : {}),
      });
    }
    if (inspected.read.status === 'unreadable') {
      const op =
        args.op === 'retire'
          ? 'retire'
          : args.op === 'claim-leg'
            ? 'claim-leg'
            : args.op === 'record-edit'
              ? 'record-edit'
              : 'admit';
      return json({
        ok: false,
        op,
        ...(op === 'retire'
          ? { retired: false }
          : op === 'claim-leg'
            ? { claimed: false }
            : op === 'record-edit'
              ? { recorded: false }
              : { admitted: false }),
        refused: true,
        verdict: 'refused',
        reason: 'repair-queue-unreadable',
        detail:
          `${describeUnreadableFrozenCandidateRepairQueue(inspected.read)}; ` +
          'no queue mutation or moving-tip fallback was attempted',
        target: inspected.target,
        repairQueue: inspected.read,
        repairQueueRead: compactRead,
        callerAuthorization,
      });
    }
    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = readIdentity(ctx).ownerId;
    } catch {
      // The action receipt remains explicitly unknown if identity cannot be resolved.
    }
    let ownership: Awaited<ReturnType<typeof readGateOwnership>> | null = null;
    let ownershipObservedAt: string | null = null;
    try {
      ownership = await readGateOwnership({ harness: inspected.target.installSlug });
      ownershipObservedAt = new Date().toISOString();
    } catch {
      // A failed observation cannot be promoted to ownership proof.
    }
    const gateOwnershipReceipt = ownership?.claimState === 'held' && ownership.workItem
      ? { certainty: 'prelaunch-observation' as const, observedAt: ownershipObservedAt,
          conditionKey: ownership.eventKey, workItem: ownership.workItem,
          holder: ownership.takenBy, takenAt: ownership.takenAt,
          claimState: ownership.claimState, assessment: ownership.assessment }
      : { certainty: 'unknown' as const, observedAt: ownershipObservedAt,
          conditionKey: ownership?.eventKey ?? null, workItem: ownership?.workItem ?? null,
          holder: ownership?.takenBy ?? null, reason: ownership?.unknown?.code ?? 'no-held-condition' };
    let effectReceipt: { receiptId: string; ownership: Record<string, unknown> } | null = null;
    const stampActionEffect = (effect: Record<string, unknown>) => ctx.metadata?.({
      gateActionReceipt: {
        schemaVersion: effectReceipt ? 2 : 1,
        action: `repair-queue:${args.op}`,
        callerOwnerId,
        ...(effectReceipt ? { receiptId: effectReceipt.receiptId } : {}),
        ownership: effectReceipt?.ownership ?? gateOwnershipReceipt,
        delegate: {
          status: callerAuthorization.status,
          authorized: callerAuthorization.authorized,
          callerSpawnId: callerAuthorization.callerSpawnId,
          queueFixerSpawnId: callerAuthorization.queueFixerSpawnId,
        },
        target: { candidate: inspected.queue?.candidate ?? null, repairHead: inspected.queue?.repairHead ?? null },
        effect,
      },
    });
    stampActionEffect({ status: 'unknown', reason: 'no-settled-effect-receipt' });
    if (args.op !== 'record-edit' && callerAuthorization.status !== 'authorized-delegate' &&
        ownership && shouldStandDownForLivePeer(ownership, callerOwnerId)) {
      stampActionEffect({ status: 'refused-live-peer' });
      return json({ ok: false, op: args.op, refused: true, verdict: 'refused',
        reason: 'gate_condition_claimed_by_live_peer', ownership: gateOwnershipReceipt });
    }
    if (args.op === 'record-edit') {
      // P-019 (D-008 layer 1). The hook only calls this while the marker file exists, so the
      // common case never reaches here; when it does and nothing is frozen (a race with a
      // retire/promotion), there is no lineage to attribute to and nothing is written.
      const queue = inspected.queue;
      const base = { op: 'record-edit' as const, target: inspected.target, repairQueueRead: compactRead };
      if (!queue) {
        return json({ ok: true, recorded: false, verdict: 'no-frozen-queue', judgedSha: null, ...base });
      }
      const hunk = parseFrozenRepairEditHunk(args.hunk);
      if (!hunk) {
        return json({
          ok: false,
          recorded: false,
          refused: true,
          verdict: 'refused',
          reason: 'invalid-hunk',
          detail:
            "hunk must be { kind:'edit', old, new, replaceAll? } | { kind:'write', body } | { kind:'oversize', of, bytes, sha256 }",
          judgedSha: queue.repairHead,
          ...base,
        });
      }
      const identity = readIdentity(ctx);
      let outcome:
        | Awaited<ReturnType<typeof recordFrozenRepairEdit>>
        | { ok: false; reason: 'persist_failed'; detail: string };
      // P-004 / R-11: ledger under the signed agent session, not the transport's bare client id.
      const attribution = await resolveFrozenRepairEditAgent(
        identity.ownerId,
        sqlFrozenRepairSessionBindingLookup(getOrgPg().sql, inspected.target.workspaceId),
      );
      try {
        outcome = await recordFrozenRepairEdit(getOrgPg().sql, {
          workspaceId: inspected.target.workspaceId,
          installSlug: inspected.target.installSlug,
          candidate: queue.candidate,
          agent: attribution.agent,
          path: args.path,
          hunk,
          atMs: typeof args.atMs === 'number' && args.atMs > 0 ? args.atMs : Date.now(),
          toolUseId: args.toolUseId ?? '',
          editIndex: args.editIndex ?? 0,
          workItem: args.workItem ?? null,
        });
      } catch (err) {
        outcome = { ok: false, reason: 'persist_failed', detail: (err as Error).message };
      }
      if (!outcome.ok) {
        return json({
          ok: false,
          recorded: false,
          refused: true,
          verdict: 'refused',
          reason: outcome.reason,
          detail: outcome.detail,
          judgedSha: queue.repairHead,
          candidate: queue.candidate,
          ...base,
        });
      }
      const failing = new Set(queue.failingTests.map(normalizeRepoPath));
      const subject = new Set((queue.manifest?.rows ?? []).flatMap((row) => row.subjectPaths.map(normalizeRepoPath)));
      const inRepairRadius = failing.has(outcome.path) || subject.has(outcome.path);
      const suppliedCandidate = args.candidate?.toLowerCase();
      stampActionEffect({ status: 'edit-recorded', recorded: true, inserted: outcome.inserted,
        ledgerId: outcome.id, path: outcome.path });
      return json({
        ok: true,
        recorded: true,
        inserted: outcome.inserted,
        ...(outcome.inserted && outcome.id !== null
          ? { completionReceipt: {
              status: 'recorded',
              effectRef: `release:repair-queue:record-edit:${outcome.id}`,
            } }
          : {}),
        oversize: outcome.oversize,
        ledgerId: outcome.id,
        path: outcome.path,
        agent: attribution.agent,
        attributedVia: attribution.attributedVia,
        ...(attribution.agent !== attribution.transportOwnerId
          ? { transportOwnerId: attribution.transportOwnerId }
          : {}),
        candidate: queue.candidate,
        judgedSha: queue.repairHead,
        inRepairRadius,
        admitCommand: renderAdmitCommand([outcome.path]),
        ...(suppliedCandidate && suppliedCandidate !== queue.candidate.toLowerCase()
          ? { candidateMismatch: { marker: suppliedCandidate, queue: queue.candidate } }
          : {}),
        ...base,
      });
    }
    if (args.op === 'admit' || args.op === 'converge') {
      const root = scopeRoot;
      const branch = integrationBranch();
      const queue = inspected.queue;
      // P-002: a direct handler call (no schema preprocess) still derives paths from `sources`.
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((p) => typeof p === 'string' && p.trim())
        : args.sources !== undefined ? sourcesPathUnion(args.sources) : [];
      const base = {
        op: 'admit' as const,
        target: inspected.target,
        source: { ref: branch, root },
        repairQueue: inspected.diagnostic,
        repairQueueRead: compactRead,
        callerAuthorization,
        // WI-10005695: a GETTER on purpose. Every admit response spreads `...base`, and a
        // spread reads the getter at that moment, so each response carries the timings of
        // every step that settled before it was built, with no per-return wiring.
        get timings() {
          return clock?.summary() ?? null;
        },
      };
      if (!queue) {
        return json({
          ok: true,
          admitted: false,
          verdict: 'no-frozen-queue',
          judgedSha: null,
          containment: null,
          nextAction:
            'No frozen repair queue. Fix on staging as normal — git-sync commits it and the next ' +
            'candidate is cut from that tip. Do not fire release:checkpoint-run.',
          ...base,
        });
      }
      // WI-10005695: every slow step below runs through `step`, so the response and the
      // journal both name where an admit spent its time.
      const step = <T,>(name: string, run: () => Promise<T>): Promise<T> => (clock ? clock.step(name, run) : run());
      const runJob = <K extends AdmissionJobKind>(name: string, job: AdmissionJobOf<K>) =>
        step(name, () =>
          runAdmissionJob(
            job,
            args.op === 'admit' && args.confirm !== true
              ? { timeoutMs: ADMISSION_PREVIEW_JOB_TIMEOUT_MS, stepName: name }
              : undefined,
          ),
        );
      const containmentAt = async (judgedSha: string) =>
        paths.length
          ? runJob('containment', { kind: 'containment', paths, judgedSha, root, branch })
          : null;
      if (paths.length === 0) {
        return json({
          ok: false,
          admitted: false,
          refused: true,
          verdict: 'refused',
          reason: 'paths_required',
          detail:
            'admit is by explicit path allowlist: name exactly the repo-relative files your fix changed. ' +
            'Nothing is ever admitted by tip, branch or "everything since the candidate".',
          judgedSha: queue.repairHead,
          containment: null,
          ...base,
        });
      }
      const dryRun = args.confirm !== true;
      const expectedQueueIdentity = readQueueIdentity(args);
      if (
        expectedQueueIdentity &&
        (queue.candidate !== expectedQueueIdentity.expectedCandidate ||
          queue.repairHead !== expectedQueueIdentity.expectedRepairHead ||
          queue.updatedAtMs !== expectedQueueIdentity.expectedUpdatedAtMs)
      ) {
        return json({
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          reason: 'exact_queue_identity_mismatch',
          detail:
            'The queue changed after the caller read it; no admission was built. Re-read with op:get and retry with the complete expectedCandidate/expectedRepairHead/expectedUpdatedAtMs tuple.',
          judgedSha: queue.repairHead,
          currentQueueIdentity: {
            candidate: queue.candidate,
            repairHead: queue.repairHead,
            updatedAtMs: queue.updatedAtMs,
          },
          expectedQueueIdentity,
          containment: await containmentAt(queue.repairHead),
          ...base,
        });
      }
      // EI-22208176411693669: assessFrozenRepairFixerAuthorization above already routes
      // an isSuperuser caller to 'not-applicable' (never 'authorized-delegate') because
      // the SU-bearer transport carries no verified per-spawn signature regardless of its
      // cosmetic ?role= catalog hint. Without this clause a superuser caller whose ?role=
      // was forwarded as 'release-fixer' would still fail every disjunct here (role!=='su',
      // not an OPERATOR_CONFIG_WRITE_ROLE, authorized!==true) and be wrongly thrown out of
      // admission — even though dispatch capability on that transport is already
      // unconditional (isSuperuser bypasses role gates platform-wide, per
      // tool-projection.ts). Mirror that bypass here explicitly.
      if (
        ctx.role !== 'su' &&
        !isOperatorConfigWriteRole(ctx.role) &&
        ctx.isSuperuser !== true &&
        callerAuthorization.authorized !== true
      ) {
        throw new Error(
          'release:repair-queue admit requires an operator-config write role, su, or the exact signed release-fixer delegated by this queue',
        );
      }
      const identity = readIdentity(ctx);
      const activePrecheck = queue.admissionPrecheck;
      if (!dryRun && activePrecheck?.status === 'running' && activePrecheck.expiresAtMs > Date.now()) {
        return json({
          ...base,
          ok: true,
          admitted: false,
          pending: true,
          dryRun: false,
          verdict: 'precheck-running',
          judgedSha: queue.repairHead,
          precheckOperation: activePrecheck,
          currentQueueIdentity: {
            candidate: queue.candidate,
            repairHead: queue.repairHead,
            updatedAtMs: queue.updatedAtMs,
          },
          note: 'This queue already has one live R6 admission pre-check. It is the only admitted decision in flight and NOTHING publishes in the background. Re-read op:get after it settles; do not start a second pre-check.',
        });
      }
      // P-020 (D-008 layers 2–3): HUNK-EXACT by default. The source the primitive admits from
      // is a synthesised commit = repairHead + ONLY the caller's ledgered hunks per path, so a
      // peer's concurrent work in the same file never rides in. `wholeBlob:true` (with a
      // reason) is the explicit, ledgered widening; `includeHunksFrom` replays named peers.
      let wholeBlob = args.wholeBlob === true;
      const includeHunksFrom = (args.includeHunksFrom ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
      const hasPatchSource = args.patchCommit !== undefined || args.patchCommits !== undefined;
      const multiSourceArgs = args.sources;
      let mode: 'committed-patch' | 'whole-blob' | 'hunk-exact' | 'multi-source' =
        multiSourceArgs !== undefined ? 'multi-source' : hasPatchSource ? 'committed-patch' : wholeBlob ? 'whole-blob' : 'hunk-exact';
      if (
        hasPatchSource &&
        (wholeBlob ||
          (args.patchCommit !== undefined && args.patchCommits !== undefined) ||
          (args.patchCommits !== undefined &&
            (!Array.isArray(args.patchCommits) || args.patchCommits.length < 1 || args.patchCommits.length > 20 ||
              args.patchCommits.some((sha) => typeof sha !== 'string' || !FULL_COMMIT_SHA.test(sha)) ||
              new Set(args.patchCommits).size !== args.patchCommits.length)) ||
          args.sourceCommit !== undefined ||
          args.includeHunksFrom !== undefined ||
          args.ledgerRowIds !== undefined ||
          !args.reason ||
          args.reason.trim().length < 8)
      ) {
        return json({
          ...base,
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          mode,
          reason: 'invalid-patch-source',
          detail: 'Use one reviewed patch source: patchCommit or distinct ordered patchCommits, without other source modes (wholeBlob, sourceCommit, includeHunksFrom, ledgerRowIds), and give a reason of at least 8 characters',
        });
      }
      if (args.sourceCommit !== undefined && !wholeBlob) {
        return json({
          ...base,
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          mode,
          reason: 'invalid-source-commit',
          detail: 'sourceCommit is only valid with wholeBlob:true',
        });
      }
      if (wholeBlob && args.ledgerRowIds !== undefined) {
        return json({ ...base, ok: false, admitted: false, refused: true, dryRun,
          verdict: 'refused', reason: 'invalid-ledger-selection',
          detail: 'ledgerRowIds is only valid for hunk-exact admission' });
      }
      let ledgerRows: FrozenRepairEditLedgerRow[] = [];
      let ledgerReadError: string | null = null;
      try {
        ledgerRows = await step('ledger-read', () =>
          readFrozenRepairEditLedger(getOrgPg().sql, {
            workspaceId: inspected.target.workspaceId,
            installSlug: inspected.target.installSlug,
            candidate: queue.candidate,
            paths,
          }),
        );
      } catch (err) {
        ledgerReadError = (err as Error).message;
      }
      // P-004 (gate-throughput-shift-left-2026-10-06, EI-24313562050732849 / EI-24557368838482892):
      // when NOTHING on any requested path reached the hunk ledger, ask the independent edit
      // attribution ledger. Caller-only editors on every path ⇒ admit staging's blob, pinned to the
      // sha read now, under an automatic recorded reason. Otherwise hunk-exact refuses as before,
      // with the attribution verdict appended so the refusal names exactly why.
      let attributionNote: string | null = null;
      // The sole-editor fallback supplies these. Never reassign `args`: any reassignment drops the
      // op:'admit' narrowing inside the closures below (buildAdmission reads both).
      let effectiveSourceCommit = args.sourceCommit;
      let effectiveReason = args.reason;
      if (
        mode === 'hunk-exact' &&
        args.ledgerRowIds === undefined &&
        ledgerReadError === null &&
        paths.every((p) => !ledgerRows.some((r) => r.path === p))
      ) {
        try {
          const cut = await runJob('sole-editor-candidate-time', {
            kind: 'git',
            argv: ['show', '-s', '--format=%ct', queue.candidate],
            cwd: root,
          });
          const tip = await runJob('sole-editor-pin', {
            kind: 'git',
            argv: ['rev-parse', '--verify', `${branch}^{commit}`],
            cwd: root,
          });
          const cutSec = Number(cut.stdout.trim());
          const pinned = tip.stdout.trim();
          if (cut.status === 0 && Number.isFinite(cutSec) && tip.status === 0 && FULL_COMMIT_SHA.test(pinned)) {
            const windowStartMs = cutSec * 1000 - SOLE_EDITOR_WINDOW_MARGIN_MS;
            const raw = await getOrgPg().sql`
              SELECT file, agent_id, ts
                FROM harness_shared.edit_attribution_ledger
               WHERE workspace_id = ${inspected.target.workspaceId}
                 AND file = ANY(${[...paths]}::text[])
                 AND ts >= to_timestamp(${windowStartMs / 1000})`;
            const rows: EditAttributionRow[] = raw.map((r) => ({
              path: String(r.file),
              agent: String(r.agent_id),
              tsMs: new Date(r.ts as string | Date).getTime(),
            }));
            const verdict = attributeUnledgeredPaths({
              paths,
              actor: identity.ownerId,
              includeHunksFrom,
              rows,
              windowStartMs,
            });
            if (verdict.ok) {
              wholeBlob = true;
              mode = 'whole-blob';
              effectiveSourceCommit = pinned;
              effectiveReason =
                `auto: sole post-freeze editor — no hunk reached the frozen ledger, and the edit attribution ledger ` +
                `records only ${identity.ownerId} editing ${paths.join(', ')} since the candidate cut`;
            } else {
              attributionNote = `edit attribution ledger: ${verdict.detail}`;
            }
          } else {
            attributionNote = 'edit attribution ledger: not consulted (could not read the candidate time or pin the integration tip)';
          }
        } catch (err) {
          attributionNote = `edit attribution ledger: unreadable (${(err as Error).message})`;
        }
      }
      let sourceRef = branch;
      let hunkExact: HunkExactSuccess | null = null;
      let patch: FrozenRepairAdmission['patch'];
      let patches: FrozenRepairAdmission['patches'];
      let foreign: ReturnType<typeof summarizeForeignHunks> = { count: 0, agents: [], byPath: {} };
      let multiSource: MultiSourceSuccess | null = null;
      if (multiSourceArgs !== undefined) {
        // R-2: every source applied in order onto repairHead as ONE source commit; the first
        // refused source refuses the whole call before anything is built or published.
        const refusedMulti = (code: string, detail: string, extra: Record<string, unknown> = {}) =>
          json({ ...base, ok: false, admitted: false, refused: true, dryRun, verdict: 'refused', mode,
            reason: code, detail, ...extra, judgedSha: queue.repairHead });
        const normalized = normalizeAdmissionSources(multiSourceArgs);
        if (!normalized.ok) {
          return refusedMulti(normalized.code, normalized.detail,
            normalized.sourceIndex !== undefined ? { sourceIndex: normalized.sourceIndex } : {});
        }
        const built = await runJob('multi-source', {
          kind: 'multi-source',
          input: { root, repairHead: queue.repairHead, integrationRef: branch, sources: normalized.sources, reason: effectiveReason! },
        });
        if (!built.ok) {
          return refusedMulti(built.code, built.detail, {
            ...(built.sourceIndex !== undefined ? { sourceIndex: built.sourceIndex } : {}),
            ...(built.path !== undefined ? { path: built.path } : {}),
          });
        }
        multiSource = built;
        sourceRef = built.sourceCommit;
        const wholeBlobPaths = built.applied.flatMap((a) => (a.kind === 'whole-blob' ? a.paths : []));
        foreign = summarizeForeignHunks(ledgerRows, wholeBlobPaths, identity.ownerId, includeHunksFrom);
      } else if (hasPatchSource) {
        const commits = args.patchCommits ?? [args.patchCommit!];
        for (let i = 1; i < commits.length; i++) {
          const order = await runJob('committed-patch-order', {
            kind: 'git', argv: ['merge-base', '--is-ancestor', commits[i - 1]!, commits[i]!], cwd: root,
          });
          if (order.status !== 0) return json({
            ...base, ok: false, admitted: false, refused: true, dryRun, verdict: 'refused', mode,
            reason: 'invalid-patch-source',
            detail: 'patchCommits must follow integration ancestry; no admission was built or published',
            judgedSha: queue.repairHead,
          });
        }
        const replayed: NonNullable<FrozenRepairAdmission['patch']>[] = [];
        let replayHead = queue.repairHead;
        for (const patchCommit of commits) {
          const built = await runJob('committed-patch', {
            kind: 'committed-patch',
            input: {
              root,
              repairHead: replayHead,
              patchCommit,
              integrationRef: branch,
              paths,
              reason: effectiveReason!,
            },
          });
          if (!built.ok) {
            return json({
              ...base,
              ok: false,
              admitted: false,
              refused: true,
              dryRun,
              verdict: 'refused',
              mode,
              reason: built.code,
              detail: built.detail,
              judgedSha: queue.repairHead,
            });
          }
          replayed.push(built.patch);
          replayHead = built.sourceCommit;
        }
        patch = replayed.at(-1)!;
        if (replayed.length > 1) patches = replayed;
        sourceRef = replayHead;
      } else if (wholeBlob) {
        if (!effectiveReason || effectiveReason.trim().length < 8) {
          return json({
            ok: false,
            admitted: false,
            refused: true,
            dryRun,
            verdict: 'refused',
            reason: 'reason_required',
            detail:
              "wholeBlob:true admits staging's whole blob of each path, which may carry other agents' concurrent work (D-008) — say why that is safe in `reason` (≥ 8 chars). Prefer the default hunk-exact admission, or includeHunksFrom:[<agent>] for a shared fix.",
            judgedSha: queue.repairHead,
            containment: await containmentAt(queue.repairHead),
            mode,
            ...base,
          });
        }
        if (effectiveSourceCommit !== undefined) {
          const sourceCommitArg = effectiveSourceCommit;
          const resolved = await runJob('source-commit-resolve', {
              kind: 'git',
              argv: ['rev-parse', '--verify', `${sourceCommitArg}^{commit}`],
              cwd: root,
            });
          const resolvedSha = resolved.stdout.trim();
          if (resolved.status !== 0 || !FULL_COMMIT_SHA.test(resolvedSha)) {
            return json({
              ok: false,
              admitted: false,
              refused: true,
              dryRun,
              verdict: 'refused',
              reason: 'source-commit-unresolvable',
              detail: `sourceCommit ${effectiveSourceCommit} does not resolve to a commit in the integration repository`,
              judgedSha: queue.repairHead,
              mode,
              ...base,
            });
          }
          const ancestor = await runJob('source-commit-ancestry', {
              kind: 'git',
              argv: ['merge-base', '--is-ancestor', resolvedSha, branch],
              cwd: root,
            });
          if (ancestor.status !== 0) {
            return json({
              ok: false,
              admitted: false,
              refused: true,
              dryRun,
              verdict: 'refused',
              reason: ancestor.status === 1 ? 'source-commit-not-integrated' : 'source-commit-ancestry-unavailable',
              detail:
                ancestor.status === 1
                  ? `sourceCommit ${resolvedSha} is not an ancestor of the integration branch ${branch}`
                  : `could not prove sourceCommit ancestry: ${(ancestor.stderr || ancestor.stdout).trim().slice(0, 400)}`,
              judgedSha: queue.repairHead,
              mode,
              ...base,
            });
          }
          sourceRef = resolvedSha;
        }
        foreign = summarizeForeignHunks(ledgerRows, paths, identity.ownerId, includeHunksFrom);
      } else {
        if (ledgerReadError !== null) {
          return json({
            ok: false,
            admitted: false,
            refused: true,
            dryRun,
            verdict: 'refused',
            reason: 'ledger-unavailable',
            detail: `the edit ledger could not be read (${ledgerReadError}) — hunk-exact admission cannot tell your hunks from a peer's. Retry, or admit explicitly with wholeBlob:true and a reason.`,
            judgedSha: queue.repairHead,
            containment: await containmentAt(queue.repairHead),
            mode,
            ...base,
          });
        }
        const built = await runJob('hunk-exact', {
            kind: 'hunk-exact',
            input: {
              root,
              candidate: queue.candidate,
              repairHead: queue.repairHead,
              paths,
              ledger: ledgerRows,
              actor: identity.ownerId,
              includeHunksFrom,
              ledgerRowIds: args.ledgerRowIds,
              consumedLedgerRowIds: (queue.admissions ?? []).flatMap((entry) => entry.ledgerRowIds ?? []),
              admissions: queue.admissions,
              nowMs: Date.now(),
            },
          });
        if (!built.ok) {
          return json({
            ok: false,
            admitted: false,
            refused: true,
            dryRun,
            verdict: 'refused',
            reason: built.code,
            detail: attributionNote ? `${built.detail}; ${attributionNote}` : built.detail,
            ...(built.path ? { path: built.path } : {}),
            ...(built.foreignAgents ? { foreignAgents: built.foreignAgents } : {}),
            ...(built.hunkIndex !== undefined ? { hunkIndex: built.hunkIndex } : {}),
            ...(built.step ? { step: built.step } : {}),
            exits: built.exits,
            judgedSha: queue.repairHead,
            containment: await containmentAt(queue.repairHead),
            mode,
            ...base,
          });
        }
        hunkExact = built;
        sourceRef = built.sourceCommit;
      }
      // P-006 (R6, D-002): the ADMISSION PRE-CHECK. A confirmed admit is two-phase: phase 1
      // builds + PROVES the admission commit unpublished (dryRun:true — a real object in the
      // root's store), the frozen signature's test-file entries plus any admitted test files
      // are measured AT that commit in the checkpoint tree, and only a non-red result reaches
      // phase 2 (the publishing build of the same tree onto the same parent; the lineage-ref
      // CAS still guards races). A gate run holding the checkpoint tree DEFERS the pre-check
      // (`verdict:'precheck-deferred'`, nothing launched or published; a kept measurement resumes
      // on the next confirm). Since green-main-ratchet-convergence-2026-10-17#P-006 a deferral is
      // never adopted for publication: the ratchet admits only measured results, so the old R-1
      // "publish loud, the gate re-judges" exception no longer applies (WI-6554700010030460).
      // Any runner/setup failure refuses publication because an unmeasured result never
      // counts as passing. `skipPrecheck:true` + `precheckReason` is the deliberate ledgered opt-out.
      let population = precheckPopulation({ signature: queue.signature ?? [], admittedPaths: paths });
      const skipPrecheck = args.skipPrecheck === true;
      const precheckReason = typeof args.precheckReason === 'string' ? args.precheckReason.trim() : '';
      if (skipPrecheck && precheckReason.length < 8) {
        return json({
          ...base,
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          reason: 'precheck-reason-required',
          detail:
            'skipPrecheck:true opts a confirmed admission OUT of the R6 pre-check (the built commit is not measured before publication) — say why that is safe in `precheckReason` (≥ 8 chars); it is recorded on the ledger entry.',
          judgedSha: queue.repairHead,
          containment: await containmentAt(queue.repairHead),
          mode,
        });
      }
      const buildAdmission = (dry: boolean) =>
        runJob(dry ? 'build-proof' : 'publish', {
          kind: 'admit',
          input: {
            root,
            candidate: queue.candidate,
            repairHead: queue.repairHead,
            paths,
            source: {
              ref: sourceRef,
              ...(wholeBlob && effectiveSourceCommit !== undefined ? { recordAsRef: branch } : {}),
            },
            actor: identity.ownerId,
            reason: effectiveReason,
            nowMs: Date.now(),
            dryRun: dry,
          },
          // P-004: the proved commit must resolve every relative import of every admitted TS/JS
          // file, or the door refuses `admission-incomplete` naming the sibling to admit. The
          // pinned whole-blob source is consulted when supplied; other modes preserve the
          // integration branch as the suggestion source. Nothing is admitted on the caller's behalf.
          // WI-10004232: and a lockfile workspace entry it moves must still agree with its manifest,
          // or npm install rewrites the lock and the promoted pin can never certify. Both checks
          // are rebuilt from this spec on the worker thread (admissionPreflightFromSpec).
          preflight: {
            probeRef: wholeBlob && effectiveSourceCommit !== undefined ? sourceRef : branch,
            // P-002: a multi-source call checks each REAL whole-blob source's cohort against the
            // combined admitted set (the synthesized commit's own diff is just the admitted paths).
            ...(multiSource
              ? { cohortSources: multiSource.cohortSources }
              : wholeBlob ? { enforceSourceCohort: true as const } : {}),
          },
        });
      // Build the immutable candidate first. Publication is the effect boundary,
      // and must happen only while the condition claim row is locked below.
      let outcome = await buildAdmission(true);
      // WI-8351: a gitlink directory is not a test filename. Resolve its own and paired test
      // population from the unpublished built commit BEFORE deciding whether R6 applies.
      // The serializable job runs all tree/blob reads on the existing admission worker.
      // Dry previews need the same immutable inventory as confirmation: a gitlink can
      // expand from zero plain-path tests to a population the pre-check cannot run.
      if (outcome.ok && !skipPrecheck) {
        const inventory = await runJob('precheck-population', {
          kind: 'precheck-population',
          input: { root, commit: outcome.commit, signature: queue.signature ?? [], admittedPaths: paths },
        });
        if (!inventory.ok) {
          return json({ ...base, ok: false, admitted: false, refused: true, dryRun,
            verdict: 'refused', reason: 'admission-precheck-unavailable', detail: inventory.detail,
            builtCommit: outcome.commit, judgedSha: queue.repairHead, containment: await containmentAt(queue.repairHead), mode });
        }
        population = inventory.population;
      }
      const precheckApplies = !dryRun && !skipPrecheck && population.files.length > 0;
      // WI-10004151 part 2: an admitted lockfile/patch moves repairHead onto dependency inputs
      // the gate must materialise (`--ensure-ref`) before it can judge anything. Ask the SAME
      // script now whether that would succeed, so a lock no installed tree can produce is
      // refused here instead of parking verification an hour later. `unknown` never refuses.
      const dependencyPaths = paths.filter(isDependencyInputPath);
      // A const, so the closure below keeps the narrowing (`outcome` is a reassigned `let`).
      const provedCommit = outcome.ok ? outcome.commit : null;
      const dependencyGeneration: DependencyGenerationPrediction | null =
        provedCommit !== null && dependencyPaths.length > 0
          ? await step('dependency-prediction', async () =>
              predictDependencyGeneration({
                integrationRoot: await resolveCanonicalIntegrationRoot(root),
                ...(toolingRoot !== root ? { toolingRoot } : {}),
                ref: provedCommit,
                paths: dependencyPaths,
              }),
            )
          : null;
      const dependencyNote = dependencyGeneration ? describeDependencyPrediction(dependencyGeneration) : null;
      if (outcome.ok && dependencyGeneration?.verdict === 'refused' && !dryRun && !skipPrecheck) {
        return json({
          ...base,
          ok: false,
          admitted: false,
          refused: true,
          dryRun: false,
          verdict: 'refused',
          reason: 'dependency-generation-unbuildable',
          detail: (dependencyNote ?? '').trim(),
          dependencyGeneration,
          builtCommit: outcome.commit,
          judgedSha: queue.repairHead,
          containment: await containmentAt(queue.repairHead),
          mode,
          note:
            'Nothing was published. The gate could never materialise these dependency inputs, so verification would park. ' +
            'Install the lock in the integration tree first (npm run install:safe) so a matching generation can be built, ' +
            'admit a lock that matches what is installed, or deliberately override with skipPrecheck:true + precheckReason.',
        });
      }
      let precheck: FixPrecheckVerdict | null = null;
      // The complete inventory is immutable; only each native execution group is
      // bounded. The managed worker persists per-file evidence between groups.
      if (precheckApplies && outcome.ok) {
        const builtCommit = outcome.commit;
        // The serving host's root may be a LINKED worktree (`:3170` runs from papercusp-staging);
        // the checkpoint tree, its run-lock and setup-release-checkout all key off the MAIN one.
        const precheckRoot = await resolveCanonicalIntegrationRoot(root);
        const matchingPrecheck = sameAdmissionPrecheck(queue.admissionPrecheck, {
          root,
          candidate: queue.candidate,
          repairHead: queue.repairHead,
          builtCommit,
          builtTree: outcome.tree,
          files: population.files,
          actor: identity.ownerId,
          sourceCommit: outcome.entry.source.sha,
          radius: population.radius,
          signature: queue.signature,
        })
          ? queue.admissionPrecheck
          : undefined;
        if (matchingPrecheck?.status === 'running' && matchingPrecheck.expiresAtMs > Date.now()) {
          const retrySourceCommit = matchingPrecheck.sourceCommit ?? outcome.entry.source.sha;
          return json({
            ...base,
            ok: true,
            admitted: false,
            pending: true,
            dryRun: false,
            verdict: 'precheck-running',
            judgedSha: queue.repairHead,
            precheckOperation: matchingPrecheck,
            currentQueueIdentity: {
              candidate: queue.candidate,
              repairHead: queue.repairHead,
              updatedAtMs: queue.updatedAtMs,
            },
            note:
              'R6 pre-check is still running and NOTHING publishes in the background. Re-read op:get. If status=deferred (checkpoint-tree-busy), wait for the active checkpoint run to release the tree before requesting another pre-check; deferred is not passing evidence. After status=passed, repeat this confirmed admit with the refreshed exact queue identity' +
              (wholeBlob ? ` and wholeBlob:true, sourceCommit:'${retrySourceCommit}'` : '') +
              '.',
          });
        }
        // green-main-ratchet-convergence-2026-10-17 P-006: a DEFERRED (checkpoint-tree-busy)
        // pre-check is not a measurement, so it is never adopted for publication — a repeat
        // confirm re-measures instead (the admission ratchet admits only measured results).
        if (
          matchingPrecheck?.status === 'passed' && matchingPrecheck.verdict?.ok === true && matchingPrecheck.verdict.ran
        ) {
          if (matchingPrecheck.files.length > ADMISSION_RADIUS_CAP || matchingPrecheck.measurement) {
            try {
              const measured = matchingPrecheck.measurement;
              if (!measured || measured.identity !== admissionPrecheckMeasurementIdentity(matchingPrecheck, queue.signature))
                throw new Error('missing or stale immutable aggregate identity');
              validateAdmissionPrecheckResults(population.files, measured.results, true);
              // D-004 ruling 1: re-judge against the SAME persisted paired baseline, never an implied one.
              precheck = evaluateFixPrecheck(population, { ran: true, commit: matchingPrecheck.builtCommit,
                results: measured.results }, { actor: identity.ownerId,
                ...(measured.previousHead ? { previousHead: measured.previousHead } : {}),
                ...(measured.confirmation ? { confirmation: measured.confirmation } : {}) });
            } catch (error) {
              precheck = evaluateFixPrecheck(population, { ran: false, reason: 'runner-failed', detail: String(error) });
            }
          } else precheck = matchingPrecheck.verdict;
        } else if (
          matchingPrecheck?.status === 'failed' &&
          matchingPrecheck.verdict?.ok === false &&
          args.retryPrecheck !== true
        ) {
          precheck = matchingPrecheck.verdict;
        } else {
          // WI-6554700010030460: no pre-check can run while a gate run holds the checkpoint tree
          // (the runner refuses with checkpoint-tree-busy, the same probe on the same root). Say
          // so NOW instead of launching a worker that defers seconds later: nothing is launched,
          // reserved, or published, and a kept deferred measurement resumes on the next confirm.
          const held = isCheckpointRunLockHeldCheap(precheckRoot);
          if (held.held) {
            return json({
              ...base,
              ok: true,
              admitted: false,
              pending: false,
              deferred: true,
              dryRun: false,
              verdict: 'precheck-deferred',
              reason: 'checkpoint-tree-busy',
              judgedSha: queue.repairHead,
              builtCommit,
              holder: { pid: held.pid ?? null, elapsedSec: held.elapsedSec },
              currentQueueIdentity: {
                candidate: queue.candidate,
                repairHead: queue.repairHead,
                updatedAtMs: queue.updatedAtMs,
              },
              note:
                `A green-checkpoint run holds the checkpoint tree (pid ${held.pid ?? '?'}, ${held.elapsedSec ?? '?'}s in), ` +
                'so the R6 pre-check cannot run; nothing was launched, reserved or published. A deferred pre-check is not ' +
                'passing evidence. Re-confirm this admit after that run releases the tree (kept per-file rows resume), ' +
                'or, for a deliberate wide admission, use skipPrecheck:true + precheckReason.',
            });
          }
          const startedAtMs = Date.now();
          const runnerTaskId = newTaskId(startedAtMs);
          const runnerPidIdentity = checkpointPidIdentity(process.pid);
          // WI-6554700010030460: a tree-busy DEFERRAL kept its per-file rows and is not a failure,
          // so any re-confirm resumes them; it needs no retryPrecheck opt-in.
          const deferredTreeBusy = matchingPrecheck?.status === 'deferred' &&
            matchingPrecheck.verdict?.ran === false && matchingPrecheck.verdict.reason === 'checkpoint-tree-busy';
          const resume = matchingPrecheck?.measurement && (deferredTreeBusy || (args.retryPrecheck === true &&
            (matchingPrecheck.status === 'running' ||
              (matchingPrecheck.status === 'failed' && matchingPrecheck.verdict?.ran === false &&
                matchingPrecheck.verdict.reason === 'runner-failed'))))
            ? matchingPrecheck : undefined;
          const operationId =
            resume?.operationId ??
            `${FROZEN_REPAIR_PRECHECK_RESERVATION_PREFIX}${queue.candidate.slice(0, 12)}-${builtCommit.slice(0, 12)}-` +
            `${startedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const freshOperation: FrozenRepairAdmissionPrecheck = {
            schemaVersion: 1,
            operationId,
            testEnvironment: ADMISSION_TEST_ENVIRONMENT,
            status: 'running',
            candidate: queue.candidate,
            repairHead: queue.repairHead,
            builtCommit,
            sourceCommit: outcome.entry.source.sha,
            ledgerRowIds: hunkExact?.ledgerRowIds,
            builtTree: outcome.tree,
            files: [...population.files],
            actor: identity.ownerId,
            runnerPid: process.pid,
            ...(runnerPidIdentity ? { runnerPidIdentity } : {}),
            runnerTaskId,
            startedAtMs,
            updatedAtMs: startedAtMs,
            expiresAtMs: admissionPrecheckDeadline(startedAtMs, population.files),
            // Seed the durable marker with the first file before setup begins. The runner's
            // callback refreshes this snapshot before each subsequent test process starts.
            currentFile: population.files[0] as string,
            completedCount: 0,
            totalCount: population.files.length,
            heartbeatAtMs: startedAtMs,
            // P-007 (#D-037): the managed worker rebuilds the population from `files`; the
            // partition keeps report-only radius files from becoming refusable admitted ones.
            ...(population.radius ? { radius: population.radius } : {}),
          };
          const operation: FrozenRepairAdmissionPrecheck = resume ? {
            ...resume, status: 'running', verdict: undefined, runnerPid: process.pid,
            runnerPidIdentity: runnerPidIdentity ?? undefined, runnerTaskId, updatedAtMs: startedAtMs,
            expiresAtMs: admissionPrecheckDeadline(startedAtMs,
              resume.files.filter(file => !resume.measurement!.results.some(result => result.path === file))),
            heartbeatAtMs: startedAtMs,
          } : freshOperation;
          const pendingQueue: FrozenCandidateRepairQueue = {
            ...queue,
            admissionPrecheck: operation,
            dispatchReservation: {
              token: operationId,
              claimedAtMs: startedAtMs,
              expiresAtMs: operation.expiresAtMs,
            },
            updatedAtMs: Math.max(queue.updatedAtMs + 1, startedAtMs),
          };
          try {
            await step('precheck-marker-write', () =>
              writeFrozenCandidateRepairQueue(inspected.target, pendingQueue, {
                expectedUpdatedAtMs: queue.updatedAtMs,
              }),
            );
          } catch (err) {
            return json({
              ...base,
              ok: false,
              admitted: false,
              refused: true,
              dryRun: false,
              verdict: 'refused',
              reason: 'precheck-state-conflict',
              detail:
                `The queue changed before the R6 pre-check marker could be persisted (${(err as Error).message}). ` +
                'No pre-check was launched and nothing was published; re-read op:get.',
              judgedSha: queue.repairHead,
            });
          }
          const workerInput: AdmissionPrecheckWorkerInput = {
            operationId,
            taskId: runnerTaskId,
            queueTarget: inspected.target,
            integrationRoot: precheckRoot,
            checkpointRoot: checkpointRootMirror(precheckRoot),
            ...(toolingRoot !== precheckRoot ? { toolingRoot } : {}),
            ...(testCommand?.length ? { testCommand } : {}),
            ...(precheckClearEnv.length ? { clearEnv: precheckClearEnv } : {}),
            expiresAtMs: operation.expiresAtMs,
          };
          let launchFailure: string | null = null;
          try {
            const managed = await startAdmissionPrecheckWorker(workerInput);
            if (!managed.confined) {
              launchFailure =
                `managed R6 runner was not placed in a host-independent task scope` +
                (managed.confinementSkippedReason ? ` (${managed.confinementSkippedReason})` : '');
            }
          } catch (err) {
            launchFailure = err instanceof Error ? err.message : String(err);
          }
          if (launchFailure) {
            precheck = evaluateFixPrecheck(population, {
              ran: false,
              reason: 'runner-failed',
              detail: `Could not launch host-independent managed R6 pre-check ${operationId}: ${launchFailure}`,
            });
            try {
              await settleAdmissionPrecheck(inspected.target, operationId, precheck);
            } catch (err) {
              console.error(`[release:repair-queue] failed to persist managed pre-check launch failure ${operationId}`, err);
            }
          } else {
            return json({
              ...base,
              ok: true,
              admitted: false,
              pending: true,
              dryRun: false,
              verdict: 'precheck-running',
              judgedSha: queue.repairHead,
              builtCommit,
              precheckOperation: operation,
              completionReceipt: {
                status: 'recorded',
                effectRef: `release:repair-queue:admit-precheck:${operationId}`,
              },
              currentQueueIdentity: {
                candidate: pendingQueue.candidate,
                repairHead: pendingQueue.repairHead,
                updatedAtMs: pendingQueue.updatedAtMs,
              },
              note:
                'R6 pre-check launched as a managed task after its durable marker was written. Its progress and verdict are persisted by operationId and survive serving-host replacement. NOTHING publishes in the background. Re-read op:get. If status=deferred (checkpoint-tree-busy), wait for the active checkpoint run to release the tree before requesting another pre-check; deferred is not passing evidence. After status=passed, repeat this confirmed admit with the refreshed exact queue identity' +
                (wholeBlob ? ` and wholeBlob:true, sourceCommit:'${operation.sourceCommit}'` : '') +
                '.',
            });
          }
        }
        if (!precheck.ok) {
          return json({
            ...base,
            ok: false,
            admitted: false,
            refused: true,
            dryRun: false,
            verdict: 'refused',
            reason: precheck.code,
            detail: precheck.detail,
            precheck: precheckRecordOf(precheck, { skipPrecheck, precheckReason, dryRun, population }),
            precheckResults: precheck.ran ? precheck.results : [],
            precheckRadius: population.radius ?? null,
            builtCommit,
            judgedSha: queue.repairHead,
            containment: await containmentAt(queue.repairHead),
            mode,
            note: precheck.ran
              ? 'R6: nothing was published — the admission commit was built and measured but the lineage ref did not move. ' +
                'Fix the red at the built commit (or, for a deliberate wide admission, re-run with skipPrecheck:true + precheckReason).'
              : 'R6: nothing was published — the admission commit was built, but the pre-check runner could not measure it. ' +
                'Repair the runner/setup failure, or deliberately opt out with skipPrecheck:true + precheckReason.',
          });
        }
        if (!ratchetAllowsPublication(precheck)) {
          // P-006: only a measured result (or nothing to run) publishes; a busy tree defers.
          return json({
            ...base,
            ok: false,
            admitted: false,
            refused: false,
            deferred: true,
            dryRun: false,
            verdict: 'deferred',
            reason: precheck.ran ? 'unmeasured' : precheck.reason,
            detail: precheck.ran
              ? 'the pre-check did not produce a publishable verdict'
              : 'detail' in precheck ? precheck.detail : precheck.reason,
            precheck: precheckRecordOf(precheck, { skipPrecheck, precheckReason, dryRun, population }),
            builtCommit,
            judgedSha: queue.repairHead,
            mode,
            note:
              'P-006 admission ratchet: nothing was published — the pre-check could not measure this admission ' +
              '(the checkpoint tree is busy with a gate run), and an unmeasured admission never advances the repair head. ' +
              'Repeat this confirmed admit after the active run ends; it re-measures automatically.',
          });
        }
      }
      // WI-6554700010019177: the queue write after publication carries a qualification handoff,
      // and that guard lands only while the stored transaction IS the queue's origin attempt.
      // Refuse here, before the lineage ref moves, and name the attempt. The old path published,
      // failed the row write, retracted and reported an undiagnosed persist_failed. A dry run
      // predicts the same refusal. Without an origin no handoff is written, so nothing is read.
      if (outcome.ok && queue.qualificationAttemptId) {
        const handoffBlock = frozenRepairAdmissionHandoffBlock(queue, await readStoredQualification(inspected.target));
        if (handoffBlock) {
          return json({
            ok: false,
            admitted: false,
            refused: true,
            ...(dryRun ? { dryRun: true } : {}),
            verdict: 'refused',
            reason: handoffBlock.reason,
            detail: handoffBlock.detail,
            qualification: {
              originAttemptId: handoffBlock.originAttemptId,
              transactionAttemptId: handoffBlock.transactionAttemptId,
              transactionPhase: handoffBlock.transactionPhase,
              transactionRepairHead: handoffBlock.transactionRepairHead,
            },
            builtCommit: outcome.commit,
            judgedSha: queue.repairHead,
            containment: await containmentAt(queue.repairHead),
            mode,
            ...base,
          });
        }
      }
      if (!dryRun && outcome.ok) {
        // Phase 2: publish. The durable intent predates the ref movement; the
        // linked claim row remains locked until this exact publication settles.
        const admitted = await executeWithGateActionReceipt({
          action: 'release:repair-queue', actor: identity.ownerId,
          ownerId: identity.ownerId, conditionKey: ownership?.eventKey ?? '',
          allowUnowned: true,
          delegate: { authorized: callerAuthorization.status === 'authorized-delegate',
            callerSpawnId: callerAuthorization.callerSpawnId,
            queueFixerSpawnId: callerAuthorization.queueFixerSpawnId },
          target: { op: 'admit', candidate: queue.candidate, repairHead: queue.repairHead,
            builtCommit: outcome.commit },
          run: async () => buildAdmission(false),
          summarize: (effect) => ({ status: effect.ok ? 'lineage-ref-published' : 'not-published',
            ...(effect.ok ? { commit: effect.commit } : { reason: effect.code }) }),
        });
        if (!admitted.ok) {
          stampActionEffect({ status: admitted.effectMayHaveRun ? 'unknown' : 'refused',
            reason: admitted.reason, receiptId: admitted.receiptId });
          return json({ ok: false, admitted: false, refused: !admitted.effectMayHaveRun,
            verdict: 'refused', reason: admitted.reason, receiptId: admitted.receiptId,
            effectMayHaveRun: admitted.effectMayHaveRun, ...base });
        }
        effectReceipt = { receiptId: admitted.receiptId, ownership: admitted.ownership };
        outcome = admitted.effect;
      }
      // WI-6554700010009991: a whole-blob / committed-patch admission records the ledger rows its
      // admitted blobs carry, judged against the real blob content, so a later hunk-exact admit
      // treats them as consumed. Only paths with an unconsumed row are read. Bookkeeping never
      // fails the admission: a blob that cannot be read leaves its rows unconsumed, and the
      // WI-6554700010009955 content check still catches them on the next hunk-exact admit.
      let carriedLedgerRowIds: number[] = [];
      if (outcome.ok && !hunkExact && ledgerRows.length > 0) {
        const consumed = new Set((queue.admissions ?? []).flatMap((e) => e.ledgerRowIds ?? []));
        const contentByPath = new Map<string, string | null>();
        for (const [path, blob] of Object.entries(outcome.entry.blobs)) {
          if (!blob || !ledgerRows.some((r) => r.path === path && !consumed.has(r.id))) continue;
          try {
            const cat = await runJob('carried-ledger-rows', { kind: 'git', argv: ['cat-file', 'blob', blob], cwd: root });
            if (cat.status === 0) contentByPath.set(path, cat.stdout);
          } catch {
            // Left unconsumed (see above).
          }
        }
        carriedLedgerRowIds = findCarriedLedgerRowIds({ contentByPath, ledger: ledgerRows, consumedLedgerRowIds: consumed });
      }
      const carriedRecord = carriedLedgerRowIds.length > 0 ? { ledgerRowIds: carriedLedgerRowIds } : {};
      const precheckEntry = precheckRecordOf(precheck, { skipPrecheck, precheckReason, dryRun, population });
      const hunksRecord: Record<string, { applied: number; agents: string[] }> | null = hunkExact
        ? Object.fromEntries(hunkExact.perPath.map((p) => [p.path, { applied: p.applied, agents: p.agents }]))
        : null;
      // P-002: a multi-source entry records its patches inside sources[] and leaves the
      // top-level patch/patches unset, so committed-patch validation is untouched.
      const provenance = multiSource
        ? {
            mode,
            sources: multiSource.applied,
            source: { ref: sourceRef, root },
            foreignHunksAccepted: foreign.count,
            foreignAgents: foreign.agents,
            foreignHunksByPath: foreign.byPath,
            ...carriedRecord,
          }
        : patch
        ? { mode, patch, ...(patches ? { patches } : {}), source: { ref: sourceRef, root }, ...carriedRecord }
        : hunkExact
          ? {
              mode,
              hunks: hunksRecord,
              ledgerRowIds: hunkExact.ledgerRowIds,
              hunkExact: hunkExact.perPath.map((p) => ({
                path: p.path,
                applied: p.applied,
                agents: p.agents,
                foreignHunksExcluded: p.foreignHunks,
                foreignAgents: p.foreignAgents,
                unchanged: p.unchanged,
              })),
            }
          : {
              mode,
              source: { ref: sourceRef, root },
              foreignHunksAccepted: foreign.count,
              foreignAgents: foreign.agents,
              foreignHunksByPath: foreign.byPath,
              ...carriedRecord,
            };
      if (!outcome.ok) {
        if (outcome.code === 'nothing-to-admit') {
          return json({
            ok: true,
            admitted: false,
            dryRun,
            verdict: 'already-admitted',
            detail: outcome.detail,
            judgedSha: queue.repairHead,
            containment: await containmentAt(queue.repairHead),
            ...base,
          });
        }
        // P-003 (R-3): a whole-blob admission refused for a cohort test it would drag in. When that
        // test's repair-head blob equals its blob before the commit that last changed it, replaying
        // that one commit (patchCommit) is the exact gap — propose it, ready to confirm. Routing is
        // advisory: its own failure never changes the refusal.
        let patchRouting: Record<string, unknown> | undefined;
        const draggedTests = outcome.code === 'admission-incomplete' && (mode === 'whole-blob' || mode === 'multi-source')
          ? [...new Set((outcome.missing ?? []).map((m) => m.wanted).filter(isCohortTestPath))]
          : [];
        if (draggedTests.length > 0) {
          const identity = {
            expectedCandidate: queue.candidate,
            expectedRepairHead: queue.repairHead,
            expectedUpdatedAtMs: queue.updatedAtMs,
          };
          try {
            const routing = await runJob('cohort-drag-route', {
              kind: 'cohort-drag-route',
              input: { root, repairHead: queue.repairHead, integrationRef: branch, paths: draggedTests },
            });
            if (!routing.ok) {
              patchRouting = { error: { step: routing.step, detail: routing.detail } };
            } else {
              const replay = (r: { path: string; patchCommit: string }) =>
                `cohort-drag: replay ${r.patchCommit.slice(0, 12)}'s change to ${r.path} (repair-head blob = pre-fix blob)`;
              const routed = routing.routed.map((r) => {
                const admit = { op: 'admit' as const, paths: [r.path], patchCommit: r.patchCommit, reason: replay(r), ...identity };
                return { ...r, admit, confirm: { ...admit, confirm: true } };
              });
              const missingPaths = new Set((outcome.missing ?? []).map((m) => m.wanted));
              const allRouted = routed.length > 0 && [...missingPaths].every((p) => routed.some((r) => r.path === p));
              const original = multiSourceArgs !== undefined
                ? [...multiSourceArgs]
                : [{ paths, wholeBlob: true as const, ...(effectiveSourceCommit !== undefined ? { sourceCommit: effectiveSourceCommit } : {}) }];
              const combined = allRouted
                ? {
                    op: 'admit' as const,
                    sources: [...original, ...routed.map((r) => ({ paths: [r.path], patchCommit: r.patchCommit }))],
                    reason: `${effectiveReason ?? ''}; ${routed.map(replay).join('; ')}`.replace(/^; /, ''),
                    ...identity,
                  }
                : undefined;
              patchRouting = {
                routed,
                unrouted: routing.unrouted,
                ...(combined ? { combined, combinedConfirm: { ...combined, confirm: true } } : {}),
                note: combined
                  ? 'Every missing path is a cohort test whose repair-head blob equals its pre-fix blob: `combined` is this ' +
                    'admission plus each test replayed by its own commit, as one commit. Preview it, check proof.diff, then send ' +
                    '`combinedConfirm`. Each replay diffs only that commit\'s change to that one file.'
                  : 'Each `routed` test can be replayed by its own commit (`admit` to preview, `confirm` to publish); `unrouted` ' +
                    'tests changed again after the repair head (or have no single-parent commit) and must be admitted as written.',
              };
            }
          } catch (err) {
            patchRouting = { error: { step: 'cohort-drag-route', detail: err instanceof Error ? err.message : String(err) } };
          }
        }
        return json({
          ok: false,
          admitted: false,
          refused: true,
          dryRun,
          verdict: 'refused',
          reason: outcome.code,
          ...(patchRouting ? { patchRouting } : {}),
          detail: outcome.detail,
          ...(outcome.stray ? { stray: outcome.stray } : {}),
          ...(outcome.paths ? { invalidPaths: outcome.paths } : {}),
          ...(outcome.step ? { step: outcome.step } : {}),
          ...(outcome.missing
            ? {
                missing: outcome.missing,
                // The same admission, widened by exactly the missing paths — and nothing else.
                admitCommand: renderAdmitCommand([...new Set([...paths, ...outcome.missing.map((m) => m.wanted)])]),
                note:
                  'P-004: an admitted file imports a path that does not exist at the proved commit. The tip is never ' +
                  'widened for you — re-run admitCommand (your hunks for the added paths must be in the edit ledger, ' +
                  'i.e. you authored them on staging).',
              }
            : {}),
          judgedSha: queue.repairHead,
          containment: await containmentAt(queue.repairHead),
          ...base,
        });
      }
      // The ledger entry carries HOW the source was built (D-008): hunk-exact with the replayed
      // hunks per path, or whole-blob with the foreign hunks it accepted and why. Whole-blob and
      // committed-patch entries also name the ledger rows their blobs carry (WI-6554700010009991).
      const entry: FrozenRepairAdmission = {
        ...outcome.entry,
        mode,
        precheck: precheckEntry,
        ...(multiSource
          ? { sources: multiSource.applied, foreignHunksAccepted: foreign.count, foreignAgents: foreign.agents, ...carriedRecord }
          : patch
          ? { patch, ...(patches ? { patches } : {}), ...carriedRecord }
          : hunksRecord
            ? { hunks: hunksRecord, ledgerRowIds: hunkExact?.ledgerRowIds }
            : { foreignHunksAccepted: foreign.count, foreignAgents: foreign.agents, ...carriedRecord }),
      };
      const proof = {
        diff: outcome.diff,
        unchanged: outcome.unchanged,
        blobs: outcome.entry.blobs,
        tree: outcome.tree,
      };
      if (dryRun) {
        return json({
          ok: true,
          admitted: false,
          dryRun: true,
          verdict: 'would-admit',
          judgedSha: queue.repairHead,
          wouldMoveRepairHead: { from: queue.repairHead, to: outcome.commit },
          lineageRef: outcome.lineageRef,
          proof,
          precheck: precheckEntry,
          ...(!skipPrecheck ? {
            populationSize: population.files.length,
            populationBound: ADMISSION_PRECHECK_MAX_FILES,
            populationOverBound: population.files.length > ADMISSION_PRECHECK_MAX_FILES,
            executionGroupSize: Math.min(ADMISSION_RADIUS_CAP, ADMISSION_PRECHECK_MAX_FILES),
            executionGroups: Math.ceil(population.files.length / Math.min(ADMISSION_RADIUS_CAP, ADMISSION_PRECHECK_MAX_FILES)),
          } : {}),
          ...(dependencyGeneration ? { dependencyGeneration } : {}),
          containment: await containmentAt(queue.repairHead),
          note:
            `Pass confirm:true to publish admission ${outcome.commit.slice(0, 12)} onto ${outcome.lineageRef} ` +
            'and advance repairHead to it (phase ready-to-verify). The immutable candidate is never touched; ' +
            'the commit carries exactly proof.diff and nothing else from the tip.' +
            (!skipPrecheck && population.files.length > ADMISSION_PRECHECK_MAX_FILES
              ? ` The complete ${population.files.length}-file population will run in resumable groups of at most ` +
                `${Math.min(ADMISSION_RADIUS_CAP, ADMISSION_PRECHECK_MAX_FILES)} files under the unchanged ${ADMISSION_PRECHECK_MAX_FILES}-file execution bound.`
              : '') +
            (dependencyGeneration?.verdict === 'refused'
              ? ` ⚠ A confirmed admit will be REFUSED (dependency-generation-unbuildable):${dependencyNote ?? ''}`
              : (dependencyNote ?? '')),
          ...base,
          ...provenance,
        });
      }
      // Published: the lineage ref now points at the admission. The queue row is the second
      // store; if its write is ambiguous, reconcile a fresh row before deciding whether a
      // compensating ref update is safe.
      let next: FrozenCandidateRepairQueue;
      try {
        next = markFrozenRepairAdmitted(queue, entry);
      } catch (err) {
        const retracted = await runAdmissionJob({
          kind: 'retract',
          input: { root, candidate: queue.candidate, published: outcome.commit, previousRepairHead: queue.repairHead },
        });
        return json({
          ok: false,
          admitted: false,
          refused: true,
          verdict: 'refused',
          reason: 'lineage-ref-moved',
          detail: `${(err as Error).message}${retracted ? ' (lineage ref retracted)' : ' (lineage ref could NOT be retracted — it is at the unrecorded admission; re-read the queue)'}`,
          judgedSha: queue.repairHead,
          containment: await containmentAt(queue.repairHead),
          ...base,
        });
      }
      let persisted = true;
      // WI-10006866: a missed write is NOT "nothing moved". Any repair-queue read in the window
      // since the ref moved reconciles the row from that ref, so the CAS can miss because the
      // admission IS already recorded. Retracting then leaves the row ahead of the ref. Settle
      // against the FRESH row first; retract only when it proves the row is still at the parent.
      let persistError: string | null = null;
      let persistSettlement: string | null = null;
      let settlementFresh: FrozenCandidateRepairQueue | null | undefined;
      try {
        if (expectedQueueIdentity) {
          await writeFrozenCandidateRepairQueue(inspected.target, next, {
            expectedUpdatedAtMs: expectedQueueIdentity.expectedUpdatedAtMs,
          });
        } else {
          await writeFrozenCandidateRepairQueue(inspected.target, next, {
            expectedUpdatedAtMs: queue.updatedAtMs,
          });
        }
      } catch (writeErr) {
        persistError = writeErr instanceof Error ? writeErr.message : String(writeErr);
        const settle: { kind: string; detail: string | null } = { kind: 'diverged', detail: null };
        try {
          const settled = await applyFrozenCandidateRepairQueueTransition(inspected.target, (fresh) => {
            const s = settleFrozenRepairAdmission(fresh, entry);
            settle.kind = s.kind;
            settle.detail = s.kind === 'diverged' ? s.detail : null;
            return s.queue ?? fresh;
          });
          settlementFresh = settled.fresh;
          persisted = settled.status !== 'absent' && settle.kind !== 'diverged';
          if (persisted && settled.queue) next = settled.queue;
          persistSettlement = settled.status === 'absent'
            ? 'queue-absent'
            : `${settle.kind}${settle.detail ? `: ${settle.detail}` : ''}`;
        } catch (settleErr) {
          persisted = false;
          persistSettlement = `settle-failed: ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`;
        }
      }
      let retracted: boolean | null = null;
      let retractionProof: AdmissionRetractionProof | null = null;
      let retractionDetail: string | null = null;
      if (!persisted) {
        const decision = await settleFailedAdmissionRef(
          inspected.target,
          root,
          queue.candidate,
          outcome.commit,
          queue.repairHead,
          settlementFresh,
        );
        retractionProof = decision.proof;
        retractionDetail = decision.detail;
        retracted = decision.retracted;
        if (decision.persisted) {
          persisted = true;
          if (decision.fresh) next = decision.fresh;
        }
      }
      if (persistError !== null) {
        console.warn(
          `[repair-queue] admit ${outcome.commit.slice(0, 12)}: queue-row write failed (${persistError}); ` +
            `settled against the fresh row as ${persistSettlement} → persisted=${persisted}` +
            (retractionProof ? `; retraction ${retractionProof}: ${retractionDetail}` : ''),
        );
      }
      const auditRecorded = await recordAudit(identity.ownerId, {
        op: 'admit',
        reason: effectiveReason ?? null,
        workItem: args.workItem ?? null,
        candidate: queue.candidate,
        from: queue.repairHead,
        to: outcome.commit,
        source: outcome.entry.source,
        paths: outcome.entry.paths,
        unchanged: outcome.entry.unchanged,
        precheckRadius: population.radius ?? null,
        mode,
        ...(multiSource
          ? { sources: multiSource.applied, foreignHunksAccepted: foreign.count, foreignAgents: foreign.agents, ...carriedRecord }
          : patch
          ? { patch, ...(patches ? { patches } : {}), ...carriedRecord }
          : hunksRecord
            ? { hunks: hunksRecord, ledgerRowIds: hunkExact?.ledgerRowIds }
            : { foreignHunksAccepted: foreign.count, foreignAgents: foreign.agents, ...carriedRecord }),
        precheck: precheckEntry,
        ...(dependencyGeneration ? { dependencyGeneration } : {}),
        persisted,
        ...(persistError ? { persistError, persistSettlement } : {}),
        ...(retracted === null ? {} : { retracted }),
        ...(retractionProof ? { retractionProof, retractionDetail } : {}),
      });
      const judgedSha = persisted ? outcome.commit : queue.repairHead;
      stampActionEffect({ status: persisted ? 'repair-head-published' : 'publish-failed',
        persisted, retracted, from: queue.repairHead, to: outcome.commit, auditRecorded });
      // D-131: a persisted admit schedules a debounced, durable verify of the head it published.
      // Never throws; a scheduling failure falls back to the D-127 manual path and is reported.
      const autoVerify = persisted
        ? await scheduleRepairAutoVerify({
            candidate: queue.candidate,
            repairHead: outcome.commit,
            admittedAtMs: Date.now(),
            ...(queueTarget.installSlug !== operatorHomeHarnessSlug() ? { target: queueTarget } : {}),
          })
        : null;
      return json({
        ok: persisted,
        admitted: persisted,
        dryRun: false,
        verdict: persisted ? 'admitted' : 'refused',
        judgedSha,
        movedRepairHead: { from: queue.repairHead, to: outcome.commit },
        lineageRef: outcome.lineageRef,
        proof,
        admission: entry,
        ...provenance,
        precheck: precheckEntry,
        precheckRadius: population.radius ?? null,
        ...(dependencyGeneration ? { dependencyGeneration } : {}),
        containment: await containmentAt(judgedSha),
        persisted,
        auditRecorded,
        ...base,
        ...(persisted && effectReceipt
          ? { completionReceipt: {
              status: 'recorded',
              effectRef: `release:repair-queue:admit:${effectReceipt.receiptId}`,
            } }
          : {}),
        ...(patch || multiSource ? { source: { ref: sourceRef, root } } : {}),
        repairQueue: persisted
          ? diagnoseFrozenCandidateRepairQueue(next, { nowMs: Date.now(), fixerAlive: inspected.fixerAlive })
          : inspected.diagnostic,
        ...(autoVerify ? { autoVerify } : {}),
        ...(persisted
          ? {
              nextAction:
                `repairHead is ${outcome.commit.slice(0, 12)} (phase ${next.phase}). ` +
                (autoVerify?.scheduled
                  ? `An auto-verify of that head is scheduled after a ${Math.round(autoVerify.quietMs / 60_000)}-min quiet window (D-131); a further admit restarts the window. ` +
                    'Do NOT fire release:checkpoint-run unless you mean to skip the window, and do NOT retire.'
                  : `Auto-verify was NOT scheduled (${autoVerify && !autoVerify.scheduled ? autoVerify.reason : 'unknown'}); ` +
                    'the gate re-verifies at that head on its next tick. Do NOT fire release:checkpoint-run until your batch is complete (D-127), and do NOT retire.') +
                (precheckEntry.ran
                  ? ` R6 pre-check ran at the built commit: ${precheckEntry.fixes?.length ?? 0} signature red(s) fixed, ${precheckEntry.failing?.length ?? 0} still failing, ${precheckEntry.unmeasured?.length ?? 0} unmeasured.`
                  : precheckEntry.reason === 'checkpoint-tree-busy'
                    ? ' ⚠ R6 pre-check did NOT run (a gate run holds the checkpoint tree) — accepted loud; the re-judge measures it.'
                    : precheckEntry.reason === 'skipped'
                      ? ' ⚠ R6 pre-check SKIPPED by the caller (skipPrecheck); the re-judge measures it.'
                      : '') +
                (dependencyGeneration?.verdict === 'refused'
                  ? ` ⚠ Admitted PAST an unbuildable-dependency prediction (skipPrecheck):${dependencyNote ?? ''} Verification will park until a matching generation exists.`
                  : (dependencyNote ?? '')),
            }
          : {
              refused: true,
              reason: 'persist_failed',
              note:
                retractionProof === 'recorded'
                  ? 'The fresh queue row already records this admission; the published lineage ref was preserved. Re-read op:get before relying on the judged sha.'
                  : retractionProof === 'parent' && retracted === true
                    ? 'The fresh queue row proved it was still at the admission parent, so the lineage ref was retracted; nothing moved. Re-run.'
                    : retractionProof === 'parent'
                      ? 'The fresh queue row proved it was still at the admission parent, but the lineage ref could not be retracted. Re-read the queue and ref before relying on the judged sha.'
                      : retractionProof === 'head-moved'
                        ? 'The fresh queue row had moved away from the admission parent, so the lineage ref was preserved. Re-read the queue and ref before relying on the judged sha.'
                        : retractionProof === 'unknown'
                          ? 'The queue-row write and its fresh re-read were inconclusive, so the lineage ref was preserved. Re-read the queue and ref before relying on the judged sha.'
                          : 'The queue row could not be written and the lineage ref was not compensated. Re-read the queue and ref before relying on the judged sha.',
            }),
        ...(persistError ? { persistError, persistSettlement } : {}),
        ...(retractionProof ? { retractionProof, retractionDetail } : {}),
      });
    }
    if (args.op === 'claim-leg') {
      // P-021 (D-007 #1): claiming a leg claims its paths. The manifest row is the unit a
      // fixer takes; the claim is carried on the queue row (the ONE write path re-derives
      // the manifest with `previous` so a claim survives every rebuild), and the caller's
      // presence `current_files` is set to the leg's subject paths so lock contention and
      // fleet placement see the lane without a separate declare-intent.
      const queue = inspected.queue;
      const legId = args.leg.trim();
      const release = args.release === true;
      const base = {
        op: 'claim-leg' as const,
        leg: legId,
        release,
        target: inspected.target,
        repairQueue: inspected.diagnostic,
        repairQueueRead: compactRead,
        callerAuthorization,
      };
      if (!queue) {
        return json({
          ok: true,
          claimed: false,
          verdict: 'no-frozen-queue',
          nextAction:
            'No frozen repair queue, so there is no manifest and nothing to claim. Fix on staging as normal; ' +
            'git-sync commits it and the next candidate is cut from that tip. Do not fire release:checkpoint-run.',
          ...base,
        });
      }
      if (
        ctx.role !== 'su' &&
        !isOperatorConfigWriteRole(ctx.role) &&
        ctx.isSuperuser !== true &&
        callerAuthorization.authorized !== true
      ) {
        throw new Error(
          'release:repair-queue claim-leg requires an operator-config write role, su, or the exact signed release-fixer delegated by this queue',
        );
      }
      if (!queue.manifest) {
        return json({
          ok: false,
          claimed: false,
          refused: true,
          verdict: 'refused',
          reason: 'no-manifest',
          detail:
            'The frozen queue carries no repair manifest yet: the gate derives it on its next queue write ' +
            '(a freeze, an admission, a re-verify). Re-read with op:get after the next green-checkpoint tick.',
          ...base,
        });
      }
      const identity = readIdentity(ctx);
      const outcome = claimRepairManifestLeg(queue.manifest, {
        legId,
        actor: identity.ownerId,
        atMs: Date.now(),
        release,
      });
      if (!outcome.ok) {
        return json({
          ok: false,
          claimed: false,
          refused: true,
          verdict: 'refused',
          reason: outcome.reason,
          ...(outcome.reason === 'no-such-leg'
            ? {
                legIds: outcome.legIds,
                detail: `No manifest leg ${JSON.stringify(legId)}; the manifest names ${outcome.legIds.length} leg(s) — copy a legId from repairQueue.manifest.rows[].`,
              }
            : outcome.reason === 'held-by-other'
              ? {
                  row: outcome.row,
                  holder: outcome.holder,
                  detail: `Leg ${legId} is held by ${outcome.holder.actor} — coordinate with the holder (coord:send), never contest a live claim.`,
                }
              : {
                  row: outcome.row,
                  detail: `Leg ${legId} is already ${outcome.row.statusLabel}; there is nothing left to claim on it.`,
                }),
          ...base,
        });
      }
      const next: FrozenCandidateRepairQueue = { ...queue, manifest: outcome.manifest };
      const claimed = await executeWithGateActionReceipt({
        action: 'release:repair-queue', actor: identity.ownerId, ownerId: identity.ownerId,
        conditionKey: ownership?.eventKey ?? '', allowUnowned: true,
        delegate: { authorized: callerAuthorization.status === 'authorized-delegate',
          callerSpawnId: callerAuthorization.callerSpawnId,
          queueFixerSpawnId: callerAuthorization.queueFixerSpawnId },
        target: { op: 'claim-leg', candidate: queue.candidate, repairHead: queue.repairHead,
          leg: legId, release },
        run: async () => {
          try {
            await writeFrozenCandidateRepairQueue(inspected.target, next, {
              expectedUpdatedAtMs: queue.updatedAtMs,
            });
            return { persisted: true };
          } catch {
            return { persisted: false };
          }
        },
        summarize: (effect) => ({ status: effect.persisted
          ? (release ? 'leg-released' : 'leg-claimed') : 'persist-failed', persisted: effect.persisted }),
      });
      if (!claimed.ok) {
        stampActionEffect({ status: claimed.effectMayHaveRun ? 'unknown' : 'refused',
          reason: claimed.reason, receiptId: claimed.receiptId });
        return json({ ...base, ok: false, claimed: false, refused: !claimed.effectMayHaveRun,
          reason: claimed.reason, receiptId: claimed.receiptId,
          effectMayHaveRun: claimed.effectMayHaveRun });
      }
      effectReceipt = { receiptId: claimed.receiptId, ownership: claimed.ownership };
      const persisted = claimed.effect.persisted;
      // Claiming a leg claims its paths: publish them as the caller's current files. Best-effort —
      // the claim itself is on the queue row; presence is the peer-visible mirror of it.
      let presenceFiles: string[] | null = null;
      if (persisted && !outcome.released && outcome.paths.length > 0) {
        try {
          const [{ resolveAgentIdentity }, { writePresence }] = await Promise.all([
            import('../coordination/identity'),
            import('../coordination/presence'),
          ]);
          await writePresence(resolveAgentIdentity(ctx), { currentFiles: outcome.paths });
          presenceFiles = outcome.paths;
        } catch {
          presenceFiles = null;
        }
      }
      const auditRecorded = await recordAudit(identity.ownerId, {
        op: 'claim-leg',
        leg: legId,
        release,
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        paths: outcome.paths,
        persisted,
      });
      const released = release && persisted;
      stampActionEffect({ status: persisted ? (release ? 'leg-released' : 'leg-claimed') : 'persist-failed',
        persisted, leg: legId, auditRecorded });
      return json({
        ok: persisted,
        claimed: persisted && !release,
        released,
        verdict: persisted ? (release ? 'released' : 'claimed') : 'refused',
        row: outcome.row,
        paths: outcome.paths,
        admitCommand: outcome.row.admitCommand,
        presenceFiles,
        persisted,
        auditRecorded,
        ...base,
        ...(persisted && effectReceipt
          ? { completionReceipt: {
              status: 'recorded',
              effectRef: `release:repair-queue:claim-leg:${effectReceipt.receiptId}`,
            } }
          : {}),
        repairQueue: persisted
          ? diagnoseFrozenCandidateRepairQueue(next, { nowMs: Date.now(), fixerAlive: inspected.fixerAlive })
          : inspected.diagnostic,
        ...(persisted
          ? {
              nextAction: release
                ? `Leg ${legId} released; its ${outcome.paths.length} subject path(s) are unclaimed again.`
                : outcome.row.admitCommand
                  ? `You hold leg ${legId} (${outcome.row.statusLabel}). Fix its subject paths on staging, wait for git-sync to commit, then land it with: ${outcome.row.admitCommand}. Do NOT fire release:checkpoint-run.`
                  : `You hold leg ${legId} (${outcome.row.statusLabel}) but its subject paths are unknown — name the files you fix by hand in release:repair-queue { op:'admit', paths:[…] }. Do NOT fire release:checkpoint-run.`,
            }
          : {
              refused: true,
              reason: 'persist_failed',
              note: 'The queue row could not be written; the claim is not recorded. Re-read the queue and retry.',
            }),
      });
    }
    if (ctx.role !== 'su' && !isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('release:repair-queue retire requires an operator-config write role or su authority');
    }
    if (!inspected.queue || !inspected.diagnostic) {
      return json({ ok: true, op: 'retire', retired: false, alreadyClear: true, target: inspected.target });
    }
    const identityMatches =
      inspected.queue.candidate === args.expectedCandidate &&
      inspected.queue.repairHead === args.expectedRepairHead &&
      inspected.queue.updatedAtMs === args.expectedUpdatedAtMs;
    if (!identityMatches) {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: 'exact_queue_identity_mismatch',
        target: inspected.target,
        repairQueue: inspected.diagnostic,
      });
    }
    // A broad liveness read can fail-soft to `null` while the exact terminal pair is still
    // durable. Let the transaction-scoped retire helper recheck that case; keep the other safety
    // refusals (live fixer, active reservation, unsafe phase) fail-closed at the read boundary.
    if (!inspected.diagnostic.retireAllowed && inspected.diagnostic.retireRefusal !== 'liveness-unknown') {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: inspected.diagnostic.retireRefusal,
        target: inspected.target,
        repairQueue: inspected.diagnostic,
      });
    }
    if (args.confirm !== true) {
      return json({
        ok: true,
        op: 'retire',
        dryRun: true,
        retired: false,
        target: inspected.target,
        repairQueue: inspected.diagnostic,
        note:
          'Pass confirm:true with the same exact identity AND directiveRef (an open owner-typed ' +
          'directive addressed to you) to execute the compare-and-swap retirement.',
      });
    }

    const identity = readIdentity(ctx);
    // WI-6554700010042419 (owner #2557; earlier WI-1105109): retiring a frozen queue throws away a
    // converging repair lineage, which defeats the purpose of freeze-and-converge. That call is the
    // owner's. So the retire must cite an owner-typed directive addressed to this caller, checked
    // on the owner's own captured turn, the same rule as an owner-authorized force claim.
    const ownerDirective =
      args.directiveRef == null
        ? ({ ok: false, reason: 'no directiveRef was given' } as const)
        : await verifyOwnerForceDirective({
            directiveId: args.directiveRef,
            callerOwnerId: identity.ownerId,
            workspaceId: inspected.target.workspaceId,
          });
    if (!ownerDirective.ok) {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: 'owner-directive-required',
        detail:
          `Only the owner retires a frozen repair queue: ${ownerDirective.reason}. Pass directiveRef, ` +
          'the id of an open directive the owner typed to you asking for this retirement. Without ' +
          'one, keep converging: admit fixes with op:"admit".',
        target: inspected.target,
        repairQueue: inspected.diagnostic,
      });
    }
    const retired = await executeWithGateActionReceipt({
      action: 'release:repair-queue', actor: identity.ownerId, ownerId: identity.ownerId,
      conditionKey: ownership?.eventKey ?? '', allowUnowned: true,
      target: { op: 'retire', candidate: inspected.queue.candidate,
        repairHead: inspected.queue.repairHead, updatedAtMs: inspected.queue.updatedAtMs },
      run: () => retireFrozenCandidateRepairQueue(inspected.target, inspected.queue!),
      summarize: (effect) => ({ status: effect.retired ? 'queue-retired' : 'not-retired',
        refusal: effect.refusal ?? null }),
    });
    if (!retired.ok) {
      stampActionEffect({ status: retired.effectMayHaveRun ? 'unknown' : 'refused',
        reason: retired.reason, receiptId: retired.receiptId });
      return json({ ok: false, op: 'retire', retired: false,
        refused: !retired.effectMayHaveRun, reason: retired.reason,
        receiptId: retired.receiptId, effectMayHaveRun: retired.effectMayHaveRun });
    }
    effectReceipt = { receiptId: retired.receiptId, ownership: retired.ownership };
    const result = retired.effect;
    const currentFixerAlive =
      result.fixerAlive !== undefined ? result.fixerAlive : await inspectFixerLiveness(result.current);
    const currentDiagnostic = result.current
      ? diagnoseFrozenCandidateRepairQueue(result.current, {
          nowMs: Date.now(),
          fixerAlive: currentFixerAlive,
        })
      : null;
    // The transaction may refuse after taking the routine-row lock because its authoritative
    // liveness/identity differs from the preflight read. This is a safety refusal, not a storage
    // CAS miss, and must remain visible as such so callers do not retry a live/unknown fixer.
    if (!result.retired && result.refusal && result.refusal !== 'identity-mismatch') {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: result.refusal,
        target: inspected.target,
        repairQueue: currentDiagnostic,
      });
    }
    if (!result.retired && result.refusal === 'identity-mismatch') {
      return json({
        ok: false,
        op: 'retire',
        retired: false,
        refused: true,
        reason: 'exact_queue_identity_mismatch',
        target: inspected.target,
        repairQueue: currentDiagnostic,
      });
    }
    const casMiss = !result.retired;
    const auditRecorded = await recordAudit(identity.ownerId, {
      reason: args.reason,
      expectedCandidate: args.expectedCandidate,
      expectedRepairHead: args.expectedRepairHead,
      expectedUpdatedAtMs: args.expectedUpdatedAtMs,
      retired: result.retired,
      casMiss,
    });
    const inconclusiveTerminal =
      result.retired && frozenRepairHeadAwaitsVerification(inspected.queue)
        ? await emitRetiredUnjudgedRepairHeadTerminal(inspected.queue, inspected.target.installSlug)
        : undefined;
    stampActionEffect({ status: result.retired ? 'queue-retired' : 'cas-miss',
      retired: result.retired, casMiss, auditRecorded });
    // A CAS miss is a storage outcome, not a liveness refusal. The nested `current`
    // diagnostic describes the row after the failed write; it must not become the
    // operation's headline reason.
    return json({
      ok: result.retired,
      op: 'retire',
      retired: result.retired,
      casMiss,
      reason: casMiss ? 'cas-miss' : undefined,
      target: inspected.target,
      auditRecorded,
      ...(result.retired && effectReceipt
        ? { completionReceipt: {
            status: 'recorded',
            effectRef: `release:repair-queue:retire:${effectReceipt.receiptId}`,
          } }
        : {}),
      current: currentDiagnostic,
      ...(inconclusiveTerminal ? { inconclusiveTerminal } : {}),
      // WI-1105109 [owner 2026-08-30, OWNER-interactive]: "make sure another agent
      // uses the frozen candidate system next and doesn't retire it like you did".
      //
      // A SUCCESSFUL retire is the exact moment the treadmill restarts. The recorded
      // failure was not the retire — that one was correct — it was firing
      // release:checkpoint-run TWICE immediately afterwards, each cutting a FRESH
      // candidate at tip. `notWhen` already forbids retiring "merely to make the gate
      // move", but guidance is read BEFORE the call and the mistake happens AFTER it,
      // so the answer has to travel on the RESULT the caller is holding when they
      // choose their next move.
      nextStep: result.retired
        ? 'The next scheduled green-checkpoint run RE-FREEZES a candidate on its own — retiring does not stall the gate, so nothing needs firing to restart it. Do NOT call release:checkpoint-run to make the gate move: it always cuts a FRESH candidate at the current tip, which is the pre-D-001 re-cut-at-tip treadmill D-007 diagnosed (each cut re-admits the whole sweep and imports breakage faster than fixes land). To land a fix on the judged lineage, use release:repair-queue { op: "admit", paths: [...] }.'
        : undefined,
    });
    } catch (err) {
      if (args.op === 'admit' && args.confirm !== true && err instanceof AdmissionOffthreadTimeoutError) {
        return json({
          ok: false,
          op: 'admit',
          admitted: false,
          refused: true,
          dryRun: true,
          verdict: 'timeout',
          reason: 'admission-preview-timeout',
          mode: args.sources !== undefined ? 'multi-source'
            : args.patchCommit !== undefined || args.patchCommits !== undefined ? 'committed-patch'
            : args.wholeBlob === true ? 'whole-blob' : 'hunk-exact',
          timedOutStep: err.stepName ?? err.jobKind,
          timeoutMs: err.timeoutMs,
          detail:
            `The read-only preview exceeded ${err.timeoutMs}ms in ${err.stepName ?? err.jobKind}. ` +
            'The admission worker is being stopped; no lineage ref or repair-queue row was written. ' +
            'Retry with a smaller path set or investigate the named step.',
          timings: clock?.summary() ?? null,
        });
      }
      if (args.op === 'admit' && args.confirm !== true && err instanceof AdmissionOffthreadTimeoutUnavailableError) {
        return json({
          ok: false,
          op: 'admit',
          admitted: false,
          refused: true,
          dryRun: true,
          verdict: 'refused',
          reason: 'admission-preview-timeout-unavailable',
          mode: args.sources !== undefined ? 'multi-source'
            : args.patchCommit !== undefined || args.patchCommits !== undefined ? 'committed-patch'
            : args.wholeBlob === true ? 'whole-blob' : 'hunk-exact',
          detail: err.message,
          timings: clock?.summary() ?? null,
        });
      }
      throw err;
    }
    };
    // R-1: a dry run that outlasts the inline budget returns a preview handle and keeps running.
    if ((args.op === 'admit' || args.op === 'converge') && args.confirm !== true) {
      return runDeferrableAdmissionPreview(args.paths, queueTarget, core);
    }
    return core();
  },
});

/** Test seam: the admission-preview store the tool uses (default: the routine-metadata PG store). */
let admissionPreviewStoreFactory: (target: GateVerdictTarget) => AdmissionPreviewStore =
  createRoutineMetadataAdmissionPreviewStore;
let admissionPreviewEmitter: typeof emitAdmissionPreviewSettled = emitAdmissionPreviewSettled;
let admissionPreviewInlineBudgetMs = ADMISSION_PREVIEW_INLINE_BUDGET_MS;

export function __setAdmissionPreviewDepsForTests(deps: {
  store?: (target: GateVerdictTarget) => AdmissionPreviewStore;
  emit?: typeof emitAdmissionPreviewSettled;
  inlineBudgetMs?: number;
} | null): void {
  admissionPreviewStoreFactory = deps?.store ?? createRoutineMetadataAdmissionPreviewStore;
  admissionPreviewEmitter = deps?.emit ?? emitAdmissionPreviewSettled;
  admissionPreviewInlineBudgetMs = deps?.inlineBudgetMs ?? ADMISSION_PREVIEW_INLINE_BUDGET_MS;
}

function admissionPreviewStoreFor(queueTarget: GateVerdictTarget): AdmissionPreviewStore {
  return admissionPreviewStoreFactory(queueTarget);
}

async function runDeferrableAdmissionPreview<T extends { data?: unknown }>(
  paths: readonly string[],
  queueTarget: GateVerdictTarget,
  run: () => Promise<T>,
): Promise<T | { data: unknown }> {
  const outcome = await runAdmissionPreviewOperation({
    run,
    store: admissionPreviewStoreFor(queueTarget),
    emitSettled: (operation) => admissionPreviewEmitter(operation, queueTarget.workspaceId),
    paths,
    inlineBudgetMs: admissionPreviewInlineBudgetMs,
    toVerdict: (result) => result.data ?? null,
  });
  if (outcome.mode === 'inline') return outcome.result;
  return json(deferredAdmissionPreviewPayload(outcome, admissionPreviewInlineBudgetMs));
}

async function readAdmissionPreview(
  store: AdmissionPreviewStore,
  operationId: string,
  currentRepairHead: string | null,
): Promise<Record<string, unknown>> {
  let operation;
  try {
    operation = await store.get(operationId);
  } catch (error) {
    return {
      operationId,
      status: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!operation) {
    return {
      operationId,
      status: 'unknown-operation',
      detail: 'No preview operation with this id is stored (unknown id, or pruned after newer previews). Re-run the dry run.',
    };
  }
  const read = describeAdmissionPreviewOperation(operation, { nowMs: Date.now(), currentRepairHead });
  return {
    operationId,
    status: read.status,
    judgedSha: read.judgedSha,
    stale: read.stale,
    nextAction: read.nextAction,
    startedAtMs: operation.startedAtMs,
    settledAtMs: operation.settledAtMs,
    expiresAtMs: operation.expiresAtMs,
    paths: operation.paths,
    verdictTruncated: operation.verdictTruncated,
    ...(operation.error ? { error: operation.error } : {}),
    verdict: operation.verdict,
  };
}
