/**
 * P-013 (goal-mode-design-intent-hardening-2026-08-16, D-004): grade-the-grader.
 * The plan-ship verification pattern (audit + rubric grade, grader ≠ author) extends
 * to GRADE mode itself: a TERMINAL scorecard against a standard rubric stays
 * audit-pending until a NON-AUTHOR auditor grades the grading against the
 * grading-integrity meta-rubric. Three D-004 bounds, enforced structurally here:
 *   1. ONE level — the audit card itself (rubricRef === GRADING_INTEGRITY_RUBRIC_REF)
 *      is never stamped pending, so nobody grades the auditor.
 *   2. TERMINAL cards only — a provisional card is already excluded as a working
 *      note; stamping it too would double-bucket (see needsGradingAudit).
 *   3. Sampled evidence re-runs are the AUDIT's method (rubric criteria), not a
 *      code path here.
 */

import { createHash } from 'node:crypto';
import { nativeTranscriptProofFromLaunchReceipt, type NativeTranscriptLaunchReceipt } from './native-session-handles';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_SCRIPT_TIMEOUT_MS } from '@papercusp/tooldef';
import { observeFallback } from './degradation/fallback-observations';
import launchAgentTool, { INTERNAL_GRADING_AUDIT_TASK_DETAIL } from './agent-tools/capability/launch-agent';
import { advSessionsByTranscriptHandles, type AdvSessionRow } from './adv-sessions';
import { getBuildInfo, type BuildInfo } from './build-info';
import { findSessionTranscript } from './claude-sessions';
import { findCodexRolloutPathByUuid } from './session-transcript-resolvers';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import {
  classifyAcceptanceGraderNoFirstTurnStall,
  isAcceptanceGraderNoFirstTurnLivenessCandidate,
  classifyAcceptanceGraderParkedWithoutEmit,
  detectAcceptanceGraderTerminalFailure,
  readAcceptanceGraderLogMtimeMs,
  readAcceptanceGraderLogTail,
  gradingLaunchProfile,
  withGradingLaunchProfile,
  type GradingLaunchProfile,
  type AcceptanceGraderTerminalFailureCode,
} from './acceptance-grader';
import { getRubric } from './rubrics';
import {
  acquireGradingAuditSubjectMutex,
  cancelSupersededPendingGradingAuditAtomically,
  cancelStaleEvidencePendingGradingAuditAtomically,
  isCurrentSourceAuditResponder,
  listScorecards,
  readScorecardEvidence,
  parseGradedGeneration,
  type ScorecardEvidenceRow,
  type ScorecardGradingAuditCurrentness,
  type ScorecardRow,
} from './scorecards';
import {
  parseGradingAuditReservationSnapshot,
  type ScorecardGradingAuditReservationSnapshot,
} from './harness/improvements/observation-types';
import { killTask } from './task-manager/control';
import { resolveIssueWorkspace } from './issues-engineer';
import { boundedOrgTxn } from './pg-bounded-txn';
import type { OrgSql } from './work-items';
import { listLoopStanddownOwners } from './harness/routines/release-pause-ttl';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';
import { isAncestorAsync } from './release/judged-sha-containment';
import { readRunningGeneration } from './scout/generation-watermark';
import {
  describeGradingAuditDispatchSuppression,
  type GradingAuditDispatchSuppression,
} from './acceptance-rubric-vetting';
import { routeSourceGradingAudit } from './grading-audit-routing';
import { bindAgentSessionTaskToLatestNativeSession, getTask, listTasks } from './task-manager/store';
import { isTerminalState } from './task-manager/types';
import type { TaskRow } from './task-manager/types';
import { runWithWorkspaceIfConcrete } from './workspace-als';
import { FOREGROUND_TIMEOUT_CEILING_MS } from './agent-tools/capability/foreground-transport-cap';
import type { PgCoordLog } from '@papercusp/coordination/event-log';
import type { sendMessage } from './agent-tools/coordination/messages';
import type { wakeRecipients } from './agent-tools/coordination/inbox-wake';
import type { lineagePartyKeys } from './acceptance-author-identity';
import type { LivenessVerdict } from './agent-tools/coordination/liveness-oracle';
import {
  fetchGatewayOwnerExecution,
  type GatewayOwnerExecution,
} from './inference-gateway/observability';

/** The meta-rubric every grading audit grades against (proposed by P-013). */
export const GRADING_INTEGRITY_RUBRIC_REF = 'grading-integrity';

export type GenerationAncestryProbe = (root: string, ancestor: string, descendant: string) => boolean | null;

const GENERATION_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/**
 * Require a grading auditor to run on the same or a descendant source-card
 * generation. Missing identities and failed ancestry probes are unknown, so
 * they fail closed instead of sending a brief to an auditor that cannot emit a
 * valid verdict.
 */
export function assessGenerationAncestry(
  gradedSha: unknown,
  auditorSha: unknown,
  root: string,
  probe: GenerationAncestryProbe,
): { ok: true } | { ok: false; reason: string } {
  if (
    typeof gradedSha !== 'string' ||
    !GENERATION_SHA_PATTERN.test(gradedSha.trim()) ||
    typeof auditorSha !== 'string' ||
    !GENERATION_SHA_PATTERN.test(auditorSha.trim())
  ) {
    return { ok: false, reason: 'generation-sha-missing-or-invalid' };
  }
  const graded = gradedSha.trim().toLowerCase();
  const auditor = auditorSha.trim().toLowerCase();
  // A short SHA is a valid identity when it is a prefix of the full form emitted by
  // another process. Treat that as equality without asking git to resolve an ambiguous
  // object; the ancestry probe remains reserved for distinct identities.
  if (graded === auditor || graded.startsWith(auditor) || auditor.startsWith(graded)) return { ok: true };
  const isAncestor = probe(root, gradedSha.trim(), auditorSha.trim());
  if (isAncestor === true) return { ok: true };
  return {
    ok: false,
    reason: isAncestor === false ? 'auditor-build-older-than-graded-build' : 'generation-ancestry-unknown',
  };
}

/** Async operator-handler variant; avoids the synchronous Git probe on the host event loop. */
export async function assessGenerationAncestryAsync(
  gradedSha: unknown,
  auditorSha: unknown,
  root: string,
  probe?: GenerationAncestryProbe,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const preliminary = assessGenerationAncestry(gradedSha, auditorSha, root, () => null);
  if (preliminary.ok || preliminary.reason !== 'generation-ancestry-unknown') return preliminary;
  if (typeof gradedSha !== 'string' || typeof auditorSha !== 'string') return preliminary;
  const ancestry = probe
    ? probe(root, gradedSha.trim(), auditorSha.trim())
    : await isAncestorAsync(root, gradedSha.trim(), auditorSha.trim());
  return assessGenerationAncestry(gradedSha, auditorSha, root, () => ancestry);
}

/**
 * Keep every trigger bounded. A pending card is already a durable queue entry;
 * a scorecard emit or completion refusal must not turn one caller into an
 * unbounded fan-out when a historical backlog is present.
 */
export const GRADING_AUDIT_DISPATCH_LIMIT = 50;
/**
 * Keep independent scorecard dispatches moving in parallel without turning a
 * repair sweep into an unbounded launch/PG fan-out. Four matches the bounded
 * process-kill fan-out and leaves headroom for the caller's own work.
 */
export const GRADING_AUDIT_DISPATCH_CONCURRENCY = 4;
/**
 * How many of the NEWEST scorecards a no-target sweep reads before picking an
 * oldest-first batch from the pending ones among them. "Oldest-first" is within
 * this window only: a pending card older than the newest N is never selected by
 * a no-target sweep and is reachable only via explicit `targetIds` (WI-10005150).
 */
export const GRADING_AUDIT_BACKLOG_SCAN_LIMIT = 500;
/**
 * A dispatch reservation survives a launcher response failure long enough for
 * the launch idempotency key to settle, but not forever if the launcher dies
 * before the auditor emits its audit card.
 */
export const GRADING_AUDIT_RESERVATION_TTL_MS = 15 * 60 * 1000;
/** A provider queue observation must be old enough to distinguish a transient enqueue from the
 * pre-first-response admission wedge this repair is meant to recover. */
export const GRADING_AUDIT_PROVIDER_WAIT_MIN_MS = 3 * 60 * 1000;
/** Two complete owner-report reads must retain the same live request/process generation. */
export const GRADING_AUDIT_PROVIDER_EVIDENCE_SAMPLES = 2;
/** The second read is intentionally immediate by default; callers may inject a bounded delay. */
export const GRADING_AUDIT_PROVIDER_EVIDENCE_DELAY_MS = 0;
/** Allow a successful emit to return to its headless caller before retiring it. */
const GRADING_AUDIT_TERMINAL_TASK_REAP_GRACE_MS = 60 * 1000;
const GRADING_AUDIT_TASK_LABEL_PREFIX = 'grading-audit:';
/**
 * A terminal auditor, route, or launch failure without a provider reset still
 * needs a bounded retry window. Releasing the reservation without one lets the
 * next repair sweep reserve the same card and pay for another doomed boot.
 */
export const GRADING_AUDIT_FAILURE_BACKOFF_MS = GRADING_AUDIT_RESERVATION_TTL_MS;

/**
 * EI-25965998744903219 — how long a pending card may sit with no live audit lease
 * before a DESCENDANT-build dispatcher may call it stranded. An exact-build host
 * dispatches within seconds of the emit and re-dispatches once a lease lapses, so
 * two full lease windows of silence after the last stamp/lease is the evidence
 * that no host is still serving the card's recorded evaluator build.
 */
export const GRADING_AUDIT_STRANDED_AFTER_MS = 2 * GRADING_AUDIT_RESERVATION_TTL_MS;

/** The card fields the stranding verdict reads — structural, so list rows and full rows both fit. */
export interface EvaluatorBuildStrandingCard {
  gradingAudit?: {
    state: string;
    stampedAt?: string;
    dispatchReservation?: { reservedAt: string };
    lastDispatchReservation?: { reservedAt: string };
  };
  rerunRecipe?: {
    evaluator?: string;
    evaluatorBuild?: { sha: string | null; version: string };
    args?: unknown;
  };
  supersededBy?: unknown;
  retracted?: unknown;
}

type RecordedEvaluatorBuild = { sha: string | null; version: string };

/**
 * Historical spec-test-adequacy recipes may carry their evaluator pin only in
 * the executable args object. Emit accepts both layouts; dispatch and
 * stranding must apply the same identity fence or an old card can lease a
 * judge and fail only after its full replay (EI-26082605254422690).
 */
function recordedEvaluatorBuildForRecipe(
  recipe: { evaluatorBuild?: unknown; args?: unknown } | undefined,
): RecordedEvaluatorBuild | undefined {
  if (!recipe) return undefined;
  const candidate = recipe.evaluatorBuild ??
    (recipe.args && typeof recipe.args === 'object' && !Array.isArray(recipe.args)
      ? (recipe.args as { evaluatorBuild?: unknown }).evaluatorBuild
      : undefined);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const sha = (candidate as { sha?: unknown }).sha;
  const version = (candidate as { version?: unknown }).version;
  if ((sha !== null && typeof sha !== 'string') || typeof version !== 'string' || !version.trim()) return undefined;
  return { sha: typeof sha === 'string' ? sha : null, version };
}

export type EvaluatorBuildStranding =
  | { stranded: false; reason: string }
  | {
      stranded: true;
      reason: string;
      recordedBuild: { sha: string | null; version: string };
      liveBuild: { sha: string | null; version: string };
      /** Latest of the card stamp and any (current or released) audit lease. */
      idleSince: string;
      /** The exact submittable re-grade call from the card's own rerun recipe, when it has one. */
      regrade: { tool: string; args: unknown } | null;
      /**
       * WI-6554700010013275: the plans:certify-spec-clauses call that mints a superseding card
       * on THIS build, for a spec-test-adequacy card whose recipe names a complete clause
       * selection. Null for any other rubric, or a recipe too thin to select the clause.
       */
      recertify: StrandedRecertifyCall | null;
    };

/** WI-6554700010013275 — the tool that re-grades a stranded spec-test-adequacy card on the live build. */
export const STRANDED_RECERTIFY_TOOL = 'plans:certify-spec-clauses';
/** Reservation-key prefix the sweep uses to claim one stranded card for re-certification. */
export const STRANDED_RECERTIFY_KEY_PREFIX = 'grading-recertify:';
/**
 * Most stranded cards one reconcile pass re-certifies. Each call evaluates and may file a
 * card (minutes, under emit's per-rubric mutex), so the pass runs them one at a time and
 * leaves the rest for the next tick instead of holding the sweep for the whole backlog.
 */
export const STRANDED_RECERTIFY_LIMIT = 3;

export interface StrandedRecertifyCall {
  tool: typeof STRANDED_RECERTIFY_TOOL;
  args: Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nonEmptyStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => nonEmptyString(entry) !== undefined)
    ? (value as string[])
    : undefined;
}

/**
 * WI-6554700010013275 — map a stranded spec-test-adequacy card's rerun recipe to the
 * plans:certify-spec-clauses call that re-grades its clause on the live build.
 *
 * Keeps the recipe's SELECTION (plan, class, clause, evidence population) and drops every
 * REPLAY pin — `evaluatorBuild`, `bindingIds`, `specRevision`/`specFingerprint`,
 * `replaySnapshot`, `current`. Certification grades the live clause against server-measured
 * evidence and mints a NEW card stamped with this host's build; it never replays the old card
 * on a different build, so the exact-build replay fence (EI-25967923833762085) is untouched.
 * `acknowledgeExisting` is set because the superseded card is itself an existing card.
 */
export function strandedSpecAdequacyRecertifyCall(
  recipe: EvaluatorBuildStrandingCard['rerunRecipe'],
): StrandedRecertifyCall | null {
  if (recipe?.evaluator !== 'plans:evaluate-spec-test-adequacy') return null;
  const raw = recipe.args;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const args = raw as Record<string, unknown>;
  const slug = nonEmptyString(args.slug);
  const classRef = nonEmptyString(args.classRef);
  const specIds = nonEmptyStringList(args.specIds);
  if (!slug || !classRef || !specIds) return null;
  const harness = nonEmptyString(args.harness);
  const workItemIds = nonEmptyStringList(args.workItemIds);
  const evidenceRefs = nonEmptyStringList(args.evidenceRefs);
  const planItemIds = nonEmptyStringList(args.planItemIds);
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined;
  return {
    tool: STRANDED_RECERTIFY_TOOL,
    args: {
      ...(harness ? { harness } : {}),
      slug,
      classRef,
      specIds,
      ...(workItemIds ? { workItemIds } : {}),
      ...(evidenceRefs ? { evidenceRefs } : {}),
      ...(planItemIds ? { planItemIds } : {}),
      ...(typeof args.includeDraft === 'boolean' ? { includeDraft: args.includeDraft } : {}),
      ...(limit !== undefined ? { limit } : {}),
      acknowledgeExisting: true,
    },
  };
}

function latestIsoMs(values: ReadonlyArray<string | undefined>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

/**
 * EI-25965998744903219 — is this pending card STRANDED by evaluator-build drift?
 *
 * The exact-build fence (EI-25967923833762085, replay fidelity) makes every host
 * whose evaluator build differs from the card's recorded one skip the card
 * without touching it. That is correct while some host still serves the recorded
 * build. Once none does — the auditor died, its lease lapsed, and staging moved
 * past the build while release sits on an older one — the card reads 'pending'
 * forever and every repair attempt returns the same neutral skip, which looks
 * like a queue entry rather than a dead end (P-008/P-011, 2026-10-14: ~5h).
 *
 * A card is stranded from THIS host's view only when all hold:
 *   1. it is a current pending card with a recorded evaluator build that differs
 *      from the live one;
 *   2. no audit lease is live, and nothing stamped or leased it for
 *      `strandAfterMs` (an exact-build host would have re-dispatched by then);
 *   3. the live build DESCENDS from the recorded one. An older or unrelated host
 *      proves nothing: a newer exact-build host may still exist.
 *
 * The verdict never mutates the card or widens the fence. It names the remedy —
 * re-grade on the current build, which mints a superseding card whose recorded
 * build this host serves — so the caller can act instead of retrying.
 */
export function assessEvaluatorBuildStranding(
  card: EvaluatorBuildStrandingCard,
  liveBuild: { sha: string | null; version: string },
  opts: {
    nowMs: number;
    root: string;
    probe: GenerationAncestryProbe;
    strandAfterMs?: number;
    reservationTtlMs?: number;
  },
): EvaluatorBuildStranding {
  const audit = card.gradingAudit;
  if (audit?.state !== 'pending' || card.supersededBy || card.retracted) {
    return { stranded: false, reason: 'not-a-current-pending-card' };
  }
  const recorded = recordedEvaluatorBuildForRecipe(card.rerunRecipe);
  if (!recorded) return { stranded: false, reason: 'no-recorded-evaluator-build' };
  if (recorded.sha === liveBuild.sha && recorded.version === liveBuild.version) {
    return { stranded: false, reason: 'exact-build-dispatcher' };
  }
  const ttlMs = opts.reservationTtlMs ?? GRADING_AUDIT_RESERVATION_TTL_MS;
  const liveLeaseMs = latestIsoMs([audit.dispatchReservation?.reservedAt]);
  if (liveLeaseMs !== null && opts.nowMs - liveLeaseMs < ttlMs) {
    return { stranded: false, reason: 'audit-lease-live' };
  }
  const idleSinceMs = latestIsoMs([
    audit.stampedAt,
    audit.dispatchReservation?.reservedAt,
    audit.lastDispatchReservation?.reservedAt,
  ]);
  if (idleSinceMs === null) return { stranded: false, reason: 'no-stamp-or-lease-time' };
  if (opts.nowMs - idleSinceMs < (opts.strandAfterMs ?? GRADING_AUDIT_STRANDED_AFTER_MS)) {
    return { stranded: false, reason: 'within-exact-build-grace' };
  }
  const ancestry = assessGenerationAncestry(recorded.sha, liveBuild.sha, opts.root, opts.probe);
  if (!ancestry.ok) {
    return { stranded: false, reason: `live-build-not-proven-descendant:${ancestry.reason}` };
  }
  const recipe = card.rerunRecipe;
  const regrade = recipe?.evaluator && recipe.args !== undefined
    ? { tool: recipe.evaluator, args: recipe.args }
    : null;
  const recertify = strandedSpecAdequacyRecertifyCall(recipe);
  const idleSince = new Date(idleSinceMs).toISOString();
  const recordedLabel = `${recorded.sha ?? 'unknown-sha'}@${recorded.version}`;
  const liveLabel = `${liveBuild.sha ?? 'unknown-sha'}@${liveBuild.version}`;
  return {
    stranded: true,
    recordedBuild: { sha: recorded.sha, version: recorded.version },
    liveBuild: { sha: liveBuild.sha, version: liveBuild.version },
    idleSince,
    regrade,
    recertify,
    reason:
      `stranded: recorded evaluator build ${recordedLabel} has had no live audit lease since ${idleSince}, ` +
      `and this host's build ${liveLabel} descends from it, so no exact-build dispatcher is serving the card. ` +
      (recertify
        ? `Re-grade on the current build with ${recertify.tool} ${JSON.stringify(recertify.args)}; ` +
          'the new card supersedes this one and is audited on this build. The periodic grading sweep runs this call itself.'
        : regrade
          ? `Re-grade on the current build with ${regrade.tool} using the card's rerunRecipe.args; ` +
            'the new card supersedes this one and is audited on this build.'
          : 'Re-grade it on the current build; the new card supersedes this one and is audited on this build.'),
  };
}

/** Async operator-handler variant; only reaches Git after all pure stranding guards pass. */
export async function assessEvaluatorBuildStrandingAsync(
  card: EvaluatorBuildStrandingCard,
  liveBuild: { sha: string | null; version: string },
  opts: Omit<Parameters<typeof assessEvaluatorBuildStranding>[2], 'probe'> & {
    probe?: GenerationAncestryProbe;
  },
): Promise<EvaluatorBuildStranding> {
  const preliminary = assessEvaluatorBuildStranding(card, liveBuild, {
    ...opts,
    probe: () => null,
  });
  if (
    preliminary.stranded ||
    preliminary.reason !== 'live-build-not-proven-descendant:generation-ancestry-unknown'
  ) {
    return preliminary;
  }
  const recorded = recordedEvaluatorBuildForRecipe(card.rerunRecipe);
  if (typeof recorded?.sha !== 'string' || typeof liveBuild.sha !== 'string') return preliminary;
  const ancestry = await assessGenerationAncestryAsync(
    recorded.sha,
    liveBuild.sha,
    opts.root,
    opts.probe,
  );
  const probeResult = ancestry.ok
    ? true
    : ancestry.reason === 'auditor-build-older-than-graded-build'
      ? false
      : null;
  return assessEvaluatorBuildStranding(card, liveBuild, {
    ...opts,
    probe: () => probeResult,
  });
}
/**
 * EI-22978598482930667 — reset-aware re-dispatch suppression.
 *
 * A terminal quota failure carries a KNOWN future recovery instant, and until
 * this constant existed nothing consumed it: the reservation was released on the
 * terminal failure and the next sweep tick re-launched the same doomed judge.
 * Measured 2026-09-11 over the WHOLE grading-audit log population (n=6163, not a
 * recency head): 2228 legs died on the pty-host `(quota-blocked)` drop and 2523
 * launches were refused outright by the launcher's walled-pool preflight — every
 * one of those 2523 printing a contiguous `earliest known recovery <ISO>` — while
 * ZERO cards were emitted.
 *
 * The suppression is PROVIDER-AGNOSTIC by construction: it keys on the terminal
 * failure and on the account ledger's own reset terms, so it covers the Claude
 * primary leg (which no launcher preflight gates — `isCodexAutoRoute` is false
 * for a claude-resolved provider) exactly as it covers the Codex fallback.
 */
export const GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS = 15 * 60 * 1000;
/**
 * Floor: a recovered-but-still-walled pool must never collapse back into the
 * ~55s sweep-tick busy loop this suppression exists to stop.
 */
export const GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS = 5 * 60 * 1000;
/**
 * Ceiling: a wrong-but-plausible far-future reset must degrade into "re-probe in
 * six hours", never into a permanently stranded audit queue. A reset beyond this
 * is clamped, re-probed once, and re-recorded from whatever the wall says then.
 */
export const GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/**
 * Automatic grading auditors must use the inference gateway so a quota-walled
 * system/default credential cannot strand the audit queue before kickoff.
 */
export const GRADING_AUDIT_ACCOUNT = 'auto' as const;
const GRADING_AUDIT_MAX_TERMINAL_FALLBACKS = 1;
const GRADING_AUDIT_TERMINAL_LOG_RECHECK_DELAY_MS = 250;
const GRADING_AUDIT_TERMINAL_LOG_MAX_RECHECKS = 4;
const GRADING_AUDIT_FALLBACK = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol' as const,
  effort: 'high' as const,
  // The system/default credential is a single-account escape hatch, not a
  // capacity-safe recovery route. Keep the cross-backend retry on Codex's
  // gateway pool so it can select a currently healthy account and fail over
  // when the account that caused the terminal failure is walled.
  account: GRADING_AUDIT_ACCOUNT,
};

/** Bounded worker pool that preserves input order for deterministic receipts. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export type GradingAuditLaunchContext = Parameters<typeof launchAgentTool.handler>[1];
type GradingAuditLaunchHandler = typeof launchAgentTool.handler;

/**
 * Stable in-process principal that owns fresh grading-auditor launches.
 *
 * Dispatch runs inside whichever call surfaced the pending card — most often
 * the card AUTHOR's own `scorecards:emit` / `work_items:complete`. Forwarding
 * that caller context to capability:launch-agent stamped the author as the
 * judge's `--launched-by`, placing the judge inside the author's launch
 * lineage, so the emit-side `self_audit_refused` guard rejected the finished
 * audit every time (EI-23911815311476758, EI-23987538343141495). The routing
 * leg already excludes author lineage; only the fresh-launch leg leaked it.
 * Mirrors ACCEPTANCE_GRADING_SWEEP_ACTOR in acceptance-grader.ts.
 */
export const GRADING_AUDIT_DISPATCH_ACTOR = 'system:grading-audit-dispatch';

/**
 * The launch context for a fresh grading auditor: the caller's context re-owned
 * by GRADING_AUDIT_DISPATCH_ACTOR so the judge is outside every card author's
 * lineage. A system principal needs a concrete workspace; without one, keep the
 * caller context (the emit-side lineage guard still fails closed).
 */
export function gradingAuditorLaunchCtx(ctx: GradingAuditLaunchContext): GradingAuditLaunchContext {
  const workspaceId = ctx.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') return ctx;
  return {
    ...ctx,
    uiClientId: null,
    isSuperuser: false,
    isPowerUser: false,
    principal: { kind: 'system', slug: GRADING_AUDIT_DISPATCH_ACTOR, workspaceId },
    ownerId: GRADING_AUDIT_DISPATCH_ACTOR,
    ownerLabel: 'grading audit dispatch',
    userId: null,
  } as never;
}

export type PendingGradingAuditDispatchState = 'routed' | 'launched' | 'deduped' | 'skipped' | 'failed';

/**
 * The dispatcher performs several independent DB-backed and process-backed phases for one
 * target. Keep the phase on a failed receipt so a transient error such as CONNECT_TIMEOUT is
 * actionable instead of collapsing reserve, task inspection, and launch failures into one
 * indistinguishable message (EI-26081368846958374).
 */
export type GradingAuditDispatchPhase =
  | 'dispatch'
  | 'rubric-read'
  | 'generation-read'
  | 'reservation'
  | 'reservation-confirm'
  | 'live-task-read'
  | 'task-session-bind'
  | 'native-session-read'
  | 'task-terminal-detection'
  | 'task-log-read'
  | 'source-audit-responder-check'
  | 'task-termination'
  | 'retained-auditor-notification'
  | 'source-audit-route'
  | 'auditor-launch'
  | 'auditor-task-read'
  | 'auditor-terminal-detection';

export interface PendingGradingAuditDispatchReceipt {
  issueId: string;
  rubricRef?: string;
  state: PendingGradingAuditDispatchState;
  idempotencyKey?: string;
  /** Exact retained lease for the existing independent auditor; re-read the
   * target before handing a renewed lease to that same live session. */
  dispatchReservation?: GradingAuditReservationLease;
  renewalNotification?: GradingAuditRenewalNotification;
  launch?: unknown;
  conversationId?: string;
  routingFallback?: string;
  reason?: string;
  /** The first dispatcher phase that failed; present on failed receipts. */
  phase?: GradingAuditDispatchPhase;
  /** EI-25965998744903219: set on a drift skip once no exact-build host can still serve the card. */
  stranded?: Extract<EvaluatorBuildStranding, { stranded: true }>;
  terminalRecovery?: {
    retiredTaskIds: string[];
    attempts: number;
    codes: GradingAuditRecoveryCode[];
    fallback?: typeof GRADING_AUDIT_FALLBACK | GradingLaunchProfile;
    /** Backend the bounded retry actually launched on; omitted for cleanup without a retry. */
    routedTo?: 'claude' | 'codex';
  };
}

type GradingAuditRecoveryCode =
  | AcceptanceGraderTerminalFailureCode
  | 'task_receipt_not_live'
  | 'superseded_source_audit_responder';

export interface PendingGradingAuditDispatchResult {
  requestedTargetIds: string[];
  receipts: PendingGradingAuditDispatchReceipt[];
  /**
   * WI-6554700010013275: reconcilePendingGradingAudits only — one entry per stranded
   * spec-test-adequacy card this pass tried to re-certify on the live build.
   */
  recertifications?: StrandedRecertifyReceipt[];
}

export type StrandedRecertifyState = 'recertified' | 'not-recertified' | 'deduped' | 'failed';

export interface StrandedRecertifyReceipt {
  issueId: string;
  state: StrandedRecertifyState;
  reason: string;
  call: StrandedRecertifyCall;
  /** The new card that superseded the stranded one (state 'recertified' only). */
  supersededBy?: string;
  counts?: unknown;
}

export interface DispatchPendingGradingAuditsInput {
  /**
   * Pending target issue ids surfaced by the completion gate. Omit or pass an
   * empty list to select the oldest current pending cards from scorecard
   * history; this is the scorecards:emit repair trigger.
   */
  targetIds?: readonly string[];
  /** The completion caller's context, forwarded to capability:launch-agent. */
  ctx: GradingAuditLaunchContext;
  /** Keep the auditor in the completed item's harness when available. */
  harness?: string | null;
  /**
   * Whether this reconciliation may re-certify stranded spec-test-adequacy cards.
   * The periodic acceptance sweep keeps this enabled by default; dispatch-only
   * callers such as scorecards:repair set it to false to avoid an undisclosed
   * card-superseding write.
   */
  recertifyStranded?: boolean;
}

export interface DispatchPendingGradingAuditsDeps {
  /**
   * WI-6554700010013275: run one stranded card's re-certification call and return the
   * plans:certify-spec-clauses reply body. Defaults to that tool's handler under the
   * reconcile caller's context.
   */
  recertifyStranded?: (call: StrandedRecertifyCall, ctx: GradingAuditLaunchContext) => Promise<Record<string, unknown>>;
  listScorecards?: typeof listScorecards;
  /** Current evaluator build used to preflight pinned spec-test-adequacy recipes. */
  getEvaluatorBuild?: () => BuildInfo;
  /** Atomically close the old audit lease after a newer card supersedes it. */
  cancelSuperseded?: typeof cancelSupersededPendingGradingAuditAtomically;
  /** Atomically close a pending lease whose exact evidence-binding selector is no longer current. */
  cancelStaleEvidence?: typeof cancelStaleEvidencePendingGradingAuditAtomically;
  /** Read fresh audit-target currentness for pending cards with pinned evidence bindings. */
  readEvidence?: typeof readScorecardEvidence;
  getRubric?: typeof getRubric;
  launch?: GradingAuditLaunchHandler;
  route?: typeof routeSourceGradingAudit;
  reserve?: typeof reservePendingGradingAudit;
  /** Re-check the owned reservation after the candidate snapshot is claimed. */
  confirmReservation?: typeof confirmPendingGradingAuditReservation;
  release?: typeof releasePendingGradingAudit;
  /** Check for a still-live task from an earlier reservation epoch. */
  listTasks?: typeof listTasks;
  /** Reconcile a legacy/late-enrolled task through the existing owner-bound session binder. */
  bindTaskNativeSession?: typeof bindAgentSessionTaskToLatestNativeSession;
  /** Exact native session bindings for the retained tasks' recorded session ids. */
  listNativeSessionsByTranscriptHandles?: (
    sessionIds: readonly string[],
  ) => Promise<Array<Pick<AdvSessionRow, 'agent' | 'coordOwnerId' | 'sessionId'> & Partial<Pick<AdvSessionRow, 'id'>>>>;
  /** Resolve a Claude transcript under the retained task's exact owner identity. */
  findSessionTranscript?: typeof findSessionTranscript;
  findCodexRolloutPath?: typeof findCodexRolloutPathByUuid;
  /** A live task is viable only while it remains the active consult answerer for its lease. */
  isCurrentSourceAuditResponder?: typeof isCurrentSourceAuditResponder;
  getTask?: typeof getTask;
  notifyRetainedAuditor?: typeof notifyRetainedGradingAuditor;
  readLogTail?: (path: string) => string | Promise<string>;
  /** Read log progress time; null means missing/unreadable and cannot prove a stall. */
  readLogMtimeMs?: (path: string) => number | null;
  /** Resolve one auditor owner only after an old no-first-turn log candidate needs liveness corroboration. */
  resolveOwnerLiveness?: (ownerId: string) => Promise<Pick<LivenessVerdict, 'sessionState'> | null>;
  killTask?: typeof killTask;
  sleep?: (ms: number) => Promise<void>;
  terminalLogRecheckDelayMs?: number;
  terminalLogMaxRechecks?: number;
  /** Read the active workspace-wide owner pause before dispatching new auditors. */
  listWorkspaceWideLoopStanddownOwners?: (workspaceId: string, nowMs: number) => Promise<Set<string>>;
  /** Future usage-reset terms for the account pool, for reset-aware quota backoff. */
  readProviderResets?: (nowMs: number) => Promise<number[]>;
  /**
   * Measured serviceability of a provider, so the ONE bounded terminal retry is
   * never routed to a pool the launcher will refuse at boot. Fails open.
   */
  providerCanServe?: (provider: string) => Promise<boolean>;
  /** Running server generation used to pin audits of generation-bound cards to a fresh launch. */
  readCurrentGeneration?: typeof readRunningGeneration;
  /** Shared tri-state ancestry check used by both dispatch and scorecards:emit. */
  generationAncestry?: GenerationAncestryProbe;
  /** Strict owner-report read used to prove a retained task is still queued before provider work. */
  fetchGatewayOwnerExecution?: typeof fetchGatewayOwnerExecution;
  /** Test/host seam for the bounded repeated provider-evidence read. */
  providerEvidenceSamples?: number;
  providerEvidenceDelayMs?: number;
  /** Clock seam for the recorded backoff instant. */
  now?: () => number;
}

async function resolveGradingAuditorOwnerLiveness(
  ownerId: string,
): Promise<Pick<LivenessVerdict, 'sessionState'> | null> {
  const { resolveSessionStates } = await import('./agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates([{ ownerId }], { hydratePerId: true });
  return verdicts.get(ownerId) ?? null;
}

type RetainedNativeTranscriptProof = {
  nativeTranscriptPath: string;
  nativeSessionId: string;
  nativeBackend?: 'claude' | 'codex';
};

/**
 * Native transcript evidence for the recovery seam is deliberately stricter than a PTY tail:
 * the exact session must have a kickoff/user record and no assistant response or tool activity.
 * A malformed or mixed-session tail is unknown, never a reason to retire a live task.
 */
function nativeTranscriptShowsKickoffWithoutResponse(
  rawTranscript: string,
  proof: RetainedNativeTranscriptProof,
): boolean {
  if (!rawTranscript.trim() || !proof.nativeSessionId.trim()) return false;
  let seenSession = false;
  let kickoff = false;
  let response = false;
  let toolActivity = false;
  for (const line of rawTranscript.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      row = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const message = row.message && typeof row.message === 'object' && !Array.isArray(row.message)
      ? row.message as Record<string, unknown>
      : null;
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : null;
    const rowSessionId = typeof row.sessionId === 'string'
      ? row.sessionId
      : typeof payload?.id === 'string' && row.type === 'session_meta'
        ? payload.id
        : null;
    if (rowSessionId && rowSessionId !== proof.nativeSessionId) return false;
    if (rowSessionId !== proof.nativeSessionId) continue;
    seenSession = true;
    const type = typeof row.type === 'string' ? row.type : '';
    const role = typeof message?.role === 'string' ? message.role : '';
    const eventType = typeof payload?.type === 'string' ? payload.type : '';
    if (type === 'user' || role === 'user' || /^(?:user_message|turn_started|task_started)$/i.test(eventType)) kickoff = true;
    if (type === 'assistant' || role === 'assistant' || /^(?:task_complete|assistant|response|turn_complete)$/i.test(eventType)) response = true;
    if (/tool|function|mcp/i.test(type) || /tool|function|mcp/i.test(eventType)) toolActivity = true;
  }
  return seenSession && kickoff && !response && !toolActivity;
}

function isProviderQueuedWithoutUpstream(
  report: GatewayOwnerExecution,
  nowMs: number,
  taskStartedAtMs: number,
): NonNullable<GatewayOwnerExecution['activeRequests']>[number] | null {
  if (
    report.active === null || report.active <= 0 || report.observedAt === null ||
    report.processInstanceId === null || report.activeRequestsComplete !== true ||
    report.activeRequests === null || !Number.isSafeInteger(nowMs)
  ) return null;
  const candidates = report.activeRequests.filter((request) =>
    (request.provider === 'claude' || request.provider === 'codex') &&
    request.providerQueuedAt !== null && request.providerAdmittedAt === null &&
    request.attempts === 0 && request.upstreamCalls === 0 && request.upstreamCallsDropped === 0 &&
    request.startedAt >= taskStartedAtMs - 5_000 &&
    report.observedAt! >= request.providerQueuedAt &&
    report.observedAt! - request.providerQueuedAt >= GRADING_AUDIT_PROVIDER_WAIT_MIN_MS,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Require repeated, complete provider-stage evidence before classifying a live task's
 * no-first-turn wait as terminal. The request id/start timestamp and gateway process
 * generation must remain equal across samples; reservation/task/native identity are checked
 * at the call site and passed as explicit arguments so a later lease cannot reuse this proof.
 */
async function proveRetainedProviderAdmissionStall(
  task: Pick<TaskRow, 'taskId' | 'startedAt' | 'processIdentity'>,
  ownerId: string,
  reservationKey: string,
  reservationReservedAt: string,
  nativeProof: RetainedNativeTranscriptProof | undefined,
  readLogTail: (path: string) => string | Promise<string>,
  readOwnerExecution: (ownerId: string) => Promise<GatewayOwnerExecution>,
  sleep: (ms: number) => Promise<void>,
  samples: number,
  delayMs: number,
): Promise<boolean> {
  if (!nativeProof || !task.taskId.trim() || !ownerId || !reservationKey ||
      !reservationReservedAt || reservationReservedAt === 'reservation-unknown' ||
      typeof task.processIdentity !== 'string' || !task.processIdentity.trim()) return false;
  const taskStartedAtMs = Date.parse(task.startedAt);
  if (!Number.isFinite(taskStartedAtMs)) return false;
  try {
    if (!nativeTranscriptShowsKickoffWithoutResponse(
      await readLogTail(nativeProof.nativeTranscriptPath),
      nativeProof,
    )) return false;
  } catch {
    return false;
  }
  const count = Math.max(GRADING_AUDIT_PROVIDER_EVIDENCE_SAMPLES, Math.floor(samples));
  const waitMs = Math.max(0, Math.floor(delayMs));
  let first: { requestId: number; startedAt: number; processInstanceId: string } | null = null;
  for (let sample = 0; sample < count; sample++) {
    let report: GatewayOwnerExecution;
    try {
      report = await readOwnerExecution(ownerId);
    } catch {
      return false;
    }
    const nowMs = report.observedAt ?? NaN;
    const queued = isProviderQueuedWithoutUpstream(report, nowMs, taskStartedAtMs);
    if (!queued || report.processInstanceId === null) return false;
    const generation = { requestId: queued.requestId, startedAt: queued.startedAt, processInstanceId: report.processInstanceId };
    if (first && (first.requestId !== generation.requestId || first.startedAt !== generation.startedAt ||
        first.processInstanceId !== generation.processInstanceId)) return false;
    first ??= generation;
    if (sample + 1 < count && waitMs > 0) await sleep(waitMs);
  }
  return first !== null;
}

export type GradingAuditReservationStatus =
  | 'claimed'
  | 'already-reserved'
  | 'not-pending'
  | 'quota-backoff'
  | 'dispatch-backoff';

/** The immutable lease identity carried from reservation through dispatch. */
export interface GradingAuditReservationLease {
  key: string;
  reservedAt: string;
  snapshot?: ScorecardGradingAuditReservationSnapshot;
}

/**
 * Why a card must not be re-dispatched yet, recorded on the card itself so the
 * suppression survives the dispatcher process that learned it.
 */
export interface GradingAuditDispatchBackoff {
  /** ISO-8601 instant before which this card must not be re-dispatched. */
  until: string;
  /**
   * Where the instant came from. `default` is the honest answer when a quota
   * wall was measured but no reset was recoverable from either source — it is a
   * conservative window, NOT a claim about when capacity returns.
   */
  source: 'account-ledger' | 'launcher-horizon' | 'default' | 'retry-window';
  /** The terminal failure code that produced the suppression. */
  code: string;
  recordedAt: string;
  reason: string;
}

export interface GradingAuditReservationResult {
  status: GradingAuditReservationStatus;
  reservation?: GradingAuditReservationLease;
  /** Present on a live quota or general dispatch backoff that refused the claim. */
  backoff?: GradingAuditDispatchBackoff;
  /**
   * The retained pending lease this claim replaced, whether it was still active or had already
   * lapsed and been cleared by an earlier sweep. A dispatcher that dedupes to the live auditor
   * still holding that lease must hand it back with `releasePendingGradingAudit({ restore })`;
   * otherwise the new epoch invalidates the auditor's brief before a renewal notice can arrive.
   */
  prior?: GradingAuditReservationLease;
}

function parsePriorGradingAuditReservation(value: unknown): GradingAuditReservationResult['prior'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { key, reservedAt, snapshot } = value as { key?: unknown; reservedAt?: unknown; snapshot?: unknown };
  const parsedSnapshot = parseGradingAuditReservationSnapshot(snapshot);
  return typeof key === 'string' && key && typeof reservedAt === 'string' && reservedAt
    ? { key, reservedAt, ...(parsedSnapshot ? { snapshot: parsedSnapshot } : {}) }
    : undefined;
}

/**
 * Confirm that a reservation still owns a pending target immediately before
 * dispatch. The initial candidate read is intentionally outside the reservation
 * transaction, and the settlement writer can finish another auditor between
 * that read and this dispatcher. Re-locking the row here makes the post-
 * reservation state check authoritative for the next side effect.
 */
export async function confirmPendingGradingAuditReservation(
  issueId: string,
  reservationKey: string,
  options: Pick<GradingAuditReservationOptions, 'workspaceId'> & {
    reservedAt?: string;
    snapshot?: ScorecardGradingAuditReservationSnapshot;
    /** Commit-boundary confirmation on the notification's own transaction. */
    tx?: OrgSql;
    expectedCard?: Pick<ScorecardRow, 'evidenceFingerprint' | 'createdBy' | 'rubricRef'>;
  } = {},
): Promise<boolean> {
  const workspaceId = options.workspaceId?.trim() || (await resolveIssueWorkspace(issueId));
  const reservedAt = options.reservedAt ?? null;
  const read = async (tx: OrgSql) => tx<{ feature_id: string }[]>`
      SELECT scorecard.feature_id
        FROM harness_shared.work_items AS scorecard
       WHERE scorecard.workspace_id = ${workspaceId}
         AND scorecard.feature_id = ${issueId}
         AND scorecard.item_kind = ANY (ARRAY['bug', 'change', 'task'])
         AND scorecard.payload->'observation'->'gradingAudit'->>'state' = 'pending'
         AND scorecard.payload->'observation'->'gradingAudit'->'dispatchReservation'->>'key' = ${reservationKey}
         AND (
           ${reservedAt}::text IS NULL
           OR scorecard.payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt' = ${reservedAt}
         )
         ${options.snapshot
           ? tx`AND scorecard.payload->'observation'->'gradingAudit'->'dispatchReservation'->'snapshot' = ${JSON.stringify(options.snapshot)}::text::jsonb`
           : tx``}
         AND (
           ${options.expectedCard != null}::boolean = false
             OR (
             scorecard.payload->'observation'->>'evidenceFingerprint' IS NOT DISTINCT FROM ${options.expectedCard?.evidenceFingerprint ?? null}
             AND scorecard.payload->'_ei'->>'created_by' IS NOT DISTINCT FROM ${options.expectedCard?.createdBy ?? null}
             AND scorecard.payload->'observation'->>'rubricRef' IS NOT DISTINCT FROM ${options.expectedCard?.rubricRef ?? null}
           )
         )
         AND scorecard.payload->'observation'->'retracted' IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM harness_shared.work_items AS superseder
            WHERE superseder.workspace_id = scorecard.workspace_id
              AND superseder.payload->'observation'->>'supersedes' = scorecard.feature_id
              AND superseder.payload->'observation'->>'rubricRef' = scorecard.payload->'observation'->>'rubricRef'
              AND superseder.payload->'observation'->>'sourceHive' IS NOT DISTINCT FROM scorecard.payload->'observation'->>'sourceHive'
         )
       FOR UPDATE`;
  const current = options.tx
    ? await read(options.tx)
    : await withGradingAuditSubjectMutex(workspaceId, issueId, () => boundedOrgTxn(read));
  return Boolean(current[0]);
}

export interface GradingAuditRenewalNotification {
  state: 'delivered' | 'already-delivered' | 'skipped' | 'failed';
  ownerId?: string;
  msgId?: string;
  reason?: string;
  queued?: number;
  /** The coord wake queue is not execution evidence. */
  pickupConfirmed?: false;
}

/** Reuse the coord replay transaction: target/task validation and notification
 * append commit together. No extra worker, notification ledger or routine. */
export async function notifyRetainedGradingAuditor(
  input: {
    card: ScorecardRow;
    task: TaskRow;
    reservation: GradingAuditReservationLease;
    workspaceId: string;
    harness?: string;
    /** Resume a positively parked retained task without replacing its lease. */
    resumeParked?: boolean;
  },
  deps: {
    append?: PgCoordLog['appendLineIfAbsent'];
    send?: typeof sendMessage;
    wake?: typeof wakeRecipients;
    resolveParties?: typeof lineagePartyKeys;
    confirmReservation?: typeof confirmPendingGradingAuditReservation;
    mutex?: typeof withGradingAuditSubjectMutex;
  } = {},
): Promise<GradingAuditRenewalNotification> {
  const { card, task, reservation, workspaceId } = input;
  const ownerId = typeof task.detail?.coordOwnerId === 'string' ? task.detail.coordOwnerId.trim() : '';
  const label = typeof task.detail?.label === 'string' ? task.detail.label : '';
  const key = `grading-audit:${card.issueId}`;
  if (!workspaceId || workspaceId === '*' || !ownerId || !card.createdBy?.trim() ||
      !card.evidenceFingerprint?.trim() || reservation.key !== key || !reservation.reservedAt ||
      task.workspaceId !== workspaceId || task.class !== 'agent-session' ||
      !['pending', 'running'].includes(task.state) ||
      (label !== key && !label.startsWith(`${key}:`)) ||
      (task.workItemId != null && task.workItemId !== card.issueId)) {
    return { state: 'skipped', reason: 'retained auditor target/owner/fingerprint provenance is missing or mismatched' };
  }
  const msgId = `${input.resumeParked ? 'grading-audit-resume' : 'grading-audit-renewal'}:${createHash('sha256')
    .update(JSON.stringify([workspaceId, card.issueId, card.evidenceFingerprint, ownerId, reservation]))
    .digest('hex')}`;
  const body = [
    `${input.resumeParked ? 'Resume retained audit under existing lease' : 'Renewed lease'}: key '${key}', reservedAt '${reservation.reservedAt}'. Your existing independent audit task '${task.taskId}' is retained.`,
    `Continue only for exact target '${card.issueId}' and evidence fingerprint '${card.evidenceFingerprint}'. Re-read scorecards:get and require pending state plus this exact key/reservedAt, fingerprint, and reservation snapshot ${JSON.stringify(reservation.snapshot ?? null)} before auditing; otherwise stop without grading or emitting.`,
    gradingAuditBrief(card, reservation.reservedAt),
  ].join('\n\n');
  const summary = input.resumeParked
    ? `Resume retained grading audit for ${card.issueId}`
    : `Renewed grading-audit lease for ${card.issueId}`;
  // Lazy imports keep the existing dispatcher unit-test graph free of coord stores.
  const send = deps.send ?? (await import('./agent-tools/coordination/messages')).sendMessage;
  const wake = deps.wake ?? (await import('./agent-tools/coordination/inbox-wake')).wakeRecipients;
  const parties = deps.resolveParties ?? (await import('./acceptance-author-identity')).lineagePartyKeys;
  const append = deps.append ?? (() => {
    // The existing appendLineIfAbsent owns the replay lock and returns its durable winner.
    // Scope this instance explicitly; scheduled repair callers have no session partition.
    return import('@papercusp/coordination/event-log').then(({ PgCoordLog }) => {
      const log = new PgCoordLog({ getSql: () => getOrgPg().sql, workspaceId, ensureSchema: async () => {} });
      return log.appendLineIfAbsent.bind(log);
    });
  })();
  let created = false;
  try {
    await (deps.mutex ?? withGradingAuditSubjectMutex)(workspaceId, card.issueId, async () => {
      await send({ ownerId: GRADING_AUDIT_DISPATCH_ACTOR, ownerLabel: 'grading audit dispatch',
        source: 'principal', workspaceId, userId: null }, {
        to: [ownerId], msgId, harnessSlug: input.harness,
        summary,
        body,
        expectsReply: true,
        extra: { expects: 'action', sections: [{ text: body,
          forYouBecause: { relation: 'owns', ref: task.taskId } }] },
        persistEnvelope: async (envelope) => {
          const result = await (await append)('messages', GRADING_AUDIT_DISPATCH_ACTOR, envelope, {
            prepare: async (rawTx) => {
              const tx = rawTx as OrgSql;
              if (!(await (deps.confirmReservation ?? confirmPendingGradingAuditReservation)(card.issueId, key, {
                workspaceId, reservedAt: reservation.reservedAt, expectedCard: card, tx,
              }))) throw new Error('renewal target/fingerprint/lease changed before delivery');
              const taskDetail = JSON.stringify({
                gradingAudit: {
                  issueId: card.issueId,
                  evidenceFingerprint: card.evidenceFingerprint,
                  reservation,
                },
              });
              const tasks = await tx<{ task_id: string }[]>`
                UPDATE harness_shared.task_ledger
                   SET detail = COALESCE(detail, '{}'::jsonb) || ${taskDetail}::text::jsonb,
                       updated_at = now()
                 WHERE workspace_id = ${workspaceId} AND task_id = ${task.taskId}
                   AND class = 'agent-session' AND state IN ('pending', 'running')
                   AND detail->>'coordOwnerId' = ${ownerId} AND detail->>'label' = ${label}
                   AND (work_item_id IS NULL OR work_item_id = ${card.issueId})
                 RETURNING task_id`;
              if (!tasks[0]) throw new Error('retained auditor task changed or retired before delivery');
              const sources = [...new Set([card.createdBy, ...(card.vetting?.critics ?? [])]
                .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
                .map((id) => id.trim()))];
              const ids = [...new Set([...sources, ownerId])];
              const identities = await parties(ids, { workspaceId, sql: tx });
              if (ids.some((id) => !identities.has(id)) ||
                  sources.some((id) => identities.get(id) === identities.get(ownerId))) {
                throw new Error('retained auditor independence is not proven');
              }
              return envelope;
            },
          });
          created = result.created;
          return result.envelope;
        },
      });
    });
    if (!created) return { state: 'already-delivered', ownerId, msgId, pickupConfirmed: false };
    const outcome = await wake([ownerId], { workspaceId, requiredWake: true,
      source: GRADING_AUDIT_DISPATCH_ACTOR, summary,
      payload: { msg_id: msgId, issueId: card.issueId, evidenceFingerprint: card.evidenceFingerprint, reservation } });
    return { state: 'delivered', ownerId, msgId, queued: outcome.queued ?? outcome.woken, pickupConfirmed: false };
  } catch (error) {
    // An appended inbox directive remains delivered even if its best-effort
    // wake fails. Never delete its lease or append a duplicate on that outcome.
    if (created) return { state: 'delivered', ownerId, msgId,
      reason: `notification persisted; wake request failed: ${error instanceof Error ? error.message : String(error)}`,
      pickupConfirmed: false };
    return { state: 'failed', ownerId, msgId, reason: error instanceof Error ? error.message : String(error),
      pickupConfirmed: false };
  }
}

export interface GradingAuditCancellationNotification {
  issueId: string;
  state: 'delivered' | 'skipped' | 'failed';
  ownerId?: string;
  taskIds?: string[];
  msgId?: string;
  queued?: number;
  reason?: string;
  /** The wake queue is not proof that the auditor picked up the notice. */
  pickupConfirmed?: false;
}

/**
 * Notify every exact live auditor task after its target was cancelled by a
 * committed evidence withdrawal. The task ledger is the owner authority here:
 * do not address the card author or the dispatch actor, and do not infer an
 * owner from a stale scorecard snapshot. A stable message id makes retries a
 * replay of the same owner/target directive.
 */
export async function notifyCancelledGradingAuditors(
  input: {
    workspaceId: string;
    issueIds: readonly string[];
    harness?: string | null;
    reason?: string;
  },
  deps: {
    listTasks?: typeof listTasks;
    send?: typeof sendMessage;
    wake?: typeof wakeRecipients;
  } = {},
): Promise<GradingAuditCancellationNotification[]> {
  const workspaceId = input.workspaceId.trim();
  const issueIds = [...new Set(input.issueIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (!workspaceId || workspaceId === '*' || issueIds.length === 0) return [];

  const readTasks = deps.listTasks ?? listTasks;
  let tasks: TaskRow[];
  try {
    tasks = await readTasks({
      workspaceId,
      states: ['pending', 'running'],
      classes: ['agent-session'],
      labelPrefix: GRADING_AUDIT_TASK_LABEL_PREFIX,
      limit: 2_000,
    });
  } catch (error) {
    const reason = `could not resolve live grading-audit tasks: ${error instanceof Error ? error.message : String(error)}`;
    return issueIds.map((issueId) => ({ issueId, state: 'failed', reason }));
  }

  const taskGroups = new Map<string, Map<string, TaskRow[]>>();
  for (const issueId of issueIds) {
    const key = `${GRADING_AUDIT_TASK_LABEL_PREFIX}${issueId}`;
    for (const task of tasks) {
      const label = typeof task.detail?.label === 'string' ? task.detail.label : '';
      const ownerId = typeof task.detail?.coordOwnerId === 'string' ? task.detail.coordOwnerId.trim() : '';
      if (!ownerId || (label !== key && !label.startsWith(`${key}:`))) continue;
      const byOwner = taskGroups.get(issueId) ?? new Map<string, TaskRow[]>();
      const ownerTasks = byOwner.get(ownerId) ?? [];
      ownerTasks.push(task);
      byOwner.set(ownerId, ownerTasks);
      taskGroups.set(issueId, byOwner);
    }
  }

  const send = deps.send ?? (await import('./agent-tools/coordination/messages')).sendMessage;
  const wake = deps.wake ?? (await import('./agent-tools/coordination/inbox-wake')).wakeRecipients;
  const cancellationReason = input.reason?.trim() || 'the cited spec evidence was withdrawn';
  const notifications: GradingAuditCancellationNotification[] = [];
  for (const issueId of issueIds) {
    const byOwner = taskGroups.get(issueId);
    if (!byOwner) continue;
    for (const [ownerId, ownerTasks] of [...byOwner.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const taskIds = [...new Set(ownerTasks.map((task) => task.taskId))].sort();
      const msgId = `grading-audit-cancelled:${createHash('sha256')
        .update(JSON.stringify([workspaceId, issueId, ownerId]))
        .digest('hex')}`;
      const summary = `Cancelled grading audit for ${issueId}`;
      const body = [
        `The grading audit for target '${issueId}' was cancelled after the transaction committed because ${cancellationReason}.`,
        `Your live grading-audit task${taskIds.length === 1 ? '' : 's'} '${taskIds.join("', '")}' must stop. Do not grade or emit a result for '${issueId}'; its reservation is no longer valid.`,
      ].join('\n\n');
      let persisted = false;
      try {
        await send({
          ownerId: GRADING_AUDIT_DISPATCH_ACTOR,
          ownerLabel: 'grading audit dispatch',
          source: 'principal',
          workspaceId,
          userId: null,
        }, {
          to: [ownerId],
          msgId,
          harnessSlug: input.harness ?? undefined,
          kind: 'message',
          category: 'cancellation',
          summary,
          body,
          extra: {
            expects: 'action',
            sections: [{
              text: body,
              forYouBecause: { relation: 'owns', ref: taskIds[0] ?? issueId },
            }],
          },
        });
        persisted = true;
        const outcome = await wake([ownerId], {
          workspaceId,
          requiredWake: true,
          source: GRADING_AUDIT_DISPATCH_ACTOR,
          summary,
          payload: { msg_id: msgId, issueId, taskIds },
        });
        notifications.push({ issueId, state: 'delivered', ownerId, taskIds, msgId,
          queued: outcome.queued ?? outcome.woken, pickupConfirmed: false });
      } catch (error) {
        notifications.push({
          issueId,
          state: persisted ? 'delivered' : 'failed',
          ownerId,
          taskIds,
          msgId,
          ...(persisted
            ? { reason: `notification persisted; wake request failed: ${error instanceof Error ? error.message : String(error)}` }
            : { reason: error instanceof Error ? error.message : String(error) }),
          ...(persisted ? { pickupConfirmed: false as const } : {}),
        });
      }
    }
  }
  return notifications;
}

interface GradingAuditReservationOptions {
  workspaceId?: string | null;
  now?: Date;
  /** Point-in-time evidence/evaluator identity to persist with the lease. */
  snapshot?: ScorecardGradingAuditReservationSnapshot;
  /** Currentness from scorecards:list; stale or legacy identity-less settled cards are reopened atomically. */
  currentness?: ScorecardGradingAuditCurrentness;
  /**
   * Set only after this dispatcher has proven its build is the graded build or a descendant.
   * That proof lets a compatible dispatcher clear a legacy generation-incompatible backoff.
   */
  allowGenerationIncompatibleBackoff?: boolean;
}

async function withGradingAuditSubjectMutex<T>(
  workspaceId: string,
  issueId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.env.VITEST && process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST !== '1') {
    return operation();
  }
  const release = await acquireGradingAuditSubjectMutex({
    workspaceId,
    subjectIssueId: issueId,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

/**
 * A settled stamp can be re-opened only when the current meta-rubric identity is
 * known and the recorded identity is either stale or absent because the card was
 * created before audit identity stamping. Other unknown states (missing live
 * identity or a meta-rubric mismatch) remain fail-closed.
 */
function reopenableSettledAuditIdentity(
  currentness: ScorecardGradingAuditCurrentness | undefined,
): currentness is ScorecardGradingAuditCurrentness & {
  currentRevision: number;
  currentCriteriaHash: string;
} {
  return Boolean(
    currentness &&
    currentness.currentRevision != null &&
    currentness.currentCriteriaHash != null &&
    (currentness.state === 'stale' ||
      (currentness.state === 'unknown' && currentness.reason === 'recorded-identity-missing')),
  );
}

/**
 * The launcher's walled-pool refusal prints its own recovery horizon as a
 * contiguous ISO instant. Measured over the whole grading-audit log population
 * (2026-09-11, n=6163): 2523 refusals, 2523 contiguous horizons — the TUI never
 * wrapped one, so reading it back out of the terminal evidence is sound.
 */
const LAUNCHER_RECOVERY_HORIZON = /earliest known recovery (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;

/** Extract the launcher's printed recovery instant; null when absent or already past. */
export function parseLauncherRecoveryHorizon(rawLog: string | null | undefined, nowMs = Date.now()): number | null {
  const match = LAUNCHER_RECOVERY_HORIZON.exec(rawLog ?? '');
  if (!match?.[1]) return null;
  const at = Date.parse(match[1]);
  return Number.isFinite(at) && at > nowMs ? at : null;
}

/**
 * Future reset terms for every usage-walled account in the pool, across ALL
 * providers on purpose: the dispatcher may use its Claude primary OR its Codex
 * fallback, so re-dispatch becomes useful the moment EITHER provider recovers.
 * Fail-open (an empty list) on any read failure — a missing ledger must degrade
 * to the default window, never strand the queue.
 */
export async function readWalledAccountResets(nowMs: number): Promise<number[]> {
  try {
    const [{ accountStatus }, { activeWorkspaceId }] = await Promise.all([
      import('./deployment/account-pool-store'),
      import('./workspace-registry'),
    ]);
    const rows = await accountStatus(activeWorkspaceId());
    return rows
      .filter((row) => row.usageWalled)
      .map((row) => row.usageResetAt)
      .filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at > nowMs);
  } catch {
    return [];
  }
}

/**
 * Can `provider` serve an auditor launch RIGHT NOW, on a measured reading?
 *
 * The dispatcher holds exactly ONE terminal retry
 * (GRADING_AUDIT_MAX_TERMINAL_FALLBACKS), so spending it on a provider whose
 * entire pool is usage-walled burns that retry on a launch the launcher's own
 * walled-pool preflight refuses at boot (exit 78, "REFUSING TO LAUNCH — ...
 * pool is fully walled"). The audit then lands in quota backoff having never
 * been attempted on a provider that could actually have served it.
 *
 * Measured 2026-09-22T02:36Z, the case that motivated this: codex was 0 of 7
 * serviceable (binding 'usage-wall', reset ~4d out) while claude was 2 of 3,
 * and the fallback flipped to codex regardless — see the population figure in
 * this file's header (2523 preflight refusals, ZERO cards emitted).
 *
 * Fail-OPEN (true) on any read failure, matching readWalledAccountResets: a
 * missing ledger must degrade to the previous unconditional behaviour, never
 * strand the queue by refusing to try at all.
 */
export async function gradingAuditProviderCanServe(
  provider: string,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    const [{ accountStatus, poolVerdictByProvider }, { activeWorkspaceId }] = await Promise.all([
      import('./deployment/account-pool-store'),
      import('./workspace-registry'),
    ]);
    const rows = await accountStatus(activeWorkspaceId(), nowMs);
    return gradingAuditFallbackVerdictCanServe(
      poolVerdictByProvider(rows, nowMs).find((row) => row.provider === provider),
    );
  } catch {
    return true;
  }
}

/**
 * The routing decision itself, pure over one provider's pool verdict.
 *
 * Spending the single bounded retry on the fallback provider is only worth it
 * when that provider has a MEASURED serviceable account. `!atCapacity` is the
 * wrong test: `poolVerdictByProvider` deliberately reports a pool with stale or
 * unmeasured readings as NOT at capacity, so a provider with zero serviceable
 * accounts still read as "can serve". Measured 2026-09-27 (WI-10003463): codex
 * read serviceable=0 unknown=3 atCapacity=false while claude had serviceable=1;
 * the audit was routed to codex, landed on an account whose OAuth refresh token
 * was invalidated, and died on a 502. Staying on the primary then costs nothing:
 * its auto-routed gateway pool is the one with measured headroom.
 *
 * No verdict at all means no accounts registered for the provider — nothing can
 * serve there either, so that is false too. Only a failed ledger READ fails open
 * (see gradingAuditProviderCanServe).
 */
export function gradingAuditFallbackVerdictCanServe(
  verdict: { serviceable: number } | undefined,
): boolean {
  return (verdict?.serviceable ?? 0) > 0;
}

/**
 * Turn a measured quota wall into a DATED suppression.
 *
 * The EARLIEST future candidate wins, deliberately. The two error directions are
 * not symmetric: waking too early costs one futile boot that simply re-records
 * the backoff, while waking too late strands the whole audit queue past the
 * moment capacity actually returned. When neither source yields an instant the
 * result says so (`source: 'default'`) instead of inventing a recovery time.
 */
export async function resolveGradingAuditQuotaBackoff(input: {
  code: string;
  evidence?: string | null;
  logTail?: string | null;
  nowMs?: number;
  readProviderResets?: (nowMs: number) => Promise<number[]>;
}): Promise<GradingAuditDispatchBackoff> {
  const nowMs = input.nowMs ?? Date.now();
  const horizon = parseLauncherRecoveryHorizon(`${input.logTail ?? ''}\n${input.evidence ?? ''}`, nowMs);
  const ledger = await (input.readProviderResets ?? readWalledAccountResets)(nowMs).catch(() => [] as number[]);
  const ledgerEarliest = ledger
    .filter((at) => Number.isFinite(at) && at > nowMs)
    .sort((a, b) => a - b)[0];
  const candidates: Array<{ at: number; source: GradingAuditDispatchBackoff['source'] }> = [
    ...(ledgerEarliest != null ? [{ at: ledgerEarliest, source: 'account-ledger' as const }] : []),
    ...(horizon != null ? [{ at: horizon, source: 'launcher-horizon' as const }] : []),
  ].sort((a, b) => a.at - b.at);
  const chosen = candidates[0];
  const rawUntil = chosen ? chosen.at : nowMs + GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS;
  const until = Math.min(
    Math.max(rawUntil, nowMs + GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS),
    nowMs + GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS,
  );
  const source = chosen?.source ?? 'default';
  return {
    until: new Date(until).toISOString(),
    source,
    code: input.code,
    recordedAt: new Date(nowMs).toISOString(),
    reason:
      source === 'default'
        ? `terminal ${input.code} with no recoverable reset; suppressing re-dispatch for a conservative window`
        : `terminal ${input.code}; suppressing re-dispatch until the ${source} reset`,
  };
}

/** Build the durable suppression used when routing/launching failed without a
 * provider-specific recovery horizon. */
export function resolveGradingAuditFailureBackoff(input: {
  code: string;
  reason: string;
  nowMs?: number;
}): GradingAuditDispatchBackoff {
  const nowMs = input.nowMs ?? Date.now();
  return {
    until: new Date(nowMs + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
    source: 'retry-window',
    code: input.code,
    recordedAt: new Date(nowMs).toISOString(),
    reason: input.reason,
  };
}

/**
 * Atomically reserve one pending scorecard for an auditor launch.
 *
 * The dispatcher intentionally reads a bounded candidate list first, so this
 * is the second, write-side gate: the UPDATE predicate is the actual winner
 * election. A row lock is held for the fallback classification query, which
 * keeps two concurrent dispatchers from both observing an unreserved target.
 */
export async function reservePendingGradingAudit(
  issueId: string,
  reservationKey: string,
  options: GradingAuditReservationOptions = {},
): Promise<GradingAuditReservationResult> {
  const workspaceId = options.workspaceId?.trim() || (await resolveIssueWorkspace(issueId));
  const now = options.now ?? new Date();
  const reservedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - GRADING_AUDIT_RESERVATION_TTL_MS).toISOString();
  const lease: GradingAuditReservationLease = {
    key: reservationKey,
    reservedAt,
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
  };
  const reservation = JSON.stringify(lease);
  const reopenIdentity = reopenableSettledAuditIdentity(options.currentness)
    ? {
        recordedRevision: options.currentness.recordedRevision,
        recordedCriteriaHash: options.currentness.recordedCriteriaHash,
        rubricRevision: options.currentness.currentRevision,
        criteriaHash: options.currentness.currentCriteriaHash,
      }
    : null;
  const reopenedStamp = reopenIdentity
    ? JSON.stringify({
        state: 'pending',
        metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
        rubricRevision: reopenIdentity.rubricRevision,
        criteriaHash: reopenIdentity.criteriaHash,
        stampedAt: now.toISOString(),
        dispatchReservation: lease,
        lastDispatchReservation: lease,
      })
    : null;

  return withGradingAuditSubjectMutex(workspaceId, issueId, () => boundedOrgTxn(async (tx: OrgSql) => {
    // WI-10005273: lock the row and capture the lease this claim may replace, so a dispatcher
    // that dedupes to the live holder of an expired lease can restore it rather than delete it.
    const priorRows = await tx<{
      feature_id: string;
      prior_state: string | null;
      prior_reservation: unknown;
      prior_last_reservation: unknown;
    }[]>`
      SELECT feature_id,
             payload->'observation'->'gradingAudit'->>'state' AS prior_state,
             payload->'observation'->'gradingAudit'->'dispatchReservation' AS prior_reservation,
             payload->'observation'->'gradingAudit'->'lastDispatchReservation' AS prior_last_reservation
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
       FOR UPDATE`;
    const priorRow = priorRows[0];
    const prior = priorRow?.prior_state === 'pending'
      ? parsePriorGradingAuditReservation(priorRow.prior_reservation) ??
        (priorRow.prior_reservation == null
          ? parsePriorGradingAuditReservation(priorRow.prior_last_reservation)
          : undefined)
      : undefined;
    const claimed = await tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               jsonb_set(
                 -- A claim only succeeds once any blocking backoff below has expired,
                 -- or a compatible dispatcher has proved it can clear a legacy
                 -- generation-incompatible stamp, so clearing it here spends the stamp.
                 COALESCE(payload, '{}'::jsonb) #- '{observation,gradingAudit,dispatchBackoff}',
                 '{observation,gradingAudit,dispatchReservation}',
                 ${reservation}::text::jsonb,
                 true
               ),
               '{observation,gradingAudit,lastDispatchReservation}',
               ${reservation}::text::jsonb,
               true
             ),
             origin = 'local',
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
         AND payload->'observation'->'retracted' IS NULL
         AND (
           (
             payload->'observation'->'gradingAudit'->>'state' = 'pending'
             AND (
               payload->'observation'->'gradingAudit'->'dispatchReservation' IS NULL
               OR CASE
                    WHEN payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt'
                         ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
                    THEN (payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt')::timestamptz < ${staleBefore}::timestamptz
                    ELSE TRUE
                  END
             )
             -- EI-22978598482930667: a live reset-aware quota backoff refuses the
             -- claim outright. Fail OPEN on an unparseable stamp, exactly like the
             -- reservation predicate above: a malformed value must never be able to
             -- strand a card permanently.
             AND (
               payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'until' IS NULL
               OR (
                 ${options.allowGenerationIncompatibleBackoff === true}
                 AND payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'code' = 'generation_incompatible'
               )
               OR CASE
                    WHEN payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'until'
                         ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
                    THEN (payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'until')::timestamptz <= ${reservedAt}::timestamptz
                    ELSE TRUE
                  END
             )
           )
           OR (
             ${
               reopenIdentity
                 ? tx`payload->'observation'->'gradingAudit'->>'state' IN ('passed', 'failed')
               AND (
                 payload->'observation'->'gradingAudit'->>'rubricRevision' IS NULL
                 OR payload->'observation'->'gradingAudit'->>'rubricRevision' IS NOT DISTINCT FROM ${String(reopenIdentity.recordedRevision)}
               )
               AND (
                 payload->'observation'->'gradingAudit'->>'criteriaHash' IS NULL
                 OR payload->'observation'->'gradingAudit'->>'criteriaHash' IS NOT DISTINCT FROM ${reopenIdentity.recordedCriteriaHash}
               )
               AND (
                 payload->'observation'->'gradingAudit'->>'rubricRevision' IS DISTINCT FROM ${String(reopenIdentity.rubricRevision)}
                 OR payload->'observation'->'gradingAudit'->>'criteriaHash' IS DISTINCT FROM ${reopenIdentity.criteriaHash}
               )`
                 : tx`FALSE`
             }
           )
         )
       RETURNING feature_id`;
    if (claimed[0]) {
      if (reopenIdentity && reopenedStamp) {
        await tx`
          UPDATE harness_shared.work_items
             SET payload = jsonb_set(
                   COALESCE(payload, '{}'::jsonb),
                   '{observation,gradingAudit}',
                   ${reopenedStamp}::text::jsonb,
                   true
                 ),
                 origin = 'local',
                 updated_ts = ${Date.now()}
           WHERE workspace_id = ${workspaceId}
             AND feature_id = ${issueId}
             AND item_kind = ANY (ARRAY['bug', 'change', 'task'])`;
      }
      return {
        status: 'claimed' as const,
        reservation: lease,
        ...(prior ? { prior } : {}),
      };
    }

    const current = await tx<
      {
        state: string | null;
        has_reservation: boolean;
        backoff: GradingAuditDispatchBackoff | null;
        retracted: boolean;
      }[]
    >`
      SELECT payload->'observation'->'gradingAudit'->>'state' AS state,
             (payload->'observation'->'gradingAudit' ? 'dispatchReservation') AS has_reservation,
             payload->'observation'->'gradingAudit'->'dispatchBackoff' AS backoff,
             payload->'observation'->'retracted' IS NOT NULL AS retracted
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
       FOR UPDATE`;
    const row = current[0];
    if (row?.state !== 'pending' || row.retracted) return { status: 'not-pending' as const };
    // Report the quota wall ahead of the reservation: a backoff is only written
    // as the reservation is released, so a live one is the specific reason this
    // claim was refused — and a caller that reads 'already-reserved' would wait
    // on a dispatcher that is not in fact running.
    const until = row.backoff?.until ? Date.parse(row.backoff.until) : NaN;
    if (row.backoff && Number.isFinite(until) && until > now.getTime()) {
      return {
        status: row.backoff.code === 'model_quota_exhausted' ? ('quota-backoff' as const) : ('dispatch-backoff' as const),
        backoff: row.backoff,
      };
    }
    return row.has_reservation ? { status: 'already-reserved' as const } : { status: 'not-pending' as const };
  }));
}

/**
 * Release only the reservation owned by this dispatcher.
 *
 * EI-22978598482930667: pass `backoff` to record a reset-aware quota suppression
 * in the SAME statement that drops the reservation. Atomicity is the point — a
 * separate write could lose the race to the next sweep tick and re-launch the
 * judge the suppression exists to stop.
 *
 * WI-10005273: pass `restore` to hand the row back to the lease this dispatcher
 * REPLACED instead of deleting the reservation. A dispatcher that re-claimed an
 * expired lease and then deduped to the still-live auditor holding it must
 * restore that lease: the auditor cites exactly its key + reservedAt at
 * scorecards:emit, so deleting it left every audit longer than the TTL unable
 * to emit (refused grading_audit_reservation_unavailable) and the card pending.
 */
export async function releasePendingGradingAudit(
  issueId: string,
  reservationKey: string,
  options: Pick<GradingAuditReservationOptions, 'workspaceId'> & {
    backoff?: GradingAuditDispatchBackoff;
    reservedAt?: string;
    restore?: GradingAuditReservationLease;
  } = {},
): Promise<boolean> {
  const workspaceId = options.workspaceId?.trim() || (await resolveIssueWorkspace(issueId));
  const backoffJson = options.backoff ? JSON.stringify(options.backoff) : null;
  const restoreJson = options.restore ? JSON.stringify(options.restore) : null;
  const reservedAt = options.reservedAt ?? null;
  const released = await withGradingAuditSubjectMutex(workspaceId, issueId, () => boundedOrgTxn(
    async (tx: OrgSql) =>
      tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = ${
           restoreJson && backoffJson
             ? tx`jsonb_set(
                 jsonb_set(
                   jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}', ${restoreJson}::text::jsonb, true),
                   '{observation,gradingAudit,lastDispatchReservation}',
                   ${restoreJson}::text::jsonb,
                   true
                 ),
                 '{observation,gradingAudit,dispatchBackoff}',
                 ${backoffJson}::text::jsonb,
                 true
               )`
             : restoreJson
               ? tx`jsonb_set(
                   jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}', ${restoreJson}::text::jsonb, true),
                   '{observation,gradingAudit,lastDispatchReservation}',
                   ${restoreJson}::text::jsonb,
                   true
                 )`
               : backoffJson
                 ? tx`jsonb_set(
                     jsonb_set(
                       payload #- '{observation,gradingAudit,dispatchReservation}',
                       '{observation,gradingAudit,lastDispatchReservation}',
                       payload->'observation'->'gradingAudit'->'dispatchReservation',
                       true
                     ),
                     '{observation,gradingAudit,dispatchBackoff}',
                     ${backoffJson}::text::jsonb,
                     true
                   )`
                 : tx`jsonb_set(
                     payload #- '{observation,gradingAudit,dispatchReservation}',
                     '{observation,gradingAudit,lastDispatchReservation}',
                     payload->'observation'->'gradingAudit'->'dispatchReservation',
                     true
                   )`
         },
             origin = 'local',
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
         AND payload->'observation'->'gradingAudit'->>'state' = 'pending'
         AND payload->'observation'->'gradingAudit'->'dispatchReservation'->>'key' = ${reservationKey}
         AND (
           ${reservedAt}::text IS NULL
           OR payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt' = ${reservedAt}
         )
      RETURNING feature_id`,
  ));
  return Boolean(released[0]);
}

function currentPendingScorecard(card: ScorecardRow): boolean {
  const audit = card.gradingAudit;
  const reopenableSettled =
    (audit?.state === 'passed' || audit?.state === 'failed') &&
    reopenableSettledAuditIdentity(card.gradingAuditCurrentness);
  return (
    (audit?.state === 'pending' || reopenableSettled) &&
    !card.supersededBy &&
    !card.retracted &&
    // An audit of a rubric-vetting card cannot make an attestation about an
    // older subject rubric current again. Historical unbound cards are unknown.
    (card.subject?.kind !== 'rubric' || card.subjectRubricCurrentness?.state === 'current') &&
    card.rubricRef !== GRADING_INTEGRITY_RUBRIC_REF
  );
}

function hasCitedSpecEvidenceBindings(card: ScorecardRow): boolean {
  const recipe = card.rerunRecipe;
  // Newer recipes pin immutable row ids. Legacy recipes pin the same rows by
  // their exact args.current tuples; both need a read-time currentness check.
  return Boolean(recipe?.selection.bindingIds?.length || recipe?.args.current?.length);
}

function gradingAuditReservationSnapshot(
  card: ScorecardRow,
  evidence?: ScorecardEvidenceRow,
): ScorecardGradingAuditReservationSnapshot {
  const bindingIds = [...(card.rerunRecipe?.selection.bindingIds ?? [])]
    .filter((id): id is number => Number.isSafeInteger(id) && id > 0)
    .sort((a, b) => a - b);
  const currentness = evidence?.evidenceBindingCurrentness;
  return {
    evidenceFingerprint: (card.evidenceFingerprint ?? evidence?.evidenceFingerprint ?? '').trim() || null,
    evaluatorBuild: recordedEvaluatorBuildForRecipe(card.rerunRecipe) ?? null,
    bindingIds,
    bindingCurrentness: bindingIds.length === 0
      ? null
      : currentness
        ? {
            state: currentness.state,
            reason: currentness.reason,
            citedBindingCount: currentness.citedBindingCount,
            retractedBindingIds: [...currentness.retractedBindingIds].sort(),
            unavailableBindingIds: [...currentness.unavailableBindingIds].sort(),
          }
        : {
            state: 'unknown',
            reason: 'evidence-currentness-not-read',
            citedBindingCount: bindingIds.length,
            retractedBindingIds: [],
            unavailableBindingIds: bindingIds.map(String),
          },
  };
}

function scorecardAuditEvidenceMatchesListRow(card: ScorecardRow, evidence: ScorecardEvidenceRow): boolean {
  const cardAudit = card.gradingAudit;
  const evidenceAudit = evidence.gradingAudit;
  const cardBindingIds = card.rerunRecipe?.selection.bindingIds;
  const evidenceBindingIds = evidence.rerunRecipe?.selection.bindingIds;
  return (
    card.issueId === evidence.issueId &&
    cardAudit?.state === 'pending' &&
    evidenceAudit?.state === 'pending' &&
    cardAudit.stampedAt === evidenceAudit.stampedAt &&
    (card.evidenceFingerprint ?? null) === (evidence.evidenceFingerprint ?? null) &&
    (card.rerunRecipe?.args.harness ?? null) === (evidence.rerunRecipe?.args.harness ?? null) &&
    Array.isArray(cardBindingIds) &&
    Array.isArray(evidenceBindingIds) &&
    cardBindingIds.length === evidenceBindingIds.length &&
    cardBindingIds.every((id, index) => id === evidenceBindingIds[index])
  );
}

function oldestFirst(a: ScorecardRow, b: ScorecardRow): number {
  return a.createdAt.localeCompare(b.createdAt) || a.issueId.localeCompare(b.issueId);
}

function gradingAuditBrief(card: ScorecardRow, reservationReservedAt: string): string {
  const scratchTemplate = `/tmp/grading-integrity-${card.issueId}.XXXXXX`;
  const recordedEvaluatorBuild = recordedEvaluatorBuildForRecipe(card.rerunRecipe);
  // WI-6554700010009935: the rubric's terminal-re-rate drill says only
  // `scorecards:list { rubricRef, sourceHive }`, so judges paged 200-500 terminal cards
  // (1.6-4MB per read) to find one subject's interim cards. Name the exact narrow read.
  const interimCardRead = card.subject?.ref
    ? `scorecards:list { rubricRef:'${card.rubricRef}', subjectRef:'${card.subject.ref}', provisional:true }`
    : `scorecards:list { rubricRef:'${card.rubricRef}'${card.sourceHive ? `, sourceHive:'${card.sourceHive}'` : ''}, provisional:true }`;
  return [
    `Currentness guard: at the start of the audit and immediately before emitting, call scorecards:get { issueId:'${card.issueId}' } and require its returned scorecard.gradingAuditCurrentness.state to be 'current'. This is a field of that scorecard response, not a state:read registry cell. If the field is absent, 'stale' or 'unknown', report the missing field or its reason and stop without grading or emitting; the pending-audit dispatcher must refresh the stamp or repair the auditor's serving route first.`,
    ...(recordedEvaluatorBuild
      ? [`Evaluator-build guard: this target records evaluator build ${JSON.stringify(recordedEvaluatorBuild)}. The scorecards:get response must include evaluatorBuildCurrentness.state='current' with the exact recorded and live identities before you read criterion evidence. If it is absent, 'stale' or 'unknown', stop without grading or emitting. For spec-test-adequacy, also replay the stored rerunRecipe with plans:evaluate-spec-test-adequacy before the evidence pass and require its returned evaluatorBuild to match the recorded identity exactly; a drift marker or missing live identity is a preflight refusal, not a reason to spend the audit.`]
      : []),
    `You are the dedicated grading-integrity auditor for scorecard ${card.issueId}.`,
    `The target is a terminal standard-rubric scorecard for rubric '${card.rubricRef}'. Inspect that exact scorecard and grade whether its evidence and criterion explanations are complete and independently re-runnable.`,
    `Source subject: ${JSON.stringify(card.subject ?? null)}; evidence fingerprint: ${card.evidenceFingerprint ?? 'not recorded'}. Preserve the stored evidence scope; do not substitute a newer working tree.`,
    `Interim cards (terminal-re-rate): read them with ${interimCardRead}. It returns only the provisional cards for this subject, usually none. Do not page the rubric's whole card history to find them.`,
    `Historical source evidence: when a criterion cites a committed file, use capability:git-evidence { op:'readFileAtCommit', commitSha:'<full SHA from the stored evidence>', path:'<repository-relative path>' } to inspect that exact blob. Do not use capability:git or current-tree capability:read as proof of historical contents. If the stored evidence lacks the full commit SHA or path, state that exact gap and do not infer from HEAD.`,
    `Historical source page budgeting: code:run uses a default script budget of ${DEFAULT_SCRIPT_TIMEOUT_MS.toLocaleString('en-US')} ms (${DEFAULT_SCRIPT_TIMEOUT_MS / 1000} seconds); explicit timeoutSec can raise it to the ${FOREGROUND_TIMEOUT_CEILING_MS.toLocaleString('en-US')} ms (${FOREGROUND_TIMEOUT_CEILING_MS / 1000} seconds) foreground ceiling. Do not fan out byte-page chains for multiple large blobs in one call; read one oversized blob's chain per code:run. If a single blob's full chain might approach the ceiling, read a bounded page segment and continue its exact next_cursor in a separate call, or issue the page reads directly. Preserve the complete bytes for the cited blob's integrity check.`,
    `External-checkout source evidence: when the cited binding's repository measurement names rootHarnessSlug, copy that exact registered slug into capability:git-evidence { op:'readFileAtCommit', commitSha, path, rootHarnessSlug }. Evidence attributed to the plan harness may have executed in another registered repository. A commit lookup failure in the plan repository does not establish absence in the recorded evidence repository; do not guess a directory or substitute HEAD. Follow byte-page next_cursor unchanged so the registered root remains pinned.`,
    `Repository-pin recovery: before declaring a committed-file citation unresolvable, read the cited binding's full details with plans:get-spec-evidence and inspect measurementPin.files and measurementPin.repos. The recorded repo, head, gitlink, rootHarnessSlug and headBlob identify the source repository and exact blob; a test-run's shorter filePath does not replace the measurement pin's root-relative path. rootHarnessSlug selects a registered checkout, while repos[].repo may name a submodule inside it. For a nested pin (measurementPin.files[].repositoryPath/repo !== '.'), strip that repository prefix from the file path and pass it as repositoryPath in capability:git-evidence { op:'readFileAtCommit', commitSha, path:'<child-relative path>', repositoryPath:'<repo>' }; when rootHarnessSlug is absent, keep the plan harness as the resolved root. Do not send a submodule's commit to the parent repository and treat that lookup failure as absent evidence. Use only a supported exact-blob route for the recorded repository; if that route cannot express the pin, report the exact unsupported locator instead of claiming the stored repository pin is missing.`,
    `Session-turn evidence: this judge may use sessions:read only with session:'self'; sessions:search and non-self transcript reads are outside its role. Do not try to open a referenced external session_turn. Use preserved evidence in the scorecard or linked plan/work-item records as those records; if the cited turn is not preserved there, state the exact unresolved ref and rate the criterion from the available evidence without inferring the missing turn from a summary.`,
    `Wake delivery: if an in-turn inbox nudge requires acknowledgment and identifies this judge's own delivery_id, acknowledge only that delivery with events:cancel { delivery_id }. Never cancel an await, tree, announcement, or another principal's delivery; do not guess an id.`,
    `Dispatch lease: key 'grading-audit:${card.issueId}', reservedAt '${reservationReservedAt}'. Before reading criterion evidence, re-read the exact target and continue only if gradingAudit.state is 'pending' and dispatchReservation.key and dispatchReservation.reservedAt exactly match this lease. A missing reservation at the START means this kickoff is stale: report the current state and stop. If a present reservation differs, treat it as a renewal only when your direct coord inbox contains a message from system:grading-audit-dispatch with summary "Renewed grading-audit lease for ${card.issueId}", and the message says your existing independent audit task is retained. Require the notice to identify this exact target '${card.issueId}', the current evidence fingerprint '${card.evidenceFingerprint ?? 'not recorded'}', the expected key 'grading-audit:${card.issueId}', and a renewed reservedAt that matches the target's current dispatchReservation exactly. Re-read scorecards:get and require the target is still current and pending with that exact target, fingerprint, key, and reservedAt; then use the renewed key and reservedAt as your effective lease for the audit and eventual gradingAuditReservation. Without that direct matching renewal, report the current state and stop without grading or emitting. This strict check applies only at the START of the audit; it does not authorize any unrelated reservation change. A lease that lapses after you began is handled by the pre-emit rule below.`,
    'MCP result-shape safety: concurrent scorecards:get pages can be replaced inline by a recoverable `papercusp.output-envelope/v1` wrapper when the shared result-door budget is exceeded. Inspect the outer response before reading scorecard.criteria. If it is an output envelope, follow its content reference with capability:read and restore the underlying scorecards:get result; never pass the wrapper to a scorecard field reader or treat absent inline fields as missing evidence.',
    'Evidence completeness: follow rerunRecipeRead.read and every rerunRecipeRead.next, concatenate the exact JSON chunks in offset order, and parse only when rerunRecipeRead.complete is true. Follow evidenceRead.next through the entire criterion index, then read every indexed criterion through its final evidence page; evidenceRead.complete on a selected criterion applies only to that criterion. An incomplete page with a valid continuation is recoverable evidence, not a missing or unre-runnable recipe. Do not rate re-runnable-evidence from the first page. If a continuation fails, preserve the exact cursor request and returned failure; distinguish that retrieval failure from absent stored evidence.',
    'Do not modify implementation files, run shell commands, recruit peers, emit an ordinary same-rubric scorecard, or broaden scope.',
    `If the ordinary MCP tools are unavailable and you must use the documented scripts/mcp-call.mjs recovery path, stream each JSON payload through quoted stdin (--json -). If an intermediate file is unavoidable, first create a private directory with \`mktemp -d ${scratchTemplate}\` and keep every file inside it. Never read or write shared fixed names such as /tmp/eval-args.json or /tmp/eval.json: other grading auditors run concurrently and can overwrite them.`,
    `Emit exactly one COMPLETE terminal scorecards:emit audit: { rubricRef:'${GRADING_INTEGRITY_RUBRIC_REF}', terminal:true, subject:{ kind:'scorecard', ref:'${card.issueId}' }, ratings:{...}, gradingAuditReservation:{ key:'<effective key>', reservedAt:'<effective reservedAt>' } }. Include concrete evidence for every criterion in the grading-integrity rubric. The gradingAuditReservation field is required for this active lease; copy both values exactly from the lease you confirmed. If you verified a renewal at start or pre-emit, use its renewed key and reservedAt.`,
    `Before emitting, re-read the target with scorecards:get { issueId: '${card.issueId}' } and check scorecard.gradingAudit.state plus scorecard.auditTarget (current, superseded/supersededBy, retracted, subjectRubricCurrentness — read-time relations, not observation stamps): this dispatch brief may be stale after the reservation lease expires. Emit only when the exact target is still current and its gradingAudit.state is exactly 'pending'. If the state is not 'pending' (including 'passed', 'failed', or 'cancelled'), the rubric subject is no longer current, or the target is superseded or retracted, do not emit any audit; report the current state and any auditIssueId, then stop.`,
    // WI-10006794: the start-of-audit lease check above is strict, but at EMIT time an absent
    // reservation only means this lease lapsed while the audit ran (a full audit of a large card
    // outlasts GRADING_AUDIT_RESERVATION_TTL_MS). scorecards:emit admits a lapsed lease's own
    // auditor (EI-25246208524832409); an auditor that stops here throws the finished audit away.
    `At this pre-emit re-read, a dispatchReservation that is ABSENT means only that your lease lapsed while you audited; it is NOT a reason to stop. If gradingAudit.state is still exactly 'pending', emit with your original gradingAuditReservation unchanged: scorecards:emit admits the auditor that held a lapsed lease and refuses anyone else. A present reservation with a different key or reservedAt is a renewal only if your direct coord inbox contains a message from system:grading-audit-dispatch with summary "Renewed grading-audit lease for ${card.issueId}", and the message says your existing independent audit task is retained. Require the notice to identify this exact target '${card.issueId}', the current evidence fingerprint '${card.evidenceFingerprint ?? 'not recorded'}', the expected key 'grading-audit:${card.issueId}', and a renewed reservedAt that matches the target's current dispatchReservation exactly. Re-read scorecards:get and require the target is still current and pending with that exact target, fingerprint, key, and reservedAt; then emit using the renewed key and reservedAt in gradingAuditReservation. Without that direct matching renewal, stop without emitting: an unrelated reservation change or a notice for another task, target, fingerprint, key, or reservedAt is not authority to continue. If the emit is refused, report the refusal code and stop.`,
    'A successful audit emission settles the target scorecard; do not emit any second audit or other scorecard.',
  ].join('\n\n');
}

/**
 * Is grade-the-grader dispatch suppressed in this workspace right now?
 *
 * The ONE predicate behind both the dispatch guard below and the vetting read's
 * refusal text (EI-24121421744054354), so "why is this audit still pending" and
 * "will an auditor be launched" can never disagree. Fails OPEN (null) on a read
 * error: the guard only suppresses new work, so a scan failure must never strand
 * the audit queue, and a vetting annotation must never invent a blocker.
 */
export async function readGradingAuditDispatchSuppression(
  workspaceId: string,
  deps: {
    listWorkspaceWideLoopStanddownOwners?: (workspaceId: string, nowMs: number) => Promise<Set<string>>;
    nowMs?: number;
    targetOwnerId?: string | null;
  } = {},
): Promise<GradingAuditDispatchSuppression | null> {
  const nowMs = deps.nowMs ?? Date.now();
  const owners = await readActiveLoopStanddownOwners(
    workspaceId, deps.listWorkspaceWideLoopStanddownOwners, nowMs,
  );
  return gradingAuditSuppressionForOwnerSet(owners, deps.targetOwnerId);
}

async function readActiveLoopStanddownOwners(
  workspaceId: string,
  reader: ((workspaceId: string, nowMs: number) => Promise<Set<string>>) | undefined,
  nowMs: number,
): Promise<Set<string>> {
  try {
    const owners = reader
      ? await reader(workspaceId, nowMs)
      : await listLoopStanddownOwners(getOrgPg().sql, { workspaceId, nowMs, workspaceWideOnly: true });
    observeFallback('grading-standdown-read', { eligible: 1, applied: 1, reason: 'applied' }, { workspaceId });
    return owners;
  } catch (error) {
    observeFallback('grading-standdown-read', { eligible: 1, applied: 0, reason: 'standdown-read-failed' }, { workspaceId });
    console.warn(
      `[grading-integrity] workspace stand-down read failed (non-fatal, failing open): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Set();
  }
}

function gradingAuditSuppressionForOwnerSet(
  owners: Set<string>,
  targetOwnerId?: string | null,
): GradingAuditDispatchSuppression | null {
  if (owners.size === 0) return null;
  const target = targetOwnerId?.trim() || null;
  if (target && !owners.has(target)) return null;
  return {
    reason: 'workspace-wide-loop-standdown',
    pausedOwnerCount: owners.size,
    ...(target ? { targetOwnerId: target } : {}),
  };
}

/**
 * Launch one independent auditor for each currently pending target surfaced by
 * the completion gate, or for an oldest-first bounded backlog batch when no
 * explicit targets were supplied. The scorecard read deliberately includes
 * historical rows, then applies the current/superseded/retracted filter locally:
 * this prevents a read-side default change from accidentally re-dispatching a
 * retired target. capability:launch-agent's stable idempotency key makes a
 * retry of the same completion or emit safe.
 */
export async function dispatchPendingGradingAudits(
  input: DispatchPendingGradingAuditsInput,
  deps: DispatchPendingGradingAuditsDeps = {},
): Promise<PendingGradingAuditDispatchResult> {
  const explicitTargetIds = [...new Set((input.targetIds ?? []).map((id) => id.trim()).filter(Boolean))].slice(
    0,
    GRADING_AUDIT_DISPATCH_LIMIT,
  );

  const readCards = deps.listScorecards ?? listScorecards;
  const resolveRubric = deps.getRubric ?? getRubric;
  const profile = gradingLaunchProfile(input.ctx);
  const launch = withGradingLaunchProfile(deps.launch ?? launchAgentTool.handler, profile);
  const reserve = deps.reserve ?? reservePendingGradingAudit;
  const confirmReservation = deps.confirmReservation ?? confirmPendingGradingAuditReservation;
  const release = deps.release ?? releasePendingGradingAudit;
  const readTasks = deps.listTasks ?? listTasks;
  const listNativeSessionsByTranscriptHandles = deps.listNativeSessionsByTranscriptHandles ??
    ((sessionIds: readonly string[]) => advSessionsByTranscriptHandles({ sessionIds }));
  const resolveSessionTranscript = deps.findSessionTranscript ?? findSessionTranscript;
  const workspaceId = input.ctx.workspaceId?.trim();
  // Internal scorecard readers derive their workspace from AsyncLocalStorage.
  // This dispatcher is also called from completion/repair code that may not be
  // inside the MCP handler's workspace scope, even though its context carries a
  // concrete workspace. Pin every reader that uses the ambient scope to the
  // dispatch context so candidate selection, evidence re-checks, and rubric
  // resolution cannot cross workspace boundaries.
  const inDispatchWorkspace = <T>(fn: () => T): T =>
    runWithWorkspaceIfConcrete(workspaceId, fn);
  const pausedOwners = workspaceId
    ? await readActiveLoopStanddownOwners(workspaceId, deps.listWorkspaceWideLoopStanddownOwners, Date.now())
    : new Set<string>();
  const cards = await inDispatchWorkspace(() => readCards({
    includeSuperseded: true,
    includeRetracted: true,
    ...(explicitTargetIds.length > 0 ? { issueIds: explicitTargetIds } : {}),
    limit: explicitTargetIds.length > 0 ? GRADING_AUDIT_DISPATCH_LIMIT : GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
  }));
  const cancelSuperseded = deps.cancelSuperseded ?? cancelSupersededPendingGradingAuditAtomically;
  const cancelStaleEvidence = deps.cancelStaleEvidence ?? cancelStaleEvidencePendingGradingAuditAtomically;
  const readEvidenceForDispatch = deps.readEvidence ?? readScorecardEvidence;
  const readTasksForCleanup = deps.listTasks ?? listTasks;
  const terminateSupersededTask = deps.killTask ?? killTask;
  const supersededPendingCards = cards
    .filter((card) => card.gradingAudit?.state === 'pending' && card.supersededBy)
    .slice(0, GRADING_AUDIT_DISPATCH_LIMIT);
  await mapWithConcurrency(
    supersededPendingCards,
    GRADING_AUDIT_DISPATCH_CONCURRENCY,
    async (card) => {
      const supersedingIssueId = card.supersededBy;
      if (!supersedingIssueId) return;
      try {
        await cancelSuperseded(card.issueId, supersedingIssueId, workspaceId ? { workspaceId } : {});
      } catch (error) {
        console.warn(
          `[grading-integrity] superseded audit stamp for ${card.issueId} could not be cancelled:`,
          error instanceof Error ? error.message : error,
        );
      }
      if (!workspaceId) return;
      let tasks: Awaited<ReturnType<typeof listTasks>>;
      try {
        tasks = await readTasksForCleanup({
          workspaceId,
          states: ['pending', 'running'],
          labelPrefix: `${GRADING_AUDIT_TASK_LABEL_PREFIX}${card.issueId}`,
          limit: 20,
        });
      } catch (error) {
        console.warn(
          `[grading-integrity] superseded auditor task scan failed for ${card.issueId}:`,
          error instanceof Error ? error.message : error,
        );
        return;
      }
      const exactPrefix = `${GRADING_AUDIT_TASK_LABEL_PREFIX}${card.issueId}`;
      const matchingTasks = tasks.filter((task) => {
        const label = task.detail?.label;
        return typeof label === 'string' && (label === exactPrefix || label.startsWith(`${exactPrefix}:`));
      });
      for (const task of matchingTasks) {
        try {
          const result = await terminateSupersededTask(task.taskId, {
            includeSubtree: true,
            escalateAfterMs: 5_000,
          });
          if (
            !result.ok &&
            result.error !== 'not_live' &&
            result.error !== 'task_not_found' &&
            result.error !== 'already_gone'
          ) {
            console.warn(
              `[grading-integrity] superseded auditor task '${task.taskId}' for ${card.issueId} could not be retired: ${result.error}`,
            );
          }
        } catch (error) {
          console.warn(
            `[grading-integrity] superseded auditor task '${task.taskId}' for ${card.issueId} retirement failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    },
  );
  const liveEvaluatorBuild = (deps.getEvaluatorBuild ?? getBuildInfo)();
  const evaluatorBuildDriftPendingCards = cards.filter((card) => {
    const recorded = recordedEvaluatorBuildForRecipe(card.rerunRecipe);
    return (
      card.gradingAudit?.state === 'pending' &&
      !card.supersededBy &&
      !card.retracted &&
      Boolean(recorded) &&
      (recorded!.sha !== liveEvaluatorBuild.sha || recorded!.version !== liveEvaluatorBuild.version)
    );
  });
  const evaluatorBuildDriftIds = new Set(evaluatorBuildDriftPendingCards.map((card) => card.issueId));
  const evaluatorBuildDriftById = new Map(evaluatorBuildDriftPendingCards.map((card) => [card.issueId, card] as const));
  // A shared sweep sees cards from multiple serving builds. This host's mismatch
  // proves only that it cannot replay the card; it does not invalidate evidence
  // minted by another still-serving evaluator or authorize killing its judge.
  // Current evidence and its lease belong to an exact-build dispatcher. An exact
  // binding retraction is independent of evaluator build, so still inspect it
  // below and let the atomic stale-evidence fence decide whether to cancel.
  // The emit gate still refuses a replay whose actual evaluator build differs.
  const evidenceCandidates = cards
    .filter((card) =>
      card.gradingAudit?.state === 'pending' &&
      hasCitedSpecEvidenceBindings(card) &&
      !card.supersededBy &&
      !card.retracted,
    )
    .sort(oldestFirst)
    .slice(0, GRADING_AUDIT_DISPATCH_LIMIT);
  const evidenceById = new Map<string, ScorecardEvidenceRow>();
  await mapWithConcurrency(
    evidenceCandidates,
    GRADING_AUDIT_DISPATCH_CONCURRENCY,
    async (card) => {
      try {
        const result = await inDispatchWorkspace(() => readEvidenceForDispatch(card.issueId));
        if (result.kind !== 'found' || !scorecardAuditEvidenceMatchesListRow(card, result.scorecard)) return;
        evidenceById.set(card.issueId, result.scorecard);
      } catch (error) {
        console.warn(
          '[grading-integrity] evidence currentness read failed for ' + card.issueId + ':',
          error instanceof Error ? error.message : error,
        );
      }
    },
  );
  const staleEvidencePendingCards = [...evidenceById.values()]
    .filter((card) =>
      card.gradingAudit?.state === 'pending' &&
      card.auditTarget?.current === false &&
      card.auditTarget.evidenceBindingCurrentness?.state !== undefined &&
      card.auditTarget.evidenceBindingCurrentness.state !== 'current' &&
      !card.supersededBy &&
      !card.retracted,
    )
    .slice(0, GRADING_AUDIT_DISPATCH_LIMIT);
  await mapWithConcurrency(
    staleEvidencePendingCards,
    GRADING_AUDIT_DISPATCH_CONCURRENCY,
    async (card) => {
      const bindingIds = card.rerunRecipe?.selection.bindingIds;
      const stampedAt = card.gradingAudit?.stampedAt;
      if (!bindingIds?.length || !stampedAt) return;
      let cancelled = false;
      try {
        cancelled = await cancelStaleEvidence(card.issueId, {
          stampedAt,
          evidenceFingerprint: card.evidenceFingerprint ?? null,
          harnessSlug: card.rerunRecipe?.args.harness ?? null,
          bindingIds,
        }, workspaceId ? { workspaceId } : {});
      } catch (error) {
        console.warn(
          `[grading-integrity] stale-evidence audit stamp for ${card.issueId} could not be cancelled:`,
          error instanceof Error ? error.message : error,
        );
      }
      // The SQL fence can reject a stale read if the recipe or audit was renewed.
      // Only retire work after the cancellation itself committed.
      if (!cancelled) return;
      // A committed cancellation must not be offered as a stranded replay later.
      evaluatorBuildDriftIds.delete(card.issueId);
      evaluatorBuildDriftById.delete(card.issueId);
      if (!workspaceId) return;
      let tasks: Awaited<ReturnType<typeof listTasks>>;
      try {
        tasks = await readTasksForCleanup({
          workspaceId,
          states: ['pending', 'running'],
          labelPrefix: `${GRADING_AUDIT_TASK_LABEL_PREFIX}${card.issueId}`,
          limit: 20,
        });
      } catch (error) {
        console.warn(
          `[grading-integrity] stale-evidence auditor task scan failed for ${card.issueId}:`,
          error instanceof Error ? error.message : error,
        );
        return;
      }
      const exactPrefix = `${GRADING_AUDIT_TASK_LABEL_PREFIX}${card.issueId}`;
      for (const task of tasks) {
        const label = task.detail?.label;
        if (typeof label !== 'string' || (label !== exactPrefix && !label.startsWith(`${exactPrefix}:`))) continue;
        try {
          const result = await terminateSupersededTask(task.taskId, {
            includeSubtree: true,
            escalateAfterMs: 5_000,
          });
          if (
            !result.ok &&
            result.error !== 'not_live' &&
            result.error !== 'task_not_found' &&
            result.error !== 'already_gone'
          ) {
            console.warn(
              `[grading-integrity] stale-evidence auditor task '${task.taskId}' for ${card.issueId} could not be retired: ${result.error}`,
            );
          }
        } catch (error) {
          console.warn(
            `[grading-integrity] stale-evidence auditor task '${task.taskId}' for ${card.issueId} retirement failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    },
  );
  const pendingCards = cards.filter((card) => {
    if (evaluatorBuildDriftIds.has(card.issueId)) return false;
    if (!currentPendingScorecard(card)) return false;
    if (!hasCitedSpecEvidenceBindings(card)) return true;
    return evidenceById.get(card.issueId)?.auditTarget.current === true;
  });
  const pendingById = new Map(pendingCards.map((card) => [card.issueId, card] as const));
  const requestedTargetIds =
    explicitTargetIds.length > 0
      ? explicitTargetIds
      : [...pendingCards, ...evaluatorBuildDriftPendingCards
          .filter((card) => evaluatorBuildDriftIds.has(card.issueId))
          .slice(0, GRADING_AUDIT_DISPATCH_LIMIT)]
          .slice()
          .sort(oldestFirst)
          .slice(0, GRADING_AUDIT_DISPATCH_LIMIT)
          .map((card) => card.issueId);

  /**
   * Is the bounded terminal retry worth ROUTING to the fallback provider?
   *
   * Resolved once per dispatched target and memoised, so the two terminal paths
   * below cannot disagree with each other or double-read the account ledger.
   */
  let fallbackServiceable: Promise<boolean> | null = null;
  const canServeFallback = (): Promise<boolean> => {
    fallbackServiceable ??= (deps.providerCanServe ?? gradingAuditProviderCanServe)(
      GRADING_AUDIT_FALLBACK.agent,
    ).catch(() => true);
    return fallbackServiceable;
  };

  const readLogTail = deps.readLogTail ?? readAcceptanceGraderLogTail;
  const readLogMtimeMs = deps.readLogMtimeMs ?? readAcceptanceGraderLogMtimeMs;
  const readOwnerExecution = deps.fetchGatewayOwnerExecution ?? fetchGatewayOwnerExecution;
  const providerEvidenceSamples = deps.providerEvidenceSamples ?? GRADING_AUDIT_PROVIDER_EVIDENCE_SAMPLES;
  const providerEvidenceDelayMs = deps.providerEvidenceDelayMs ?? GRADING_AUDIT_PROVIDER_EVIDENCE_DELAY_MS;
  const detectTerminalFailure = (
    logPath: string | null,
    maxRechecks = deps.terminalLogMaxRechecks ?? GRADING_AUDIT_TERMINAL_LOG_MAX_RECHECKS,
    allowGatewayErrorWithoutFooter = true,
    nativeProof?: { nativeTranscriptPath: string; nativeSessionId: string; nativeBackend?: 'claude' | 'codex' },
  ) =>
    detectAcceptanceGraderTerminalFailure(logPath, {
      readLogTail,
      ...nativeProof,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      delayMs: deps.terminalLogRecheckDelayMs ?? GRADING_AUDIT_TERMINAL_LOG_RECHECK_DELAY_MS,
      maxRechecks,
      allowStandaloneWeeklyLimit: true,
      allowInferenceGatewayError: true,
      // The controlled grading brief cannot quote provider screens. A retained
      // task still needs its own native session+owner proof before this detector
      // may use the no-footer path.
      allowGatewayErrorWithoutFooter,
      allowLauncherQuotaDrop: true,
      allowLauncherWalledPoolRefusal: true,
      allowLauncherKickoffDrop: true,
      allowToolSurfaceRefusal: true,
      allowGradingAuditRefusal: true,
      detectStartupStall: false,
    });
  const retireProvenTerminalDriftTasks = async (issueId: string) => {
    const retiredTaskIds: string[] = [];
    const codes: GradingAuditRecoveryCode[] = [];
    const errors: string[] = [];
    if (!workspaceId) return { retiredTaskIds, codes, errors };

    const labelPrefix = `${GRADING_AUDIT_TASK_LABEL_PREFIX}${issueId}`;
    let tasks: Awaited<ReturnType<typeof listTasks>>;
    try {
      tasks = await readTasksForCleanup({
        workspaceId,
        states: ['pending', 'running'],
        labelPrefix,
        limit: 10,
      });
    } catch (error) {
      return {
        retiredTaskIds,
        codes,
        errors: [`retained auditor task read failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }

    const matchingTasks = tasks.filter((task) => {
      const label = task.detail?.label;
      return typeof label === 'string' && (label === labelPrefix || label.startsWith(`${labelPrefix}:`));
    });
    for (const task of matchingTasks) {
      const taskLogPath = task.logPath ?? null;
      const taskOwnerId = typeof task.detail?.coordOwnerId === 'string' ? task.detail.coordOwnerId.trim() : '';
      let taskSessionId = typeof task.sessionId === 'string' ? task.sessionId.trim() : '';
      if (!taskSessionId && taskOwnerId) {
        try {
          taskSessionId = (await (deps.bindTaskNativeSession ?? bindAgentSessionTaskToLatestNativeSession)(task.taskId))?.trim() ?? '';
        } catch {
          // Missing binding evidence is unknown, never permission to retire a task.
        }
      }
      if (!taskLogPath || !taskOwnerId || !taskSessionId) continue;

      let nativeSessionBindings: Array<Pick<AdvSessionRow, 'agent' | 'coordOwnerId' | 'sessionId'> & Partial<Pick<AdvSessionRow, 'id'>>>;
      try {
        nativeSessionBindings = await listNativeSessionsByTranscriptHandles([taskSessionId]);
      } catch {
        continue;
      }
      const nativeSession = nativeSessionBindings.find((session) =>
        session.sessionId === taskSessionId && session.coordOwnerId === taskOwnerId &&
        (session.agent === 'claude' || session.agent === 'codex'));
      if (!nativeSession) continue;

      let nativeTranscriptPath: string | null;
      try {
        nativeTranscriptPath = nativeSession.agent === 'claude'
          ? await resolveSessionTranscript(taskSessionId, { owner: taskOwnerId })
          : typeof nativeSession.id === 'number'
            ? await (deps.findCodexRolloutPath ?? findCodexRolloutPathByUuid)(taskSessionId, {
                homeOverride: codexHomeForSessionKey(nativeSession.id),
              })
            : null;
      } catch {
        continue;
      }
      if (!nativeTranscriptPath) continue;

      let terminalFailure: { code: GradingAuditRecoveryCode; evidence: string } | null;
      try {
        terminalFailure = await detectTerminalFailure(taskLogPath, 0, false, {
          nativeTranscriptPath,
          nativeSessionId: taskSessionId,
          ...(nativeSession.agent === 'codex' ? { nativeBackend: 'codex' as const } : {}),
        });
      } catch {
        continue;
      }
      if (!terminalFailure) continue;

      try {
        const result = await terminateSupersededTask(task.taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        if (!result.ok && result.error !== 'not_live' && result.error !== 'task_not_found' && result.error !== 'already_gone') {
          errors.push(`terminal auditor '${task.taskId}' could not be retired: ${result.error}`);
          continue;
        }
      } catch (error) {
        errors.push(`terminal auditor '${task.taskId}' retirement failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      retiredTaskIds.push(task.taskId);
      codes.push(terminalFailure.code);
    }
    return { retiredTaskIds, codes, errors };
  };

  const dispatchTarget = async (issueId: string): Promise<PendingGradingAuditDispatchReceipt> => {
    let phase: GradingAuditDispatchPhase = 'dispatch';
    const markPhase = (next: GradingAuditDispatchPhase) => {
      phase = next;
    };
    const card = pendingById.get(issueId);
    if (!card) {
      if (evaluatorBuildDriftIds.has(issueId)) {
        const driftCard = evaluatorBuildDriftById.get(issueId);
        const cleanup = driftCard ? await retireProvenTerminalDriftTasks(issueId) : { retiredTaskIds: [], codes: [], errors: [] };
        const stranding = driftCard
          ? await assessEvaluatorBuildStrandingAsync(driftCard, liveEvaluatorBuild, {
              nowMs: deps.now?.() ?? Date.now(),
              root: resolveAgentWorkspaceRoot({}),
              probe: deps.generationAncestry,
            })
          : null;
        const reason = stranding?.stranded
          ? stranding.reason
          : 'card requires a dispatcher running the recorded evaluator build; this host skipped it without changing the card or audit lease';
        return {
          issueId,
          ...(driftCard ? { rubricRef: driftCard.rubricRef } : {}),
          state: cleanup.errors.length ? 'failed' : 'skipped',
          reason: [reason, ...cleanup.errors].join('; '),
          ...(stranding?.stranded ? { stranded: stranding } : {}),
          ...(cleanup.retiredTaskIds.length
            ? { terminalRecovery: { retiredTaskIds: cleanup.retiredTaskIds, attempts: 0, codes: cleanup.codes } }
            : {}),
        };
      }
      return {
        issueId,
        state: 'skipped',
        reason: 'target is no longer a current pending standard-rubric scorecard',
      };
    }

    markPhase('rubric-read');
    const rubric = await inDispatchWorkspace(() => resolveRubric(card.rubricRef));
    if (!rubric) {
      return { issueId, rubricRef: card.rubricRef, state: 'skipped', reason: 'target rubric not found' };
    }
    if (rubric.kind !== 'standard') {
      return {
        issueId,
        rubricRef: card.rubricRef,
        state: 'skipped',
        reason: `target rubric kind '${rubric.kind}' is not standard`,
      };
    }

    const suppression = gradingAuditSuppressionForOwnerSet(pausedOwners, card.createdBy);
    if (suppression) {
      return {
        issueId,
        rubricRef: card.rubricRef,
        state: 'skipped',
        reason: describeGradingAuditDispatchSuppression(suppression),
      };
    }

    const idempotencyKey = `grading-audit:${issueId}`;
    const reservationSnapshot = gradingAuditReservationSnapshot(card, evidenceById.get(issueId));
    const harness = input.harness?.trim();
    // EI-23414612968722239: `role:'judge'` is a HARNESS-SCOPED persona — launch-agent
    // refuses it outright ("no harness resolved") when no harness accompanies it, so the
    // auditor never spawns, the stamp sticks at 'pending', and every acceptance rubric it
    // was meant to audit is deadlocked at scorecards:emit. The role and the harness must
    // therefore be gated on ONE condition: when the harness is absent or the '*' wildcard,
    // omit the role and take the standard su collaborator, exactly as that refusal advises.
    // This is strictly worse than not dispatching at all when it fails, because
    // settledGradingAuditIsCurrent() passes an UNSTAMPED card but fails a PENDING one.
    const harnessResolved = Boolean(harness && harness !== '*');
    const retiredTaskIds: string[] = [];
    const terminalCodes: GradingAuditRecoveryCode[] = [];
    let currentIdempotencyKey = idempotencyKey;
    let terminalFallbacks = 0;
    let attempts = 0;
    let reservationHeld = false;
    let reservationReservedAt = 'reservation-unknown';
    let priorReservation: GradingAuditReservationResult['prior'];
    let launchBackend: 'claude' | 'codex' = profile?.agent ?? 'claude';
    let routingFallback: string | undefined;
    let receipt: PendingGradingAuditDispatchReceipt | null = null;
    const generationBound = card.gradedGeneration != null;
    const evaluatorBuildBound = recordedEvaluatorBuildForRecipe(card.rerunRecipe) != null;
    let generationCompatible = false;
    const releaseReservation = async (
      backoff?: GradingAuditDispatchBackoff,
      restore?: GradingAuditReservationResult['prior'],
    ) => {
      if (!reservationHeld) return false;
      reservationHeld = false;
      try {
        return await release(issueId, idempotencyKey, {
          workspaceId: input.ctx.workspaceId,
          reservedAt: reservationReservedAt,
          ...(backoff ? { backoff } : {}),
          ...(restore ? { restore } : {}),
        });
      } catch {
        // The reservation TTL is the durable cleanup fallback if this release
        // cannot reach the database after a launcher failure.
        return false;
      }
    };
    const confirmOwnedPendingReservation = async (): Promise<boolean> => {
      markPhase('reservation-confirm');
      const current = await confirmReservation(issueId, idempotencyKey, {
        workspaceId: input.ctx.workspaceId,
        reservedAt: reservationReservedAt,
        snapshot: reservationSnapshot,
        expectedCard: {
          evidenceFingerprint: card.evidenceFingerprint,
          createdBy: card.createdBy,
          rubricRef: card.rubricRef,
        },
      });
      if (current) return true;
      await releaseReservation();
      receipt = {
        issueId,
        rubricRef: card.rubricRef,
        state: 'skipped',
        idempotencyKey,
        reason: 'target is no longer pending after reservation; dispatch abandoned',
      };
      return false;
    };
    const recoveryFields = () => ({
      ...(routingFallback ? { routingFallback } : {}),
      ...(retiredTaskIds.length
        ? {
            terminalRecovery: {
              retiredTaskIds,
              attempts,
              codes: terminalCodes,
              fallback: profile ?? GRADING_AUDIT_FALLBACK,
              // `fallback` is the CONFIGURED fallback, echoed whether or not the
              // retry used it. `routedTo` is the backend the bounded retry actually
              // launched on — it stays 'claude' when the fallback provider has no
              // serviceable account (WI-10003463), so a reader never mistakes the
              // configured fallback for the route taken.
              routedTo: launchBackend,
            },
          }
        : {}),
    });
    const terminateTask = deps.killTask ?? killTask;
    const readTask = deps.getTask ?? getTask;
    /**
     * EI-22978598482930667: a terminal QUOTA failure is futile to retry until
     * capacity returns, and the recovery instant is knowable — from the account
     * ledger's reset terms, or from the horizon the launcher itself printed in
     * this very log. Record its reset-aware suppression atomically with release.
     */
    const quotaBackoffFor = async (
      failure: { code: GradingAuditRecoveryCode; evidence: string },
      failedLogPath: string | null,
    ): Promise<GradingAuditDispatchBackoff | undefined> => {
      if (failure.code !== 'model_quota_exhausted') return undefined;
      let logTail = '';
      if (failedLogPath) {
        try {
          logTail = await readLogTail(failedLogPath);
        } catch {
          // The evidence string alone still carries the horizon when the
          // launcher refused; an unreadable log must not block the backoff.
        }
      }
      return resolveGradingAuditQuotaBackoff({
        code: failure.code,
        evidence: failure.evidence,
        logTail,
        ...(deps.now ? { nowMs: deps.now() } : {}),
        ...(deps.readProviderResets ? { readProviderResets: deps.readProviderResets } : {}),
      });
    };
    const terminalFailureBackoffFor = async (
      failure: { code: GradingAuditRecoveryCode; evidence: string },
      failedLogPath: string | null,
    ): Promise<GradingAuditDispatchBackoff> => {
      const quotaBackoff = await quotaBackoffFor(failure, failedLogPath);
      if (quotaBackoff) return quotaBackoff;
      return resolveGradingAuditFailureBackoff({
        code: failure.code,
        reason: `terminal ${failure.code}; suppressing re-dispatch for a bounded retry window`,
        ...(deps.now ? { nowMs: deps.now() } : {}),
      });
    };
    const recoveryKeyFor = (taskId: string, failureCode: GradingAuditRecoveryCode): string => {
      const retryIdentity = createHash('sha256')
        // The reservation timestamp is the bounded retry generation. A
        // later 15-minute reservation epoch must not dedupe its one allowed
        // recovery to the previous epoch's already-terminal fallback task.
        .update(
          `${reservationReservedAt}\0` +
            `${currentIdempotencyKey}\0${taskId}\0${failureCode}\0${GRADING_AUDIT_FALLBACK.agent}`,
        )
        .digest('hex')
        .slice(0, 16);
      return `${idempotencyKey}:recovery:${retryIdentity}`;
    };
    try {
      if (generationBound) {
        const gradedGeneration = parseGradedGeneration(card.gradedGeneration);
        markPhase('generation-read');
        const currentGeneration = await (deps.readCurrentGeneration ?? readRunningGeneration)();
        const generationCheck = await assessGenerationAncestryAsync(
          gradedGeneration?.deployedSha,
          currentGeneration.deployedSha,
          resolveAgentWorkspaceRoot({}),
          deps.generationAncestry,
        );
        if (!generationCheck.ok) {
          const reason =
            "grading auditor dispatch for '" + issueId + "' refused: dispatcher build '" +
            (currentGeneration.deployedSha ?? 'unknown') + "' is not proven to be the same as or a descendant of " +
            "graded build '" + (gradedGeneration?.deployedSha ?? 'unknown') + "' (" + generationCheck.reason + "); " +
            'no auditor was routed or launched; no reservation or backoff was changed';
          return { issueId, rubricRef: card.rubricRef, state: 'failed', idempotencyKey, phase, reason };
        }
        generationCompatible = true;
      }

      markPhase('reservation');
      const reservation = await reserve(issueId, idempotencyKey, {
        workspaceId: input.ctx.workspaceId,
        currentness: card.gradingAuditCurrentness,
        snapshot: reservationSnapshot,
        ...(generationCompatible ? { allowGenerationIncompatibleBackoff: true } : {}),
      });
      if (reservation.status !== 'claimed') {
        return {
          issueId,
          rubricRef: card.rubricRef,
          state: 'skipped',
          idempotencyKey,
          reason:
            reservation.status === 'quota-backoff'
              ? `re-dispatch suppressed until ${reservation.backoff?.until} ` +
                `(${reservation.backoff?.source ?? 'unknown'} reset after terminal ${reservation.backoff?.code ?? 'quota failure'})`
              : reservation.status === 'dispatch-backoff'
                ? `re-dispatch suppressed until ${reservation.backoff?.until} after ${reservation.backoff?.code ?? 'dispatch failure'}`
              : reservation.status === 'already-reserved'
                ? 'another dispatcher already reserved this scorecard'
                : 'target is no longer a pending scorecard',
        };
      }
      reservationReservedAt = reservation.reservation?.reservedAt ?? reservationReservedAt;
      priorReservation = reservation.prior;
      reservationHeld = true;
      if (!(await confirmOwnedPendingReservation())) {
        return receipt!;
      }
      /**
       * The reservation is a bounded dispatch lease, not the auditor's
       * identity. Once its TTL expires, a still-running task from the prior
       * lease must win over a new route or launch. The launcher's idempotency
       * receipt can be absent or stale even while the task-manager row remains
       * live, so query the durable task label directly before any fallback
       * side effect.
       */
      markPhase('live-task-read');
      const liveTasks = await readTasks({
        workspaceId: input.ctx.workspaceId,
        states: ['pending', 'running'],
        labelPrefix: idempotencyKey,
        limit: 10,
      });
      // EI-26004619150008295: older headless tasks can retain a null
      // session_id even after their owner has a tracked native transcript.
      // Repair that missing link through the enrollment binder before using
      // native error proof; never infer a transcript from an owner alone.
      for (const task of liveTasks) {
        if (task.sessionId?.trim() || !task.detail?.coordOwnerId) continue;
        try {
          markPhase('task-session-bind');
          const sessionId = await (deps.bindTaskNativeSession ?? bindAgentSessionTaskToLatestNativeSession)(task.taskId);
          if (sessionId?.trim()) task.sessionId = sessionId.trim();
        } catch {
          // An unavailable binder is unknown. Keep log-only checks and dedupe.
        }
      }
      const nativeSessionIds = [...new Set(liveTasks.flatMap((task) => {
        const sessionId = task.sessionId?.trim();
        return sessionId ? [sessionId] : [];
      }))];
      let nativeSessionBindings: Array<Pick<AdvSessionRow, 'agent' | 'coordOwnerId' | 'sessionId'> & Partial<Pick<AdvSessionRow, 'id'>>> = [];
      if (nativeSessionIds.length) {
        try {
          markPhase('native-session-read');
          nativeSessionBindings = await listNativeSessionsByTranscriptHandles(nativeSessionIds);
        } catch {
          // Missing binding evidence is unknown, never proof that a retained task failed.
        }
      }
      const viableLiveTasks = [] as typeof liveTasks;
      for (const task of liveTasks) {
        const taskLogPath = task.logPath ?? null;
        const taskOwnerId = typeof task.detail?.coordOwnerId === 'string' ? task.detail.coordOwnerId.trim() : '';
        const taskSessionId = typeof task.sessionId === 'string' ? task.sessionId.trim() : '';
        const nativeSession = nativeSessionBindings.find((session) =>
          session.sessionId === taskSessionId && session.coordOwnerId === taskOwnerId &&
          (session.agent === 'claude' || session.agent === 'codex'));
        let nativeProof: { nativeTranscriptPath: string; nativeSessionId: string; nativeBackend?: 'claude' | 'codex' } | undefined;
        if (taskOwnerId && taskSessionId && nativeSession) {
          try {
            const nativeTranscriptPath = nativeSession.agent === 'claude'
              ? await resolveSessionTranscript(taskSessionId, { owner: taskOwnerId })
              : typeof nativeSession.id === 'number'
                ? await (deps.findCodexRolloutPath ?? findCodexRolloutPathByUuid)(taskSessionId, {
                    homeOverride: codexHomeForSessionKey(nativeSession.id),
                  })
                : null;
            if (nativeTranscriptPath) nativeProof = { nativeTranscriptPath, nativeSessionId: taskSessionId,
              ...(nativeSession.agent === 'codex' ? { nativeBackend: 'codex' as const } : {}) };
          } catch {
            // The existing log-only classifier remains authoritative when native proof is unavailable.
          }
        }
        // EI-23148617450190529: a headless CLI can return to its interactive
        // prompt after a delayed gateway/quota failure while its PTY and task
        // ledger row stay live. The old guard treated process liveness as mission
        // liveness and deduped forever. This is an OLD task on a later sweep, so
        // one current log read is sufficient; the launch path below retains its
        // bounded startup rechecks for a newly-created task.
        let terminalFailure: { code: GradingAuditRecoveryCode; evidence: string } | null = null;
        if (taskLogPath) {
          try {
            markPhase('task-terminal-detection');
            // A delayed live-task check normally requires Claude's completed-turn
            // footer. If the task ledger's exact native session and owner bind to
            // a Claude adv-session, the shared detector can also prove a completed
            // API error from that session's transcript. The PTY headline alone may
            // now contain scorecard-derived tool output and remains insufficient.
            terminalFailure = await detectTerminalFailure(taskLogPath, 0, false, nativeProof);
          } catch {
            // An unreadable task log cannot prove the mission terminal. Preserve
            // the existing fail-open dedupe until a later sweep can read it.
          }
          if (!terminalFailure) {
            try {
              markPhase('task-log-read');
              const [logTail, logMtimeMs] = await Promise.all([
                readLogTail(taskLogPath),
                Promise.resolve(readLogMtimeMs(taskLogPath)),
              ]);
              const quietWindow = {
                startedAt: task.startedAt,
                logMtimeMs,
                nowMs: deps.now?.() ?? Date.now(),
                staleAfterMs: GRADING_AUDIT_RESERVATION_TTL_MS,
              };
              // WI-10005295: a judge that finished its turn and parked without emitting
              // (for a reason none of the explicit detectors recognise) is otherwise kept
              // viable forever and every repair dedupes to it.
              terminalFailure =
                classifyAcceptanceGraderNoFirstTurnStall(logTail, quietWindow) ??
                classifyAcceptanceGraderParkedWithoutEmit(logTail, quietWindow);
              if (!terminalFailure && isAcceptanceGraderNoFirstTurnLivenessCandidate(logTail, quietWindow)) {
                const ownerId = typeof task.detail?.coordOwnerId === 'string' ? task.detail.coordOwnerId.trim() : '';
                if (ownerId) {
                  try {
                    const resolveOwnerLiveness = deps.resolveOwnerLiveness ?? resolveGradingAuditorOwnerLiveness;
                    terminalFailure = classifyAcceptanceGraderNoFirstTurnStall(
                      logTail,
                      quietWindow,
                      await resolveOwnerLiveness(ownerId),
                    );
                  } catch {
                    // An unavailable liveness oracle is unknown, never permission to kill.
                  }
                }
              }
            } catch {
              // Missing/unreadable evidence is unknown, never permission to kill.
            }
          }
        }
        // A live task whose log only shows the startup UI is not terminal proof. The
        // pre-provider recovery path is allowed only when the exact native session has
        // kickoff/no-response evidence and the same complete provider-queued span survives
        // repeated owner-report reads in the same gateway process generation.
        if (terminalFailure?.code === 'startup_first_turn_stalled') {
          const taskOwnerId = typeof task.detail?.coordOwnerId === 'string' ? task.detail.coordOwnerId.trim() : '';
          const providerStall = taskOwnerId
            ? await proveRetainedProviderAdmissionStall(
                task,
                taskOwnerId,
                priorReservation?.key ?? idempotencyKey,
                priorReservation?.reservedAt ?? reservationReservedAt,
                nativeProof,
                readLogTail,
                readOwnerExecution,
                deps.sleep ?? (async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
                providerEvidenceSamples,
                providerEvidenceDelayMs,
              )
            : false;
          if (!providerStall) terminalFailure = null;
        }
        if (!terminalFailure) {
          const taskOwnerId = typeof task.detail?.coordOwnerId === 'string'
            ? task.detail.coordOwnerId.trim()
            : '';
          if (taskOwnerId) {
            const taskReservation = priorReservation ?? {
              key: idempotencyKey,
              reservedAt: reservationReservedAt,
            };
            try {
              markPhase('source-audit-responder-check');
              const stillCurrentResponder = await (
                deps.isCurrentSourceAuditResponder ?? isCurrentSourceAuditResponder
              )(issueId, taskReservation, taskOwnerId);
              if (!stillCurrentResponder) {
                terminalFailure = {
                  code: 'superseded_source_audit_responder',
                  evidence:
                    `active source-audit consult responder no longer matches retained task owner ` +
                    `'${taskOwnerId}' for reservation '${taskReservation.key}' at '${taskReservation.reservedAt}'`,
                };
              }
            } catch {
              // An unavailable responder lookup is unknown, never proof that a live auditor is stale.
            }
          }
        }
        if (!terminalFailure) {
          viableLiveTasks.push(task);
          continue;
        }
        markPhase('task-termination');
        const killed = await terminateTask(task.taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        if (
          !killed.ok &&
          killed.error !== 'not_live' &&
          killed.error !== 'task_not_found' &&
          killed.error !== 'already_gone'
        ) {
          await releaseReservation(await terminalFailureBackoffFor(terminalFailure, taskLogPath));
          receipt = {
            issueId,
            rubricRef: card.rubricRef,
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            phase,
            reason:
              `live grading auditor '${task.taskId}' ended on ${terminalFailure.code}, but its failed mission ` +
              `could not be retired: ${killed.error}`,
            ...recoveryFields(),
          };
          break;
        }
        retiredTaskIds.push(task.taskId);
        terminalCodes.push(terminalFailure.code);
        if (terminalFallbacks < GRADING_AUDIT_MAX_TERMINAL_FALLBACKS) {
          // Consume the bounded retry either way, so the one-retry ceiling still
          // holds; only ROUTE it to the fallback provider when that provider can
          // measurably serve. Otherwise stay on the primary, whose auto-routed
          // gateway pool may still have headroom.
          terminalFallbacks += 1;
          if (await canServeFallback()) {
            launchBackend = GRADING_AUDIT_FALLBACK.agent;
          }
          currentIdempotencyKey = recoveryKeyFor(task.taskId, terminalFailure.code);
        }
      }
      if (receipt) {
        return receipt;
      }
      if (viableLiveTasks.length > 0) {
        // WI-10005273: hand the row back to the live auditor's own lease. Deleting it (the old
        // behaviour) is what made every audit longer than one TTL unable to emit.
        // EI-25287745234355817: older sweeps may already have deleted that
        // lease. Keep the newly claimed one rather than deleting it AGAIN,
        // and deliver it to the existing independent session (never launch a duplicate).
        const retainedReservation = priorReservation ?? {
          key: idempotencyKey,
          reservedAt: reservationReservedAt,
        };
        const retained = await releaseReservation(undefined, retainedReservation);
        if (!retained) {
          return { issueId, rubricRef: card.rubricRef, state: 'skipped', idempotencyKey,
            reason: 'reservation restore CAS lost; renewal handoff abandoned', ...recoveryFields() };
        }
        // A prior epoch needs no replacement lease, but its retained task still
        // needs the exact lease brief when the dispatcher has reclaimed and
        // restored the row. A parked owner gets the resume wording; every
        // other identified single owner gets the normal renewal notice. An
        // ambiguous or ownerless task remains untouched and fail-closed.
        let resumeParked = false;
        const retainedTask = viableLiveTasks.length === 1 ? viableLiveTasks[0] : undefined;
        const retainedOwnerId = typeof retainedTask?.detail?.coordOwnerId === 'string'
          ? retainedTask.detail.coordOwnerId.trim() : '';
        if (priorReservation && retainedOwnerId) {
          try {
            resumeParked = (await (deps.resolveOwnerLiveness ?? resolveGradingAuditorOwnerLiveness)(retainedOwnerId))
              ?.sessionState === 'parked';
          } catch {
            // An unavailable oracle preserves the retained task and still
            // permits the durable renewal notice below.
          }
        }
        markPhase('retained-auditor-notification');
        const renewalNotification = !priorReservation
          ? viableLiveTasks.length !== 1
              ? { state: 'skipped' as const, reason: 'retained auditor task identity is ambiguous' }
              : await (deps.notifyRetainedAuditor ?? notifyRetainedGradingAuditor)({
                  card, task: viableLiveTasks[0]!, reservation: retainedReservation,
                  workspaceId: input.ctx.workspaceId?.trim() ?? '', ...(harnessResolved ? { harness } : {}),
                })
          : !retainedTask || !retainedOwnerId
            ? undefined
            : await (deps.notifyRetainedAuditor ?? notifyRetainedGradingAuditor)({
                card, task: retainedTask, reservation: retainedReservation,
                workspaceId: input.ctx.workspaceId?.trim() ?? '', ...(harnessResolved ? { harness } : {}),
                ...(resumeParked ? { resumeParked: true } : {}),
              });
        if (renewalNotification?.state === 'failed') {
          // A pre-append failure delivered nothing. Clear only this exact epoch
          // so the next scheduled repair can reissue and retry the handoff.
          // A settlement/new lease winning this CAS remains untouched.
          await release(issueId, idempotencyKey, { workspaceId: input.ctx.workspaceId, reservedAt: retainedReservation.reservedAt });
        }
        receipt = {
          issueId,
          rubricRef: card.rubricRef,
          state: 'deduped',
          idempotencyKey,
          dispatchReservation: retainedReservation,
          ...(renewalNotification ? { renewalNotification } : {}),
          launch: {
            deduped: true,
            opened: 0,
            failed: 0,
            mode: 'live-task-guard',
            tasks: viableLiveTasks.map((task) => ({
              taskId: task.taskId,
              logPath: task.logPath ?? null,
              label: typeof task.detail?.label === 'string' ? task.detail.label : idempotencyKey,
            })),
          },
          reason:
            viableLiveTasks.length === 1
              ? `existing live grading auditor task '${viableLiveTasks[0]?.taskId ?? 'unknown'}' owns ${idempotencyKey}; duplicate launch suppressed`
              : `${viableLiveTasks.length} existing live grading auditor tasks own ${idempotencyKey}; duplicate launch suppressed`,
          ...recoveryFields(),
        };
        return receipt;
      }
      markPhase('source-audit-route');
      const routed = profile || generationBound || evaluatorBuildBound
        ? {
            state: 'fallback' as const,
            reason: profile
              ? 'explicit routine grading profile requires a fresh judge with the pinned model'
              : generationBound
                ? 'generation-bound card requires a fresh judge launched from this compatible dispatcher build'
                : 'evaluator-build-bound card requires a fresh judge launched from this exact evaluator build',
          }
        : await (deps.route ?? routeSourceGradingAudit)(
            {
              card,
              reservationKey: idempotencyKey,
              reservationReservedAt,
              brief: gradingAuditBrief(card, reservationReservedAt),
              ctx: input.ctx,
              ...(harnessResolved ? { harness } : {}),
            },
            {
              confirmReservation: () =>
                confirmReservation(issueId, idempotencyKey, {
                  workspaceId: input.ctx.workspaceId,
                  reservedAt: reservationReservedAt,
                  snapshot: reservationSnapshot,
                  expectedCard: {
                    evidenceFingerprint: card.evidenceFingerprint,
                    createdBy: card.createdBy,
                    rubricRef: card.rubricRef,
                  },
                }),
            },
          );
      if (routed.state === 'reservation-lost') {
        await releaseReservation();
        return {
          issueId,
          rubricRef: card.rubricRef,
          state: 'skipped',
          idempotencyKey,
          reason: routed.reason,
        };
      }
      if (routed.state !== 'fallback') {
        if (!(await confirmOwnedPendingReservation())) return receipt!;
        return {
          issueId,
          rubricRef: card.rubricRef,
          idempotencyKey,
          state: routed.state,
          conversationId: routed.conversationId,
          ...(routed.reason ? { reason: routed.reason } : {}),
          ...recoveryFields(),
        };
      }
      routingFallback = routed.reason;

      for (let attempt = 0; attempt <= GRADING_AUDIT_MAX_TERMINAL_FALLBACKS; attempt += 1) {
        attempts = attempt + 1;
        // Routing can itself create a durable consult and take long enough for
        // another auditor to settle the target. Re-check directly before each
        // external launch as well as before routing; never launch from the stale
        // candidate snapshot after settlement.
        if (!(await confirmOwnedPendingReservation())) break;
        const useFallback = launchBackend === GRADING_AUDIT_FALLBACK.agent;
        const taskDetail = typeof card.evidenceFingerprint === 'string' && card.evidenceFingerprint.trim()
          ? {
              issueId,
              evidenceFingerprint: card.evidenceFingerprint.trim(),
              reservation: { key: idempotencyKey, reservedAt: reservationReservedAt, snapshot: reservationSnapshot },
              reservationSnapshot,
            }
          : null;
        const launchContext = taskDetail
          ? {
              ...gradingAuditorLaunchCtx(input.ctx),
              [INTERNAL_GRADING_AUDIT_TASK_DETAIL]: taskDetail,
            } as GradingAuditLaunchContext
          : gradingAuditorLaunchCtx(input.ctx);
        markPhase('auditor-launch');
        const result = (await launch(
          {
            brief: gradingAuditBrief(card, reservationReservedAt),
            ...(harnessResolved ? { harness } : {}),
            workItem: issueId,
            headless: true,
            // Grading auditors are independent verification sessions. Without
            // this explicit fence, capability:launch-agent inherits the
            // dispatcher's caller fleet and exposes that fleet's unrelated
            // persisted headcount profile in the launch receipt.
            independent: true,
            // EI-24339979200649356: the ancestry check above measured THIS
            // dispatcher's build, so a generation-bound judge must run on it.
            // Without spawn-host binding, launch-agent defaults the judge's
            // MCP to the stable proxy (:9071 → green :3070) — a different,
            // possibly older build — and its terminal emit is then refused
            // grading_audit_generation_incompatible after the launch is paid.
            // An evaluator-build-bound recipe likewise needs this exact host
            // for creation-time replay, even without a deployed generation.
            ...(generationBound || evaluatorBuildBound ? { mcpTarget: 'spawn-host' as const } : {}),
            account: useFallback ? GRADING_AUDIT_FALLBACK.account : GRADING_AUDIT_ACCOUNT,
            ...(useFallback ? { agent: GRADING_AUDIT_FALLBACK.agent } : {}),
            count: 1,
            members: [
              useFallback
                ? {
                    ...(harnessResolved ? { role: 'judge' } : {}),
                    agent: GRADING_AUDIT_FALLBACK.agent,
                    model: GRADING_AUDIT_FALLBACK.model,
                    effort: GRADING_AUDIT_FALLBACK.effort,
                    account: GRADING_AUDIT_FALLBACK.account,
                  }
                : { ...(harnessResolved ? { role: 'judge' } : {}), account: GRADING_AUDIT_ACCOUNT },
            ],
            label: `grading-audit:${issueId}`,
            idempotencyKey: currentIdempotencyKey,
          } as never,
          // Never the caller's context: the caller is often the card author, and
          // a judge it launches is refused as a self-audit (see
          // GRADING_AUDIT_DISPATCH_ACTOR).
          launchContext,
        )) as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
          data?: { deduped?: boolean; launch?: unknown };
        };
        const launchData = result.data?.launch as
          | (NativeTranscriptLaunchReceipt & {
              tasks?: Array<{
                taskId?: unknown;
                logPath?: unknown;
                kickoffProof?: { persisted?: unknown; reason?: unknown; nativeRef?: unknown } | null;
                nativeSession?: { backend?: unknown; sessionId?: unknown } | null;
              }>;
              agentStarted?: boolean | null;
            })
          | undefined;
        const launchedTask = launchData?.tasks?.[0];
        const taskId = typeof launchedTask?.taskId === 'string' ? launchedTask.taskId : null;
        const logPath = typeof launchedTask?.logPath === 'string' ? launchedTask.logPath : null;

        // WI-10002903: the same conclusive-kickoff rule the acceptance grader
        // applies (WI-10002155). A headless judge whose kickoff was never
        // submitted sits at an empty composer, writes no terminal text, and
        // never joins the roster, so the log classifier below cannot see it.
        // Without this check the dispatcher returned state:'launched' and held
        // the reservation for the full TTL while nothing graded the card.
        // Only an explicit `kickoff-not-submitted:*` receipt or observed
        // silence is conclusive; a late native marker with agentStarted:true
        // is a working judge and is left alone.
        const kickoffProof = launchedTask?.kickoffProof;
        const kickoffNotPersisted = !!kickoffProof && kickoffProof.persisted !== true;
        const kickoffNotSubmitted =
          typeof kickoffProof?.reason === 'string' && kickoffProof.reason.startsWith('kickoff-not-submitted:');
        const kickoffFailureIsConclusive =
          kickoffNotPersisted &&
          launchData?.agentStarted !== true &&
          (launchData?.agentStarted === false || kickoffNotSubmitted);

        const nativeProof = nativeTranscriptProofFromLaunchReceipt(launchData, launchBackend);
        let terminalFailure: { code: GradingAuditRecoveryCode; evidence: string } | null = kickoffFailureIsConclusive
          ? {
              code: 'launch_kickoff_not_persisted',
              evidence:
                `launch receipt reported kickoffProof.persisted !== true (` +
                `${typeof kickoffProof?.reason === 'string' && kickoffProof.reason ? kickoffProof.reason : 'reason not reported'}); ` +
                `agentStarted=${String(launchData?.agentStarted ?? 'unreported')}`,
            }
          : logPath
            ? (markPhase('auditor-terminal-detection'), await detectTerminalFailure(logPath, undefined, true, nativeProof))
            : null;

        // A stable launch receipt can outlive the task it represented. Log
        // classifiers cover known quota/auth exits, but an operator reaper or
        // host recycle can end the task without writing any such terminal text.
        // Treat a DEDUPED receipt whose durable task is already gone as a
        // recoverable terminal mission; otherwise the card keeps a reservation
        // while every later sweep "succeeds" by deduping to the same dead task.
        if (!terminalFailure && result.data?.deduped && taskId) {
          markPhase('auditor-task-read');
          const task = await readTask(taskId);
          if (!task || isTerminalState(task.state)) {
            terminalFailure = {
              code: 'task_receipt_not_live',
              evidence: task ? `task ledger state is ${task.state}` : 'task ledger row is absent',
            };
          }
        }

        // EI-24126420100989264: a FRESH launch can return a task id and then
        // exit during psu bootstrap before it returns any kickoffProof. Check
        // the durable task row whenever the launch has no positive start
        // verdict; requiring kickoffNotPersisted here misses that startup path
        // and leaves the reservation held until its TTL. A terminal failed task
        // is conclusive; a running task with agentStarted:null remains unknown.
        if (!terminalFailure && !result.data?.deduped && taskId && launchData?.agentStarted !== true) {
          markPhase('auditor-task-read');
          const freshTask = await readTask(taskId);
          const freshTaskFailed = freshTask && (
            freshTask.state === 'killed' ||
            freshTask.state === 'timed_out' ||
            freshTask.state === 'stranded' ||
            freshTask.state === 'ended_unobserved' ||
            (freshTask.state === 'exited' && freshTask.exitCode != null && freshTask.exitCode !== 0)
          );
          if (freshTaskFailed) {
            terminalFailure = {
              code: 'task_receipt_not_live',
              evidence:
                `fresh launch task is terminal before first-turn confirmation: ` +
                `state=${freshTask.state}, exitCode=${String(freshTask.exitCode ?? 'unreported')}` +
                (freshTask.exitReason ? `, exitReason=${freshTask.exitReason}` : ''),
            };
          }
        }

        if (terminalFailure) {
          if (!taskId) {
            await releaseReservation(await terminalFailureBackoffFor(terminalFailure, logPath));
            receipt = {
              issueId,
              rubricRef: card.rubricRef,
              state: 'failed',
              idempotencyKey: currentIdempotencyKey,
              launch: result.data?.launch,
              phase,
              reason:
                `grading auditor ended on ${terminalFailure.code}, but its launch receipt carried no task id; ` +
                'refusing an untracked fallback',
              ...recoveryFields(),
            };
            break;
          }
          markPhase('task-termination');
          const killed = await terminateTask(taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
          if (
            !killed.ok &&
            killed.error !== 'not_live' &&
            killed.error !== 'task_not_found' &&
            killed.error !== 'already_gone'
          ) {
            await releaseReservation(await terminalFailureBackoffFor(terminalFailure, logPath));
            receipt = {
              issueId,
              rubricRef: card.rubricRef,
              state: 'failed',
              idempotencyKey: currentIdempotencyKey,
              launch: result.data?.launch,
              phase,
              reason:
                `grading auditor '${taskId}' ended on ${terminalFailure.code}, but its failed mission ` +
                `could not be retired: ${killed.error}`,
              ...recoveryFields(),
            };
            break;
          }
          retiredTaskIds.push(taskId);
          terminalCodes.push(terminalFailure.code);
          if (terminalFallbacks >= GRADING_AUDIT_MAX_TERMINAL_FALLBACKS) {
            // One bounded primary/fallback pair is the retry ceiling for this
            // dispatch. Keep every terminal pair behind either its reset-aware
            // quota horizon or the general retry window; otherwise a non-quota
            // API error releases an unbacked card into the next repair sweep.
            const backoff = await terminalFailureBackoffFor(terminalFailure, logPath);
            await releaseReservation(backoff);
            receipt = {
              issueId,
              rubricRef: card.rubricRef,
              state: 'failed',
              idempotencyKey: currentIdempotencyKey,
              launch: result.data?.launch,
              phase,
              reason:
                `grading auditor fallback also ended on ${terminalFailure.code}; ` +
                'the one-retry ceiling stopped another launch' +
                (backoff ? `; re-dispatch suppressed until ${backoff.until} (${backoff.source})` : ''),
              ...recoveryFields(),
            };
            break;
          }
          // Same rule as the live-task terminal path above: the bounded retry is
          // consumed regardless, but it is only ROUTED to the fallback provider
          // when that provider can measurably serve.
          terminalFallbacks += 1;
          if (await canServeFallback()) {
            launchBackend = GRADING_AUDIT_FALLBACK.agent;
          }
          currentIdempotencyKey = recoveryKeyFor(taskId, terminalFailure.code);
          continue;
        }

        if (result.isError) {
          const reason = result.content?.[0]?.text ?? 'grading auditor launch failed';
          // EI-24935954591005579: pool admission can refuse BEFORE any task
          // exists. The task/log terminal recovery above cannot observe that
          // path, so it kept retrying Claude forever even with a usable Codex
          // pool. Reuse the one bounded gateway fallback only when the launcher
          // explicitly proves zero opened processes and no durable tasks.
          const failedLaunch = result.data?.launch as {
            opened?: number; failed?: number; tasks?: unknown[]; partial?: boolean;
          } | undefined;
          const noPrimaryAccount =
            /no allowed claude account is available in the pool/i.test(reason);
          if (noPrimaryAccount && launchBackend === 'claude' &&
              failedLaunch?.opened === 0 && (failedLaunch.failed ?? 0) > 0 &&
              failedLaunch.partial === false && Array.isArray(failedLaunch.tasks) &&
              failedLaunch.tasks.length === 0 &&
              terminalFallbacks < GRADING_AUDIT_MAX_TERMINAL_FALLBACKS &&
              await canServeFallback()) {
            terminalFallbacks += 1;
            launchBackend = GRADING_AUDIT_FALLBACK.agent;
            currentIdempotencyKey = recoveryKeyFor('confirmed-zero-process-pool-refusal', 'task_receipt_not_live');
            continue;
          }
          await releaseReservation(
            resolveGradingAuditFailureBackoff({
              code: 'launch_failed',
              reason,
              ...(deps.now ? { nowMs: deps.now() } : {}),
            }),
          );
          console.warn(`[grading-integrity] pending audit dispatch failed for ${issueId}: ${reason}`);
          receipt = {
            issueId,
            rubricRef: card.rubricRef,
            state: 'failed',
            idempotencyKey: currentIdempotencyKey,
            launch: result.data?.launch,
            phase,
            reason,
            ...recoveryFields(),
          };
        } else {
          receipt = {
            issueId,
            rubricRef: card.rubricRef,
            state: result.data?.deduped ? 'deduped' : 'launched',
            idempotencyKey: currentIdempotencyKey,
            launch: result.data?.launch,
            ...recoveryFields(),
          };
        }
        break;
      }

      return (
        receipt ?? {
          issueId,
          rubricRef: card.rubricRef,
          state: 'failed',
          idempotencyKey: currentIdempotencyKey,
          phase,
          reason: 'grading auditor terminal recovery exhausted without a receipt',
          ...recoveryFields(),
        }
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await releaseReservation(
        resolveGradingAuditFailureBackoff({
          code: 'dispatch_exception',
          reason,
          ...(deps.now ? { nowMs: deps.now() } : {}),
        }),
      );
      console.warn(`[grading-integrity] pending audit dispatch failed for ${issueId}: ${reason}`);
      return {
        issueId,
        rubricRef: card.rubricRef,
        state: 'failed',
        idempotencyKey: currentIdempotencyKey,
        phase,
        reason,
        ...recoveryFields(),
      };
    }
  };

  const receipts = await mapWithConcurrency(
    requestedTargetIds,
    GRADING_AUDIT_DISPATCH_CONCURRENCY,
    dispatchTarget,
  );

  return { requestedTargetIds, receipts };
}

/**
 * Periodic repair entry point for the pending-audit queue. A completion refusal
 * is the normal trigger for the first dispatch, but the launched judge can learn
 * about a quota/auth failure after that short startup probe has ended. Re-running
 * the same bounded, idempotency-keyed dispatcher lets it inspect the old task's
 * now-terminal log and take the existing safe retirement/fallback path. Keep this
 * as a named wrapper so a routine can own the clock without duplicating dispatch
 * rules or creating a second launch surface.
 */
export async function reconcilePendingGradingAudits(
  input: DispatchPendingGradingAuditsInput,
  deps: DispatchPendingGradingAuditsDeps = {},
): Promise<PendingGradingAuditDispatchResult> {
  await retireSettledGradingAuditTasks(input, deps);
  const result = await dispatchPendingGradingAudits(input, deps);
  const recertifications =
    input.recertifyStranded === false ? [] : await recertifyStrandedSpecAdequacyCards(input, result.receipts, deps);
  return recertifications.length > 0 ? { ...result, recertifications } : result;
}

async function defaultRecertifyStranded(
  call: StrandedRecertifyCall,
  ctx: GradingAuditLaunchContext,
): Promise<Record<string, unknown>> {
  // Lazy: certify-spec-clauses imports this module, so a static import would be a cycle.
  const { default: certifyTool } = await import('./agent-tools/plans/certify-spec-clauses');
  const args = certifyTool.args.parse(call.args);
  const reply = (await certifyTool.handler(args, ctx as never)) as { data?: Record<string, unknown> } | undefined;
  return reply?.data ?? {};
}

function describeRecertifyReply(
  issueId: string,
  call: StrandedRecertifyCall,
  reply: Record<string, unknown>,
): StrandedRecertifyReceipt {
  const clauses = Array.isArray(reply.clauses) ? (reply.clauses as Array<Record<string, unknown>>) : [];
  for (const clause of clauses) {
    const superseded = clause.strandedSuperseded as { issueId?: unknown } | undefined;
    const card = clause.card as { status?: unknown; issueId?: unknown } | undefined;
    if (superseded?.issueId === issueId && card?.status === 'filed' && typeof card.issueId === 'string') {
      return {
        issueId,
        state: 'recertified',
        reason: `re-certified on this build: ${card.issueId} supersedes ${issueId} and is audited on this build`,
        call,
        supersededBy: card.issueId,
        ...(reply.counts !== undefined ? { counts: reply.counts } : {}),
      };
    }
  }
  const evaluator = reply.evaluator as { error?: unknown; code?: unknown } | undefined;
  const outcome = evaluator
    ? `the evaluator refused (${String(evaluator.code ?? evaluator.error ?? 'no error given')})`
    : clauses.length > 0
      ? `no clause superseded it (${clauses
          .map((clause) => {
            const card = clause.card as { status?: unknown; code?: unknown } | undefined;
            return `${String(clause.specId)}: ${String(card?.status)}${card?.code ? ` ${String(card.code)}` : ''}`;
          })
          .join('; ')})`
      : 'certification returned no clauses';
  return {
    issueId,
    state: 'not-recertified',
    reason:
      `${outcome}. The card stays stranded; the sweep retries it after ` +
      `${GRADING_AUDIT_STRANDED_AFTER_MS / 60_000} quiet minutes, or run ${call.tool} by hand.`,
    call,
    ...(reply.counts !== undefined ? { counts: reply.counts } : {}),
  };
}

/**
 * WI-6554700010013275 — re-grade stranded spec-test-adequacy cards on the live build.
 *
 * EI-25965998744903219 made the dispatcher NAME a stranded card's remedy; this pass RUNS
 * it, so a card that no exact-build host will ever audit stops needing a human to read the
 * receipt. For each stranded receipt carrying a recertify call (at most
 * STRANDED_RECERTIFY_LIMIT, one at a time):
 *   1. claim the card's audit lease. The claim is atomic, so two sweeping hosts cannot both
 *      re-certify one card; a held or backed-off lease means another dispatcher owns it;
 *   2. release the lease at once. certify-spec-clauses supersedes a card only while it has
 *      no live lease, and the release records the claim as lastDispatchReservation, which
 *      restarts the stranding clock. That is the per-card dedup: a failed attempt is not
 *      retried until the card has been quiet for GRADING_AUDIT_STRANDED_AFTER_MS again;
 *   3. run plans:certify-spec-clauses. It files a new card on this build and supersedes
 *      the stranded one through its own WI-6554700010008541 path.
 * Every outcome is reported, and none of them throws out of the reconcile pass.
 */
async function recertifyStrandedSpecAdequacyCards(
  input: DispatchPendingGradingAuditsInput,
  receipts: readonly PendingGradingAuditDispatchReceipt[],
  deps: DispatchPendingGradingAuditsDeps,
): Promise<StrandedRecertifyReceipt[]> {
  const candidates = receipts
    .filter((receipt) => receipt.stranded?.recertify)
    .slice(0, STRANDED_RECERTIFY_LIMIT);
  if (candidates.length === 0) return [];
  const workspaceId = input.ctx.workspaceId?.trim() || null;
  const reserve = deps.reserve ?? reservePendingGradingAudit;
  const release = deps.release ?? releasePendingGradingAudit;
  const recertify = deps.recertifyStranded ?? defaultRecertifyStranded;
  const results: StrandedRecertifyReceipt[] = [];
  for (const receipt of candidates) {
    const issueId = receipt.issueId;
    const call = receipt.stranded!.recertify!;
    const key = `${STRANDED_RECERTIFY_KEY_PREFIX}${issueId}`;
    try {
      // The stranded receipt is produced only after this dispatcher has proven that
      // the live build descends from the card's recorded evaluator build. A prior
      // exact-build dispatcher can therefore leave a generation-incompatible
      // backoff behind; this compatible re-certification pass must be allowed to
      // clear that legacy stamp or the recovery path deadlocks until the retry
      // window expires (EI-26032900751635017).
      const claim = await reserve(issueId, key, {
        workspaceId,
        now: new Date(deps.now?.() ?? Date.now()),
        allowGenerationIncompatibleBackoff: true,
      });
      if (claim.status !== 'claimed' || !claim.reservation) {
        results.push({
          issueId,
          state: 'deduped',
          reason: `audit lease not claimable (${claim.status}); another dispatcher owns this card`,
          call,
        });
        continue;
      }
      const released = await release(issueId, key, { workspaceId, reservedAt: claim.reservation.reservedAt });
      if (!released) {
        results.push({
          issueId,
          state: 'failed',
          reason: 'the re-certification lease could not be released, so certification would refuse to supersede the card',
          call,
        });
        continue;
      }
      results.push(describeRecertifyReply(issueId, call, await recertify(call, input.ctx)));
    } catch (error) {
      results.push({
        issueId,
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        call,
      });
    }
  }
  return results;
}

/**
 * A grading auditor is a one-shot headless task. Once its target's audit has
 * settled, the headless launcher still keeps the session alive for inbox wakes.
 * Reconcile those tasks from the existing audit sweep instead of relying on a
 * human or a session-side shutdown request (headless tasks have no terminal to
 * close). The start/audit timestamps protect a newer re-audit launched after a
 * previously settled verdict, and the grace period lets the final emit response
 * return before the task is retired. A cancelled target has no valid audit
 * mission, so its tasks can be retired immediately, including late launches.
 */
async function retireSettledGradingAuditTasks(
  input: DispatchPendingGradingAuditsInput,
  deps: DispatchPendingGradingAuditsDeps,
): Promise<void> {
  const workspaceId = input.ctx.workspaceId?.trim();
  if (!workspaceId) return;

  const readTasks = deps.listTasks ?? listTasks;
  let liveTasks: Awaited<ReturnType<typeof listTasks>>;
  try {
    liveTasks = await readTasks({
      workspaceId,
      states: ['pending', 'running'],
      launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
      labelPrefix: GRADING_AUDIT_TASK_LABEL_PREFIX,
      limit: 2_000,
    });
  } catch (error) {
    console.warn(
      '[grading-integrity] settled auditor task scan failed:',
      error instanceof Error ? error.message : error,
    );
    return;
  }

  const issueIds = [
    ...new Set(
      liveTasks.flatMap((task) => {
        const label = task.detail?.label;
        if (typeof label !== 'string' || !label.startsWith(GRADING_AUDIT_TASK_LABEL_PREFIX)) return [];
        const issueId = label.slice(GRADING_AUDIT_TASK_LABEL_PREFIX.length);
        return issueId.startsWith('EI-') || issueId.startsWith('WI-') ? [issueId] : [];
      }),
    ),
  ];
  if (issueIds.length === 0) return;

  const readCards = deps.listScorecards ?? listScorecards;
  const cards: ScorecardRow[] = [];
  try {
    // listScorecards has a 500-row ceiling; exact-id pages keep the live task
    // scan complete without widening any historical scorecard read.
    for (let offset = 0; offset < issueIds.length; offset += 500) {
      const pageIds = issueIds.slice(offset, offset + 500);
      cards.push(
        ...(await readCards({
          includeSuperseded: true,
          includeRetracted: true,
          issueIds: pageIds,
          limit: pageIds.length,
        })),
      );
    }
  } catch (error) {
    console.warn(
      '[grading-integrity] settled auditor scorecard read failed:',
      error instanceof Error ? error.message : error,
    );
    return;
  }

  const cardById = new Map(cards.map((card) => [card.issueId, card] as const));
  const nowMs = deps.now?.() ?? Date.now();
  const settledTasks = liveTasks.flatMap((task) => {
    const label = task.detail?.label;
    if (typeof label !== 'string' || !label.startsWith(GRADING_AUDIT_TASK_LABEL_PREFIX)) return [];
    const issueId = label.slice(GRADING_AUDIT_TASK_LABEL_PREFIX.length);
    const audit = cardById.get(issueId)?.gradingAudit;
    if (audit?.state === 'cancelled') {
      // Cancellation fences emission independently of the task's start time.
      // The original audit stamp is only the retirement queue's ordering key.
      const auditedAtMs = Date.parse(audit.stampedAt);
      return Number.isFinite(auditedAtMs) ? [{ task, issueId, auditedAtMs }] : [];
    }
    if (!audit || (audit.state !== 'passed' && audit.state !== 'failed') || !audit.auditedAt) return [];
    const auditedAtMs = Date.parse(audit.auditedAt);
    const startedAtMs = Date.parse(task.startedAt);
    if (
      !Number.isFinite(auditedAtMs) ||
      !Number.isFinite(startedAtMs) ||
      nowMs - auditedAtMs < GRADING_AUDIT_TERMINAL_TASK_REAP_GRACE_MS ||
      startedAtMs > auditedAtMs
    ) {
      return [];
    }
    return [{ task, issueId, auditedAtMs }];
  });
  const oldestSettledTasks = settledTasks
    .sort((a, b) => a.auditedAtMs - b.auditedAtMs || a.task.taskId.localeCompare(b.task.taskId))
    .slice(0, GRADING_AUDIT_DISPATCH_LIMIT);
  if (oldestSettledTasks.length === 0) return;

  const terminateTask = deps.killTask ?? killTask;
  const retired = await mapWithConcurrency(
    oldestSettledTasks,
    GRADING_AUDIT_DISPATCH_CONCURRENCY,
    async ({ task, issueId }) => {
      try {
        const result = await terminateTask(task.taskId, { includeSubtree: true, escalateAfterMs: 5_000 });
        if (
          result.ok ||
          result.error === 'not_live' ||
          result.error === 'task_not_found' ||
          result.error === 'already_gone'
        ) {
          return task.taskId;
        }
        console.warn(
          `[grading-integrity] settled auditor task '${task.taskId}' for ${issueId} could not be retired: ${result.error}`,
        );
      } catch (error) {
        console.warn(
          `[grading-integrity] settled auditor task '${task.taskId}' for ${issueId} retirement failed:`,
          error instanceof Error ? error.message : error,
        );
      }
      return null;
    },
  );
  const retiredTaskIds = retired.filter((taskId): taskId is string => typeof taskId === 'string');
  if (retiredTaskIds.length > 0) {
    console.info(`[grading-integrity] retired ${retiredTaskIds.length} settled auditor task(s): ${retiredTaskIds.join(', ')}`);
  }
}

/** P-013 write-side gate. Fail-soft to OFF (no stamp — pre-P-013 behavior) when flag
 *  infra is unavailable: early boot and unit tests must never lose a scorecard over
 *  an audit annotation. */
export async function gradingAuditGateEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    return await getFlag(FLAGS.GRADING_INTEGRITY_AUDIT_GATE, 'system');
  } catch {
    return false;
  }
}

/**
 * Pure: does THIS emit need the audit-pending stamp?
 * - standard-kind rubrics only: acceptance cards already carry their own
 *   grader ≠ author gate (plan-acceptance-gate), and auditing them here would be a
 *   second independent guard colliding with the first.
 * - terminal only (not provisional): an interim is a working note (D-004 bound 2).
 * - never the audit card itself (D-004 bound 1 — one level, no regress).
 */
export function needsGradingAudit(input: {
  rubricKind: string | undefined;
  rubricRef: string;
  provisional: boolean;
}): boolean {
  return input.rubricKind === 'standard' && !input.provisional && input.rubricRef !== GRADING_INTEGRITY_RUBRIC_REF;
}
