/**
 * consult-dispatch.ts — how a consult reaches an expert's KNOWLEDGE without ever
 * messaging a live agent (plan consult-expert-routing-2026-09-22, P-003).
 *
 * [owner 2026-09-22] "lets stop directing messages to live agents. I don't want
 * to distract them. Instead lets always fork the session or convert to a new
 * session (cross-model we cant fork)" (D-002), over a ranked allowlist of models
 * allowed to answer (D-004), walking past a walled account until one launches
 * (R-6).
 *
 * WHAT REPLACES WHAT. This module retires TWO older behaviours at once:
 *   - the directed ping + wake of a LIVE selectee (`GetFeedbackDeps.reach` bound
 *     to notifyAgents) — the distraction the owner asked us to stop; and
 *   - revive-responder's resume-IN-PLACE of a dead expert, which re-animated the
 *     expert's ORIGINAL identity.
 * Both collapse into one path, which is the point of D-002: dead and live
 * experts are now handled identically, so there is no liveness branch left to
 * get wrong, no per-responder load cap to tune, and no woken-but-silent case.
 *
 * THE WALK (D-009's source-adapter follow-up, WI-10002749):
 *   1. Current tracked Claude source, Claude rank → FORK.
 *   2. Every other supported Claude/Codex/OMP pair, including historical
 *      evidence and same-backend native sources → CONVERT via the maintained
 *      session port, with a preparation-bound independent answering owner.
 * The source keeps its coordination identity and claims, including when live.
 * Both paths require exact tracked source evidence; an older native incarnation
 * must still belong to that source owner. Unsupported or untracked sources are
 * recorded skips, and the walk continues.
 *
 * FAILURE IS A STEP, NOT A STOP. Every skip/failure reason is recorded on the
 * attempt and the walk continues; only an exhausted list is terminal
 * (`no_available_responder`). That is what makes "Claude is walled but Codex is
 * available" self-healing rather than an owner-visible stall.
 *
 * Reuses the launch-agent building blocks verbatim (resolveResumeTarget /
 * buildAgentLaunchCommand / buildConsoleEnvelope / spawnHeadless /
 * verifyResumeStarted) so dispatch cannot drift from the one audited launch
 * path — including the P-002 `targetAgent` conversion contract.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Sql } from 'postgres';
import { evidenceIncarnationOwnedBy } from '../session-port/source';
import type { SessionPortEvidenceSpan } from '../session-port/service';
import {
  buildAgentLaunchCommand,
  injectLaunchedByArg,
  resolveResumeTarget,
  verifyResumeStarted,
  type ResumeTarget,
} from '../agent-launch-core';
import {
  bucketTokensAgainstOwnerLimit,
  fetchContextPressure,
} from '../agent-tools/coordination/context-pressure';
import { tokensFromFileSize } from '../compaction-usage';
import { codexModelIdFromSpec, codexServiceableForModel } from '../model-context-budget.mjs';
import { portStatusAllowsResume } from '../resumable-port-status';
import {
  analyzeClaudeResumeTranscriptFile,
  type ClaudeResumeTranscriptAnalysis,
} from '../claude-resume-tool-references.mjs';
import { buildConsoleEnvelope } from '../console-launcher';
import { spawnHeadless, type SpawnChildExit } from '../console-spawn';
import { resolveSpawnHostOperatorBaseUrl } from '../mcp-base-url';
import { hostname } from 'node:os';
import { papercuspPathForWorkspace } from '../papercusp-root';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { analyzeCodexRolloutFile, type CodexRolloutOverflowAnalysis } from '../events/await/codex-rollout-overflow';
import {
  resolveExpertModelAllowlist,
  normalizeExpertModelAllowlist,
  type AllowedExpertModel,
  type ExpertBackend,
  type ExpertModelAllowlistDeps,
} from './expert-model-allowlist';
import type { ConsultReviewerModel } from './get-feedback-core';
import { ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY, RUBRIC_VETTING_POLICY } from './selection-policies';
import { consultResponderVerbMenu } from './responder-verb-menu';
import { captureNativeConsultBoundary, nativePlanClaimRequirementMismatch, nativeConsultConstraintsSchema, type NativeConsultConstraints, type NativeConsultSourceObservation } from './native-consult';

/** How long the dispatcher waits for the answering session's pty host to
 * register before reporting verified:null (booting). Same budget and same
 * three-state contract as the retired reviver: the consult sits on the
 * requester's critical path, and null is an honest "still booting", never a
 * failure — the cascade expiry guards the reply. */
export const DISPATCH_VERIFY_TIMEOUT_MS = 15_000;

/**
 * How long after its kickoff lands a Claude fork gets to write its first reply
 * before the dispatch stops waiting to judge it (WI-10004645). A provider
 * "Tool reference … not found" 400 is a request-validation failure, so it lands
 * within seconds of the kickoff (measured: 2s and 8s). The bound is measured
 * from the kickoff, so it overlaps the host verification wait rather than
 * adding to it. Expiry keeps the dispatch: no reply yet is not a rejection.
 */
export const FIRST_TURN_WAIT_MS = 20_000;
/** Re-read interval for that wait; the analyzer caches by size + mtime. */
export const FIRST_TURN_POLL_MS = 500;

/**
 * How the answering session gets the expert's knowledge.
 *
 * - `fork`: a same-backend branch of the tracked expert session (full history).
 * - `convert`: the session port carries the exact evidence span across backends.
 * - `brief`: consult-backed-parking-2026-10-12 P-002 / D-008. For a source the
 *   session port skips ON PURPOSE (an untracked native session, a non-plain-SU
 *   source, an unsupported source backend), a FRESH session is launched under its
 *   own identity and briefed with the expert's cited transcript turns as quoted
 *   evidence. It is never presented as transcript continuity.
 */
export type DispatchOperation = 'fork' | 'convert' | 'brief';

/** A cited transcript turn quoted into a `brief` launch. */
export interface CitedTranscriptTurn {
  turn_idx: number;
  speaker: string;
  ts: string | null;
  text: string;
}

/** Plan-level skips that D-008 keeps intentional, and that a `brief` launch covers. */
export const BRIEF_FALLBACK_REASONS: ReadonlySet<DispatchSkipReason> = new Set<DispatchSkipReason>([
  'source-session-untracked',
  'conversion-unavailable',
]);

/** Per-turn and total caps on the quoted evidence a `brief` kickoff carries. */
export const BRIEF_TURN_TEXT_MAX = 4_000;
export const BRIEF_TOTAL_TEXT_MAX = 24_000;
/** Leave room for provenance and cited turns below native single-message limits. */
const CONSULT_INLINE_REQUEST_MAX = 64_000;

/** Render cited turns as the quoted-evidence block of a `brief` kickoff. */
export function renderCitedTurnsBlock(
  source: { ownerId: string; sessionId: string },
  turns: readonly CitedTranscriptTurn[],
): string {
  const lines: string[] = [];
  let total = 0;
  for (const turn of [...turns].sort((a, b) => a.turn_idx - b.turn_idx)) {
    const text = turn.text.length > BRIEF_TURN_TEXT_MAX ? `${turn.text.slice(0, BRIEF_TURN_TEXT_MAX)}…` : turn.text;
    if (total + text.length > BRIEF_TOTAL_TEXT_MAX && lines.length > 0) {
      lines.push(`[… further cited turns omitted at the ${BRIEF_TOTAL_TEXT_MAX}-character brief cap]`);
      break;
    }
    total += text.length;
    lines.push(`--- ${source.sessionId}#${turn.turn_idx} · ${turn.speaker}${turn.ts ? ` · ${turn.ts}` : ''}\n${text}`);
  }
  return (
    `CITED TRANSCRIPT TURNS — quoted from ${source.ownerId}'s session ${source.sessionId}. ` +
    `These are EVIDENCE you were handed, NOT your own history: you did not take these turns ` +
    `and you are not that session.\n\n${lines.join('\n\n')}`
  );
}

export interface ConsultDispatchEvidenceRef {
  session_id: string;
  turn_idx: number;
  ts?: string | null;
  sim?: number;
  lexicalRank?: number;
}

export interface ConsultEvidenceSource {
  sessionId: string;
  evidence: ConsultDispatchEvidenceRef[];
}

/** A candidate can have evidence across several native sessions. A fork or
 * session port has one source transcript, so choose the session with the
 * strongest measured hit and retain only that session's exact refs. */
export function selectConsultEvidenceSource(
  refs: readonly ConsultDispatchEvidenceRef[] | undefined,
): ConsultEvidenceSource | null {
  return rankConsultEvidenceSources(refs)[0] ?? null;
}

/**
 * Every evidence session, best first, in the order {@link selectConsultEvidenceSource}
 * takes its head from.
 *
 * EI-24833606853730057: one turn is routinely indexed under SEVERAL native session ids.
 * A consult fork's seed copy, and every fork/carry descendant after it, replays its
 * source's history with the same `ts` and `turn_idx`, so a candidate's evidence ties
 * across sessions owned by DIFFERENT agents and the session-id tie-break picks one of
 * them arbitrarily. Measured on two rubric-vetting consults: every walk took a foreign
 * seed copy (`0b0ccf95…` over the expert's own `1010aec4…`) and was refused on
 * ownership before any launch, so the whole menu ended `no_qualified_responder`. The
 * dispatcher therefore walks this list and takes the first session that resolves to the
 * candidate itself.
 */
export function rankConsultEvidenceSources(
  refs: readonly ConsultDispatchEvidenceRef[] | undefined,
): ConsultEvidenceSource[] {
  const groups = new Map<string, ConsultDispatchEvidenceRef[]>();
  for (const ref of refs ?? []) {
    if (!ref || typeof ref.session_id !== 'string' || !ref.session_id.trim() ||
        !Number.isSafeInteger(ref.turn_idx) || ref.turn_idx < 0) continue;
    const group = groups.get(ref.session_id) ?? [];
    group.push(ref);
    groups.set(ref.session_id, group);
  }
  const score = (ref: ConsultDispatchEvidenceRef) =>
    Number.isFinite(ref.lexicalRank) ? ref.lexicalRank! : Number.isFinite(ref.sim) ? ref.sim! : 0;
  const ranked = [...groups.entries()].sort(([sessionA, a], [sessionB, b]) => {
    const bestA = Math.max(...a.map(score));
    const bestB = Math.max(...b.map(score));
    return bestB - bestA || b.length - a.length || sessionA.localeCompare(sessionB);
  });
  return ranked.map(([sessionId, evidence]) => ({
    sessionId,
    evidence: [...evidence].sort((a, b) => a.turn_idx - b.turn_idx),
  }));
}

type ResolvedResumeTarget = Extract<Awaited<ReturnType<typeof resolveResumeTarget>>, { ok: true }>;

/**
 * Resolve the session a consult dispatch launches from (EI-24833606853730057).
 *
 * With evidence, each ranked evidence session is resolved in turn and the first one
 * whose native session and coord owner both match the candidate wins. A foreign seed
 * copy that merely tied on the measured hit is skipped instead of refusing the expert.
 * Only when NO evidence session belongs to the candidate is the walk refused, and the
 * refusal names every session tried so the walk record shows why.
 */
export async function resolveDispatchSource(
  opts: { sourceOwnerId: string; evidence?: readonly ConsultDispatchEvidenceRef[]; nativeConsult?: NativeConsultConstraints },
  d: Pick<ConsultDispatchDeps, 'resolveResumeTarget'>,
): Promise<{ target: ResolvedResumeTarget; evidenceSource: ConsultEvidenceSource | null } | { refusal: string }> {
  const sources = rankConsultEvidenceSources(opts.evidence);
  if (sources.length === 0) {
    if (opts.nativeConsult) return { refusal: 'native consult requires exact evidence session refs; owner fallback is forbidden' };
    const target = await d.resolveResumeTarget({ agentId: opts.sourceOwnerId });
    return target.ok ? { target, evidenceSource: null } : { refusal: `source session unresolvable: ${target.detail}` };
  }
  const rejected: string[] = [];
  for (const source of sources) {
    const target = await d.resolveResumeTarget({ sessionId: source.sessionId });
    if (!target.ok) {
      rejected.push(`source session unresolvable: ${target.detail}`);
    } else if (target.sessionId !== source.sessionId) {
      rejected.push(
        `evidence session mismatch: requested ${source.sessionId}, resolved ${target.sessionId ?? 'no native session'}`,
      );
    } else if (target.ownerId !== opts.sourceOwnerId) {
      rejected.push(
        `evidence session ownership changed: ${source.sessionId} resolves to ${target.ownerId ?? 'no owner'}, ` +
          `expected ${opts.sourceOwnerId}`,
      );
    } else {
      if (opts.nativeConsult) {
        const mismatch = nativeSourceMismatch(target, opts.nativeConsult);
        if (mismatch) {
          rejected.push(`${source.sessionId}: ${mismatch}`);
          continue;
        }
      }
      return { target, evidenceSource: source };
    }
  }
  return {
    refusal: rejected.length === 1
      ? rejected[0]!
      : `no evidence session resolves to ${opts.sourceOwnerId} (${rejected.length} tried): ${rejected.join('; ')}`,
  };
}

function nativeSourceState(target: ResolvedResumeTarget): 'live' | 'ended' | 'unknown' {
  return target.live === true ? 'live' : target.live === false && target.endedAt ? 'ended' : 'unknown';
}

function nativeSourceMismatch(target: ResolvedResumeTarget, constraint: NativeConsultConstraints): string | null {
  const backend = target.agent === 'claude-code' ? 'claude' : target.agent;
  if (backend !== constraint.sourceBackend) return `source backend ${backend ?? 'unknown'} differs from ${constraint.sourceBackend}`;
  const state = nativeSourceState(target);
  return state === constraint.sourceState ? null : `source state ${state} differs from ${constraint.sourceState}`;
}

/** The routing filter and dispatch walk resolve the same exact evidence/owner seam. */
export async function observeNativeConsultSource(
  candidate: { ownerId: string; evidence: ConsultDispatchEvidenceRef[] }, constraint: NativeConsultConstraints,
  deps: Pick<ConsultDispatchDeps, 'resolveResumeTarget'> = { resolveResumeTarget },
  workspaceId?: string,
): Promise<NativeConsultSourceObservation> {
  const base = { ownerId: candidate.ownerId, evidenceSessions: rankConsultEvidenceSources(candidate.evidence).map(s => s.sessionId) };
  try {
    const resolved = await resolveDispatchSource({ sourceOwnerId: candidate.ownerId, evidence: candidate.evidence, nativeConsult: constraint }, deps);
    if (!('refusal' in resolved) && workspaceId) {
      const before = await captureNativeConsultBoundary(resolved.target, workspaceId);
      if (before.status === 'unknown') {
        return { ...base, sessionId: resolved.target.sessionId, backend: resolved.target.agent,
          state: nativeSourceState(resolved.target), eligible: false,
          reason: `source boundary unmeasured: ${before.reason}`, before };
      }
      const mismatch = nativePlanClaimRequirementMismatch(before, constraint);
      if (mismatch) return { ...base, sessionId: resolved.target.sessionId, backend: resolved.target.agent,
        state: nativeSourceState(resolved.target), eligible: false, reason: mismatch, before };
      return { ...base, sessionId: resolved.target.sessionId, backend: resolved.target.agent,
        state: nativeSourceState(resolved.target), eligible: true,
        reason: 'exact source matched and pre-dispatch boundary measured', before };
    }
    if (constraint.requireSourcePlanClaims && !('refusal' in resolved)) {
      return { ...base, sessionId: resolved.target.sessionId, backend: resolved.target.agent,
        state: nativeSourceState(resolved.target), eligible: false, reason: 'required source plan leases were not measured' };
    }
    return 'refusal' in resolved
      ? { ...base, sessionId: null, backend: null, state: 'unknown', eligible: false, reason: resolved.refusal }
      : { ...base, sessionId: resolved.target.sessionId, backend: resolved.target.agent,
          state: nativeSourceState(resolved.target), eligible: true, reason: 'exact native session, owner, backend and state matched' };
  } catch (error) {
    return { ...base, sessionId: null, backend: null, state: 'unknown', eligible: false, reason: `source resolution unavailable: ${String(error)}` };
  }
}

/**
 * Why a rank did not produce the answering session. Machine-readable because the
 * requester's hint, the routing snapshot and the P-009 census all need to tell
 * "every allowed model was walled" apart from "this expert cannot be reached at
 * all" — they call for different action and used to be one undifferentiated
 * failure.
 */
export type DispatchSkipReason =
  | 'fork-unsupported'
  | 'conversion-unavailable'
  | 'source-session-untracked'
  | 'convert-needs-live-source-identity'
  | 'account-walled'
  | 'account-routing-unavailable'
  | 'source-context-critical'
  | 'source-transcript-poisoned'
  | 'evidence-span-unavailable'
  | 'launch-failed'
  | 'kickoff-not-persisted'
  | 'launch-exited'
  | 'first-turn-rejected'
  | 'first-turn-provider-error'
  | 'answering-owner-stamp-failed'
  | 'kickoff-expiry-refresh-failed'
  | 'approval-ineligible'
  | 'consult-closed';

export interface ConsultDispatchAttempt {
  rank: number;
  agent: ExpertBackend;
  model: string;
  /** null when the rank was unreachable before any operation could be chosen. */
  operation: DispatchOperation | null;
  outcome: 'dispatched' | 'skipped' | 'failed';
  reason?: DispatchSkipReason;
  accountRoute?: ConsultAccountRoute;
  accountRouteReason?: string;
  detail: string;
  /**
   * The launcher's own words for a spawned rank that did not survive, read from
   * its launch log (e.g. psu's "refusing unmanaged fork …"). `reason` says only
   * which dispatcher check failed; this says why psu or the CLI gave up.
   * Absent when the log holds no recognisable failure line.
   */
  launchError?: string;
  /** The durable launch log used to identify a failed spawned rank. */
  launchLogPath?: string;
  /**
   * Set on a `dispatched` rank whose first reply had not landed when the
   * first-turn window closed (EI-27111739698817170). It names what the consult
   * expiry sweep re-reads to judge that reply later, with the same classifier.
   */
  firstTurnUnjudged?: FirstTurnUnjudged;
  /** Keep observing an unanswered session after an interim assistant message. */
  answeringTurn?: FirstTurnUnjudged;
}

/**
 * A dispatched answering session whose first reply was not judged inside
 * {@link FIRST_TURN_WAIT_MS}. A provider refusal can land later than that — a
 * Codex convert's model_not_found arrived ~48s after its launch — so the expiry
 * sweep re-judges it (see {@link rejudgeFirstTurn}).
 */
export interface FirstTurnUnjudged {
  agent: 'claude' | 'codex';
  /** The kickoff proof's native transcript (Claude JSONL or Codex rollout). */
  transcriptPath: string;
  /** The log for this exact successful launch, used when a provider refusal never reaches the native transcript. */
  launchLogPath?: string;
  /** When the kickoff receipt was seen; bounds how long the sweep re-judges. */
  kickoffAt: string;
}

export interface ConsultDispatchResult {
  dispatched: boolean;
  /** Native target capacity is independent of the selected source transcript. */
  targetCapacityUnavailable?: string;
  /**
   * The coord identity that will ANSWER — what the consult row must record as
   * its responder, so the answering session's first `consult:reply` has a
   * participant gate to pass.
   *
   * Both FORK and CONVERT use an independent, freshly pre-pinned answering id.
   * CONVERT ports the source's evidence into that isolated session; it does
   * not transfer the source's coordination identity or claims.
   * Either way the caller writes what it is TOLD, never what it assumed.
   */
  answeringOwnerId: string | null;
  operation: DispatchOperation | null;
  agent: ExpertBackend | null;
  model: string | null;
  /** Three-state, as the launch verifier: true = a live host registered; null =
   * still booting (NOT a failure); false = the launch did not survive. */
  verified: boolean | null;
  detail: string;
  /** Every rank considered, in walk order — the evidence for the verdict. */
  attempts: ConsultDispatchAttempt[];
}

export interface ConsultDispatchContext {
  workspaceId: string;
  /** Harness slug for the console envelope; null ⇒ the workspace home checkout. */
  harnessSlug: string | null;
  /** The requester's coord id — `--launched-by` provenance on the launch. */
  launchedBy: string | null;
  /** Trusted accepting runtime; recovery must not replace it with its own build. */
  launchOperatorBaseUrl?: string;
  launchOperatorHost?: string;
}

export interface BackendAvailability {
  available: boolean;
  detail: string;
  accountRoute?: ConsultAccountRoute;
  routeReason?: string;
  failureReason?: 'account-walled' | 'account-routing-unavailable';
}

export type ConsultAccountRoute = 'auto' | 'default';

export interface ConsultAccountRoutingProbe {
  gatewayOn: boolean | null;
  poolAccountCount: number | null;
  poolHasHeadroom: boolean | null;
}

/** Pure launch-route decision, shared by the live pool probe and its tests. */
export function resolveConsultBackendAvailability(
  provider: 'claude' | 'codex',
  probe: ConsultAccountRoutingProbe,
): BackendAvailability {
  if (probe.gatewayOn === false) {
    const routeReason = provider + ' inference gateway is disabled';
    return {
      available: true,
      accountRoute: 'default',
      routeReason,
      detail: routeReason + '; selecting the system/CLI login route',
    };
  }
  if (probe.gatewayOn !== true || probe.poolAccountCount === null ||
      !Number.isSafeInteger(probe.poolAccountCount) || probe.poolAccountCount < 0) {
    const routeReason = provider + ' account-routing preflight could not confirm gateway and pool state';
    return {
      available: false,
      failureReason: 'account-routing-unavailable',
      routeReason,
      detail: routeReason + '; automatic launch was not attempted',
    };
  }
  if (probe.poolAccountCount === 0) {
    const routeReason = provider + ' provider pool is empty';
    return {
      available: true,
      accountRoute: 'default',
      routeReason,
      detail: routeReason + '; selecting the system/CLI login route',
    };
  }
  if (probe.poolHasHeadroom !== true && probe.poolHasHeadroom !== false) {
    const routeReason = provider + ' provider-pool headroom could not be measured';
    return {
      available: false,
      failureReason: 'account-routing-unavailable',
      routeReason,
      detail: routeReason + '; automatic launch was not attempted',
    };
  }
  if (!probe.poolHasHeadroom) {
    const routeReason = 'every ' + provider + ' provider account reads full or paused';
    return {
      available: false,
      accountRoute: 'auto',
      failureReason: 'account-walled',
      routeReason,
      detail: routeReason + '; automatic launch was not attempted',
    };
  }
  return {
    available: true,
    accountRoute: 'auto',
    detail: provider + ' pool has headroom (' + probe.poolAccountCount + ' account(s))',
  };
}

/** The gateway `/stats` fields the psu launcher refuses a Codex auto-route launch on. */
export interface CodexGatewayPoolStats {
  codexHealthyAccounts?: unknown;
  codexTotalAccounts?: unknown;
  codexEarliestRecoveryAt?: unknown;
  codexUnserviceableCause?: unknown;
  /** Serviceable accounts that accept each model with a live refusal (WI-6554700010029748). */
  codexServiceableByModel?: unknown;
}

export interface CodexGatewayLaunchRefusal {
  failureReason: 'account-walled' | 'account-routing-unavailable';
  routeReason: string;
  recoveryAt: number | null;
}

/**
 * Would the psu launcher REFUSE a Codex auto-route launch on these gateway stats?
 *
 * The local account-pool view (`anyAccountAvailable`) cannot see the gateway's own
 * exclusions (credential quarantine, upstream reachability, other routing
 * restrictions), so it read "headroom" while every launched convert died at boot
 * with "REFUSING TO LAUNCH — Codex auto-route has no serviceable accounts"
 * (WI-6554700010029514). This answers from the SAME snapshot the launcher refuses
 * on, so the router skips a rank the launcher would refuse instead of burning a
 * spawn and recording an avoidable launch failure. It mirrors only the launcher's
 * `refuse` outcomes of `codexAutoPoolVerdict` (warn/proceed both launch); the parity
 * test pins it to that function so the two predicates cannot drift again.
 */
/** The first-turn fields the dispatcher judges an answering session by, for every agent. */
type FirstTurnAnalysis = NonNullable<ReturnType<ConsultDispatchDeps['analyzeClaudeTranscript']>>;

/**
 * Map a Codex rollout analysis onto the first-turn fields Claude ranks are judged
 * by (WI-6554700010029533). The kickoff proof is persisted before the check runs,
 * so the newest `task_started` is the answering session's own kickoff turn. Until
 * that turn ends there is no reply yet. A usage limit is an account wall, an
 * overflow is a context-limit rejection and any other error is a transient
 * provider error. A first turn aborted before producing any output never
 * answered: a headless answer session gets no further prompt, so it is judged as
 * a transient provider error too (WI-6554700010030363). A clean ending, or an
 * aborted turn that did produce output, is a reply, and the dispatch stands.
 */
export function codexFirstTurnAnalysis(analysis: CodexRolloutOverflowAnalysis | null): FirstTurnAnalysis | null {
  if (!analysis) return null;
  const silentAbort = analysis.currentTurnOutcome === 'aborted' && !analysis.currentTurnProducedOutput;
  const outcome = silentAbort ? 'error' : analysis.currentTurnOutcome;
  const evidence = silentAbort
    ? 'first turn was aborted (turn_aborted) before producing any output'
    : analysis.currentTurnErrorEvidence;
  return {
    assistantTurnsSinceLastPrompt: outcome === null ? 0 : 1,
    trailingAccountWallTurns: outcome === 'usage-limit' ? 1 : 0,
    lastAccountWallEvidence: outcome === 'usage-limit' ? evidence : null,
    trailingContextLimitTurns: outcome === 'context-overflow' ? 1 : 0,
    lastContextLimitEvidence: outcome === 'context-overflow' ? evidence : null,
    trailingMissingToolReferenceTurns: 0,
    lastMissingToolReferenceName: null,
    trailingProviderErrorTurns: outcome === 'error' ? 1 : 0,
    lastProviderErrorEvidence: outcome === 'error' ? evidence : null,
  };
}

/** A first reply that makes an answering session dead on arrival. */
export interface FirstTurnRejection {
  turns: number;
  tool: string | null;
  contextEvidence?: string;
  accountEvidence?: string;
  providerEvidence?: string;
}

/**
 * The ONE first-turn classifier (EI-27111739698817170). The dispatcher's bounded
 * first-turn poll and the expiry sweep's later re-judge both call it, so a reply
 * that lands after {@link FIRST_TURN_WAIT_MS} is judged by exactly the rule a
 * reply inside the window would have been. Null while there is no reply yet, or
 * when the reply is not a rejection.
 */
export function firstTurnRejection(analysis: FirstTurnAnalysis): FirstTurnRejection | null {
  if (analysis.assistantTurnsSinceLastPrompt <= 0) return null;
  if ((analysis.trailingAccountWallTurns ?? 0) > 0) {
    return {
      turns: analysis.trailingAccountWallTurns!, tool: null,
      accountEvidence: analysis.lastAccountWallEvidence ?? 'provider billing rejection',
    };
  }
  if ((analysis.trailingContextLimitTurns ?? 0) > 0) {
    return {
      turns: analysis.trailingContextLimitTurns!,
      tool: null,
      contextEvidence: analysis.lastContextLimitEvidence ?? 'Prompt is too long',
    };
  }
  if (analysis.trailingMissingToolReferenceTurns > 0) {
    return {
      turns: analysis.trailingMissingToolReferenceTurns,
      tool: analysis.lastMissingToolReferenceName,
    };
  }
  if ((analysis.trailingProviderErrorTurns ?? 0) > 0) {
    // WI-6554700010018146: a transient provider failure ("API Error: Server
    // error mid-response…") is a synthetic assistant record, so it read as the
    // answerer's first reply and the session parked with no answer, no retry
    // and no cascade. The fault is the provider's, not the responder's.
    return {
      turns: analysis.trailingProviderErrorTurns!,
      tool: null,
      providerEvidence: analysis.lastProviderErrorEvidence ?? 'provider error',
    };
  }
  return null;
}

/** Map a parsed terminal launch-log failure onto the same rejection categories as the transcript classifier. */
function firstTurnRejectionFromLaunchLog(reason: string | null): FirstTurnRejection | null {
  const evidence = reason?.trim();
  if (!evidence) return null;
  const nativeFailure = evidence.match(
    /^(\[psu\] native-turn-failed agent=(?:claude|codex) code=[A-Za-z0-9_.-]{1,120} retryable=false retryAfterMs=(?:unknown|\d+))(?: · \[papercusp\] initial terminal command exited with status \d+)?$/i,
  );
  if (nativeFailure) {
    return { turns: 1, tool: null, providerEvidence: nativeFailure[1] };
  }
  if (/(?:\b429\b|rate.?limit|(?:session|weekly|usage) limit|quota|credit)/i.test(evidence)) {
    return { turns: 1, tool: null, accountEvidence: evidence };
  }
  if (/Context limit reached|Prompt is too long/i.test(evidence)) {
    return { turns: 1, tool: null, contextEvidence: evidence };
  }
  const missingTool = evidence.match(/Tool reference (\S+) not found/i);
  if (missingTool) return { turns: 1, tool: missingTool[1] ?? null };
  if (/^API Error:/i.test(evidence)) {
    return { turns: 1, tool: null, providerEvidence: evidence };
  }
  return null;
}

/** The attempt reason a {@link FirstTurnRejection} records. */
export function firstTurnRejectionReason(
  rejection: FirstTurnRejection,
): 'account-walled' | 'first-turn-provider-error' | 'first-turn-rejected' {
  // Billing cannot poison the expert's transcript or other ranks: reuse the
  // existing account-wall disposition.
  return rejection.accountEvidence
    ? 'account-walled'
    : rejection.providerEvidence ? 'first-turn-provider-error' : 'first-turn-rejected';
}

/**
 * "its first reply was …" — the evidence clause both judges record. The
 * dispatcher's poll calls a provider error transient because it relaunches the
 * rank once on it; the sweep cannot relaunch, so it names the error plainly.
 */
export function describeFirstTurnRejection(
  rejection: FirstTurnRejection,
  providerErrorLabel: 'provider error' | 'transient provider error' = 'provider error',
): string {
  return (rejection.accountEvidence
    ? `its first reply was a provider account rejection (${rejection.accountEvidence})`
    : rejection.providerEvidence
    ? `its first reply was a ${providerErrorLabel} (${rejection.providerEvidence})`
    : rejection.contextEvidence
    ? `its first reply was a provider context-limit rejection (${rejection.contextEvidence})`
    : `its first reply was a provider "Tool reference not found" rejection`) +
    (rejection.tool ? ` ('${rejection.tool}')` : '');
}

/** Read one answering session's native transcript into first-turn fields; null when unreadable. */
function readFirstTurnAnalysis(
  agent: 'claude' | 'codex',
  transcriptPath: string,
  read: Pick<ConsultDispatchDeps, 'analyzeClaudeTranscript' | 'analyzeCodexRollout'>,
): FirstTurnAnalysis | null {
  try {
    return agent === 'codex'
      ? codexFirstTurnAnalysis(read.analyzeCodexRollout(transcriptPath))
      : read.analyzeClaudeTranscript(transcriptPath);
  } catch {
    return null;
  }
}

/** What a later re-judge of an unjudged first turn found. */
export type FirstTurnRejudge =
  | { status: 'rejected'; rejection: FirstTurnRejection; reason: ReturnType<typeof firstTurnRejectionReason>; evidence: string }
  | { status: 'replied' }
  | { status: 'pending' }
  | { status: 'unreadable' };

/**
 * Re-judge a dispatched session's first reply after the dispatcher's window
 * closed (EI-27111739698817170). Same reader and same classifier as the
 * dispatcher's poll; only the time differs. `pending` (no reply yet),
 * `replied` (a reply that is not a rejection) and `unreadable` are never
 * evidence of a rejection.
 */
export async function rejudgeFirstTurn(
  unjudged: Pick<FirstTurnUnjudged, 'agent' | 'transcriptPath' | 'launchLogPath'>,
  read: Pick<ConsultDispatchDeps, 'analyzeClaudeTranscript' | 'analyzeCodexRollout' | 'readLaunchLogReason'> = {
    analyzeClaudeTranscript: analyzeClaudeResumeTranscriptFile,
    analyzeCodexRollout: analyzeCodexRolloutFile,
    readLaunchLogReason: defaultReadLaunchLogReason,
  },
): Promise<FirstTurnRejudge> {
  const analysis = readFirstTurnAnalysis(unjudged.agent, unjudged.transcriptPath, read);
  if (!analysis) return { status: 'unreadable' };
  if (analysis.assistantTurnsSinceLastPrompt > 0) {
    const rejection = firstTurnRejection(analysis);
    if (!rejection) return { status: 'replied' };
    return {
      status: 'rejected',
      rejection,
      reason: firstTurnRejectionReason(rejection),
      evidence: `${describeFirstTurnRejection(rejection)} in ${unjudged.transcriptPath}`,
    };
  }

  // Preserve a real first-turn reply over any launcher text. Only consult this
  // exact attempt's log when the native transcript still has no reply.
  let launchLogReason: string | null = null;
  if (unjudged.launchLogPath) {
    try {
      launchLogReason = await read.readLaunchLogReason(unjudged.launchLogPath);
    } catch {
      return { status: 'pending' };
    }
  }
  const rejection = firstTurnRejectionFromLaunchLog(launchLogReason);
  if (!rejection) return { status: 'pending' };
  return {
    status: 'rejected',
    rejection,
    reason: firstTurnRejectionReason(rejection),
    evidence: `the dispatched launch log reported a provider rejection (${launchLogReason})`,
  };
}

export function codexGatewayLaunchRefusal(
  stats: CodexGatewayPoolStats | null | undefined,
  now: number,
  model?: string | null,
): CodexGatewayLaunchRefusal | null {
  if (!stats || typeof stats !== 'object') return null;
  const healthy = stats.codexHealthyAccounts;
  const total = stats.codexTotalAccounts;
  // WI-6554700010030413: the provider-wide count is model-blind. The launcher also
  // refuses when every serviceable account refuses the requested model, so a rank
  // whose model has a measured zero is walled before any launch is paid for. The
  // model id is resolved by the launcher's own helper, aliases included.
  const modelId = codexModelIdFromSpec(model);
  if (modelId && typeof healthy === 'number' && Number.isInteger(healthy) && healthy > 0 &&
      codexServiceableForModel(stats.codexServiceableByModel, modelId) === 0) {
    return {
      failureReason: 'account-walled',
      routeReason: 'codex gateway can route to ' + healthy + ' account(s), but every one refuses model ' +
        modelId + ' (gateway /stats codexServiceableByModel)',
      recoveryAt: null,
    };
  }
  const hasRecovery = Object.prototype.hasOwnProperty.call(stats, 'codexEarliestRecoveryAt');
  const raw = stats.codexEarliestRecoveryAt;
  // Speak only from the complete stats contract, exactly as the launcher does:
  // an incomplete or legacy snapshot is unknown, never a wall.
  if (healthy !== 0 || typeof total !== 'number' || !Number.isInteger(total) || total <= 0 || !hasRecovery ||
      (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw)))) return null;
  const count = '0 of ' + total;
  if (stats.codexUnserviceableCause === 'upstream-unreachable') {
    return {
      failureReason: 'account-routing-unavailable',
      routeReason: 'codex gateway reports fresh upstream transport failures across accounts (' + count + ' serviceable)',
      recoveryAt: null,
    };
  }
  const recovery = typeof raw === 'number' ? raw : null;
  if (stats.codexUnserviceableCause === 'temporary-cooldown') return null;
  // A recovery horizon already in the past is a possibly-stale snapshot: the launcher launches.
  if (recovery !== null && recovery <= now) return null;
  return {
    failureReason: 'account-walled',
    routeReason: 'codex gateway reports no serviceable accounts (' + count + ')' +
      (recovery !== null ? '; earliest recovery ' + new Date(recovery).toISOString() : ''),
    recoveryAt: recovery,
  };
}

/** Read the live gateway's `/stats`; undefined (fail-open, like the launcher) on any failure. */
export async function readCodexGatewayPoolStats(fetchImpl: typeof fetch = fetch): Promise<CodexGatewayPoolStats | undefined> {
  const base = 'http://127.0.0.1:' + (Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788);
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(1_000) : undefined;
    const res = await fetchImpl(base + '/stats', signal ? { signal } : undefined);
    if (!res.ok) return undefined;
    const body = await res.json() as unknown;
    return body && typeof body === 'object' ? body as CodexGatewayPoolStats : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Narrow an available Codex auto-route verdict by the gateway's own launch refusal.
 * Pure over its inputs so the production probe and its tests share one decision.
 */
export function applyCodexGatewayRefusal(
  verdict: BackendAvailability,
  provider: 'claude' | 'codex',
  stats: CodexGatewayPoolStats | null | undefined,
  now: number,
  model?: string | null,
): BackendAvailability {
  if (provider !== 'codex' || !verdict.available || verdict.accountRoute !== 'auto') return verdict;
  const refusal = codexGatewayLaunchRefusal(stats, now, model);
  if (!refusal) return verdict;
  return {
    available: false,
    accountRoute: 'auto',
    failureReason: refusal.failureReason,
    routeReason: refusal.routeReason,
    detail: refusal.routeReason + '; automatic launch was not attempted because the launcher would refuse it',
  };
}

/** Read-only consult row lock held only until the answering OS child exists. */
export interface ConsultSpawnLease {
  release: () => Promise<void>;
}

/** Injectable seams — unit tests pass fakes; production omits (real impls). */
export interface ConsultDispatchDeps extends ExpertModelAllowlistDeps {
  captureNativeBoundary?: typeof captureNativeConsultBoundary;
  /** Test seam for the saved per-review model, read again on every cascade leg. */
  readReviewerModel?: (workspaceId: string, conversationId: string) => Promise<ConsultReviewerModel | null>;
  readDispatchChoice?: (workspaceId: string, conversationId: string) => Promise<{
    reviewerModel: ConsultReviewerModel | null; nativeConsult: NativeConsultConstraints | null;
    methodReview?: { rubricId: string; applierId: string };
    launchOperatorBaseUrl?: string;
    launchOperatorHost?: string;
  }>;
  checkApprover?: typeof import('../rubrics').checkAcceptanceBarApproverEligibility;
  /** Re-read the consult before launching a reviewer; cascades can race closure. */
  isConsultOpen: (workspaceId: string, conversationId: string) => Promise<boolean>;
  /** Hold the consult row against terminal close until the OS child exists. */
  reserveConsultSpawnLease: (workspaceId: string, conversationId: string) => Promise<ConsultSpawnLease | null>;
  resolveResumeTarget: typeof resolveResumeTarget;
  /** Reuse the port route's exact backend/owner guard for an older incarnation. */
  checkEvidenceIncarnationOwnedBy: (target: ResumeTarget, sessionId: string) => Promise<boolean>;
  checkResumeTranscript: (
    target: ResumeTarget,
  ) => Promise<{ available: boolean; detail: string; transcriptPath?: string }>;
  /** Port-only role/graph/exact-span preflight; native fork ranks stay intact. */
  checkPortTranscript: (
    target: ResumeTarget,
    transcript: { available: boolean; detail: string; transcriptPath?: string },
    evidenceSpan: SessionPortEvidenceSpan,
  ) => Promise<BackendAvailability>;
  /**
   * Read a Claude transcript's tail for provider "Tool reference … not found"
   * rejections (WI-10004260). Used twice: on the SOURCE before forking it (a
   * fork replays the source history, so a source whose latest assistant output
   * is such a rejection yields a fork that fails the same way), and on the
   * answering session's own transcript after its kickoff lands (a first turn
   * that is such a rejection is a dead responder, not a dispatch). Returns
   * null when unreadable.
   */
  analyzeClaudeTranscript: (
    transcriptPath: string,
  ) => Pick<
    ClaudeResumeTranscriptAnalysis,
    'trailingMissingToolReferenceTurns' | 'lastMissingToolReferenceName' | 'assistantTurnsSinceLastPrompt' |
    'trailingContextLimitTurns' | 'lastContextLimitEvidence' |
    'trailingAccountWallTurns' | 'lastAccountWallEvidence' |
    'trailingProviderErrorTurns' | 'lastProviderErrorEvidence'
  > | null;
  /**
   * Read a Codex answering session's rollout (its kickoff proof's native ref) so
   * its first turn is judged like a Claude rank's (WI-6554700010029533). Null when
   * unreadable.
   */
  analyzeCodexRollout: (rolloutPath: string) => CodexRolloutOverflowAnalysis | null;
  /** Wait seam for the first-turn poll (WI-10004645); tests resolve it at once. */
  sleepMs: (ms: number) => Promise<void>;
  buildAgentLaunchCommand: typeof buildAgentLaunchCommand;
  injectLaunchedByArg: typeof injectLaunchedByArg;
  buildConsoleEnvelope: typeof buildConsoleEnvelope;
  spawnHeadless: typeof spawnHeadless;
  verifyResumeStarted: typeof verifyResumeStarted;
  fetchContextPressure: typeof fetchContextPressure;
  /** WI-10004888: the canonical transcript estimator, applied to the fork SOURCE transcript. */
  estimateTranscriptTokens: (transcriptPath: string) => Promise<number | null>;
  /** WI-10004888: bucket that estimate against the source owner's own compaction limit. */
  bucketTranscriptPressure: typeof bucketTokensAgainstOwnerLimit;
  /** Is there budget to run this backend at all right now? (D-004 walls.) */
  /** `model` is the rank's launch spec; omitted, the probe answers provider-wide. */
  probeBackendAvailable: (agent: ExpertBackend, workspaceId: string, model?: string | null) => Promise<BackendAvailability>;
  mintOwnerId: () => string;
  /**
   * Stop a session this rank SPAWNED but then failed (EI-24106882795589775).
   * Returns a short outcome for the attempt record; never throws.
   *
   * `neverRan` is passed ONLY when the rank failed before its host could run a
   * turn (kickoff not persisted, or the child died before host registration).
   * The stop then also closes that answering identity's open adv_sessions row
   * as `ended_by='cleanup'` (WI-10006690). A launcher killed during boot never
   * learns its own row id, so it cannot report its end, and the row otherwise
   * read as an open session until the idle reaper noticed it ~25-35 min later.
   */
  stopFailedLaunch: (
    taskId: string | null | undefined,
    neverRan?: { answeringOwnerId: string },
  ) => Promise<string>;
  /**
   * The failure line a spawned rank's launch log ends on, or null. Never throws.
   * (WI-10003197: psu refusals were visible only by grepping fleet-logs.)
   */
  readLaunchLogReason: (logPath: string | null | undefined) => Promise<string | null>;
  /**
   * Persist this dispatch walk on its consult row. Best-effort: the dispatcher
   * swallows a throw, because losing the record must never cost the dispatch.
   */
  recordDispatchAttempts: (record: ConsultDispatchRecordInput) => Promise<void>;
  /**
   * The source's persisted dispatch walks since `sinceIso`, for the cool-down
   * (WI-10003198). A throw fails OPEN: the cool-down only prevents repeat
   * launches, so losing it must never block a dispatch.
   */
  readSourceDispatchRecords: (
    workspaceId: string,
    sourceOwnerId: string,
    sinceIso: string,
  ) => Promise<PersistedDispatchRecord[]>;
  /** Clock seam for the cool-down. */
  nowMs: () => number;
  /**
   * P-002 / D-008: the text of the expert's cited turns, for a `brief` launch.
   * Reads the session_turns index, then the session archive. An empty result
   * means there is nothing to brief from, which the walk records per rank.
   */
  readCitedTurns: (
    workspaceId: string,
    sessionId: string,
    turnIndices: readonly number[],
  ) => Promise<CitedTranscriptTurn[]>;
}

/** Match the router's admitted corpus without reading another tenant's turns.
 * Keep duplicate rows visible: the dispatcher rejects ambiguous citations. */
export async function readIndexedConsultCitedTurns(
  sql: Sql,
  workspaceId: string,
  sessionId: string,
  turnIndices: readonly number[],
): Promise<CitedTranscriptTurn[]> {
  const wanted = [...new Set(turnIndices)].filter((i) => Number.isSafeInteger(i) && i >= 0);
  if (wanted.length === 0) return [];
  const rows = await sql<{ turn_idx: number; speaker: string; ts: Date | string | null; text: string }[]>`
    SELECT turn_idx, speaker, ts, text FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND session_id = ${sessionId} AND turn_idx = ANY(${wanted}::int[])
     ORDER BY turn_idx`;
  return rows.map((r) => ({
    turn_idx: r.turn_idx,
    speaker: r.speaker,
    ts: r.ts == null ? null : new Date(r.ts).toISOString(),
    text: r.text ?? '',
  }));
}

async function defaultReadCitedTurns(
  workspaceId: string,
  sessionId: string,
  turnIndices: readonly number[],
): Promise<CitedTranscriptTurn[]> {
  const wanted = [...new Set(turnIndices)].filter((i) => Number.isSafeInteger(i) && i >= 0);
  if (wanted.length === 0) return [];
  const { getOrgPg } = await import('@papercusp/db-org');
  const rows = await readIndexedConsultCitedTurns(getOrgPg().sql as unknown as Sql, workspaceId, sessionId, wanted);
  if (rows.length > 0) return rows.filter((t) => t.text.trim());
  const { readArchivedSessionTurns } = await import('../session-archive-read');
  const archived = await readArchivedSessionTurns(sessionId, undefined, undefined, { turnIndices: wanted });
  return (archived?.turns ?? []).map((t) => ({ turn_idx: t.turn_idx, speaker: t.speaker, ts: t.ts, text: t.text }))
    .filter((t) => t.text.trim());
}

/** What {@link ConsultDispatchDeps.recordDispatchAttempts} persists for one walk. */
export interface ConsultDispatchRecordInput {
  workspaceId: string;
  conversationId: string;
  sourceOwnerId: string;
  result: ConsultDispatchResult;
}

/** Newest dispatch records kept on `consult_state.dispatch_attempts` (migration 1225). */
export const DISPATCH_RECORDS_MAX = 24;
/** Per-string bound inside a persisted record — a pointer, never a log copy. */
export const DISPATCH_RECORD_TEXT_MAX = 600;

const clip = (s: string, max = DISPATCH_RECORD_TEXT_MAX): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

/** The persisted shape of one dispatch walk (bounded strings, stamped time). */
export function dispatchRecordEntry(input: ConsultDispatchRecordInput, nowIso: string): Record<string, unknown> {
  const r = input.result;
  return {
    at: nowIso,
    sourceOwnerId: input.sourceOwnerId,
    dispatched: r.dispatched,
    answeringOwnerId: r.answeringOwnerId,
    operation: r.operation,
    agent: r.agent,
    model: r.model,
    verified: r.verified,
    detail: clip(r.detail),
    ...(r.targetCapacityUnavailable ? { targetCapacityUnavailable: clip(r.targetCapacityUnavailable) } : {}),
    attempts: r.attempts.map((a) => ({
      rank: a.rank,
      agent: a.agent,
      model: a.model,
      operation: a.operation,
      outcome: a.outcome,
      ...(a.reason ? { reason: a.reason } : {}),
      ...(a.accountRoute ? { accountRoute: a.accountRoute } : {}),
      ...(a.accountRouteReason ? { accountRouteReason: clip(a.accountRouteReason) } : {}),
      detail: clip(a.detail),
      ...(a.launchError ? { launchError: clip(a.launchError, 300) } : {}),
      ...(a.launchLogPath ? { launchLogPath: clip(a.launchLogPath) } : {}),
      // A clipped path would name no file, so an over-long one is dropped rather
      // than clipped; the sweep then leaves that slot to bounded pickup recovery.
      ...(a.firstTurnUnjudged && a.firstTurnUnjudged.transcriptPath.length <= DISPATCH_RECORD_TEXT_MAX
        ? {
            firstTurnUnjudged: {
              agent: a.firstTurnUnjudged.agent,
              transcriptPath: a.firstTurnUnjudged.transcriptPath,
              kickoffAt: a.firstTurnUnjudged.kickoffAt,
            },
          }
        : {}),
      ...(a.answeringTurn && a.answeringTurn.transcriptPath.length <= DISPATCH_RECORD_TEXT_MAX
        ? { answeringTurn: {
            agent: a.answeringTurn.agent,
            transcriptPath: a.answeringTurn.transcriptPath,
            kickoffAt: a.answeringTurn.kickoffAt,
          } }
        : {}),
    })),
  };
}

/**
 * Append one record to `consult_state.dispatch_attempts`, keeping the newest
 * {@link DISPATCH_RECORDS_MAX} in append order. It deliberately leaves
 * `updated_at` alone — expiry and staleness readers key on it, and recording
 * evidence must not look like consult activity. Exported for the real-Postgres
 * test; production calls it through {@link defaultRecordDispatchAttempts}.
 */
export async function appendDispatchRecord(
  sql: Sql,
  input: ConsultDispatchRecordInput,
  nowIso: string,
): Promise<void> {
  await appendDispatchRecordEntry(sql, input, dispatchRecordEntry(input, nowIso));
}

/**
 * The one bounded append behind every `dispatch_attempts` writer — a launch walk
 * ({@link appendDispatchRecord}) or an answer-window failure
 * ({@link appendAnswerFailureRecord}).
 */
async function appendDispatchRecordEntry(
  sql: Sql,
  target: { workspaceId: string; conversationId: string },
  record: Record<string, unknown>,
): Promise<void> {
  // `::text` THEN `::jsonb`: typing the parameter as text makes postgres.js send
  // the string as-is on ANY client. A bare `${entry}::jsonb` infers a jsonb param,
  // and a client without the canonical hybrid serializer (restoreRawJsonbSerializer)
  // JSON-encodes it again — storing a jsonb STRING, not an object (caught by
  // consult-dispatch-record.integration.test.ts on a plain client). Not sql.json():
  // the org pool has mishandled that in templates (EI-10445).
  const entry = JSON.stringify(record);
  await sql`
    UPDATE harness_shared.consult_state
       SET dispatch_attempts = (
         SELECT COALESCE(jsonb_agg(e ORDER BY ord), '[]'::jsonb)
           FROM (
             SELECT e, ord
               FROM jsonb_array_elements(dispatch_attempts || jsonb_build_array(${entry}::text::jsonb))
                    WITH ORDINALITY AS t(e, ord)
              ORDER BY ord DESC
              LIMIT ${DISPATCH_RECORDS_MAX}
           ) kept
       )
     WHERE workspace_id = ${target.workspaceId} AND conversation_id = ${target.conversationId}
  `;
}

// ── Answer-window failures (WI-10003199, plan review-routing-through-relevance-router P-003) ──
//
// A launch walk records whether a session STARTED. It says nothing about whether
// that session then ANSWERED. Measured 2026-09-26 over 3 days of consult answering
// sessions: 8 launched, never posted, and ran a median 58 min (max 190) before the
// task reaper noticed — and none of them left any trace on their consult. The
// consult expiry sweep, the one actor that decides a slot's window is over, now
// stops that session and appends one of these records, so "launched but silent" is
// a failed attempt with a reason instead of an absence.

/** Why a launched answering session ended without posting. */
export type AnswerFailureReason =
  /** The slot's consult window elapsed (the cascade advanced, or the consult expired). */
  | 'answer-window-expired'
  /** Bounded pickup recovery found no consult post before the window (implicit decline). */
  | 'answer-pickup-stalled'
  /** A silent review consult was converted to pullable work at half its window. */
  | 'answer-window-converted'
  /**
   * The session's first reply, landing after the dispatcher's first-turn window,
   * was a provider rejection (EI-27111739698817170), so the slot was advanced
   * without waiting for bounded pickup recovery.
   */
  | 'answer-first-turn-rejected';

export interface AnswerFailureRecordInput {
  workspaceId: string;
  conversationId: string;
  /** The expert the slot was selected for (`selection.selected[cursor].ownerId`). */
  sourceOwnerId: string;
  /** The slot's `answeringOwnerId` stamp; null when dispatch never stamped one. */
  answeringOwnerId: string | null;
  cascadeCursor: number;
  reason: AnswerFailureReason;
  detail: string;
  /** What stopping the session did, e.g. `stopped task …` or `no live answering session found`. */
  stopOutcome: string;
}

/**
 * The persisted shape of an answer-window failure. It deliberately mirrors a launch
 * walk's top level, so `conversations:get` renders it with no special case, and its
 * single attempt carries `outcome:'failed'` + the reason.
 *
 * `dispatched:false` with a reason outside the launch-failure set keeps it NEUTRAL to
 * the source cool-down: it launched nothing, so it neither counts as a failed launch
 * nor resets the count the way a successful dispatch does.
 */
export function answerFailureRecordEntry(input: AnswerFailureRecordInput, nowIso: string): Record<string, unknown> {
  const detail = clip(`${input.detail}; ${input.stopOutcome}`);
  return {
    at: nowIso,
    sourceOwnerId: input.sourceOwnerId,
    dispatched: false,
    answeringOwnerId: input.answeringOwnerId,
    operation: null,
    agent: null,
    model: null,
    verified: null,
    detail,
    answerFailure: {
      reason: input.reason,
      cascadeCursor: input.cascadeCursor,
      stopOutcome: clip(input.stopOutcome, 300),
    },
    attempts: [
      { rank: null, agent: null, model: null, operation: null, outcome: 'failed', reason: input.reason, detail },
    ],
  };
}

/** Append one {@link answerFailureRecordEntry} to its consult's `dispatch_attempts`. */
export async function appendAnswerFailureRecord(
  sql: Sql,
  input: AnswerFailureRecordInput,
  nowIso: string,
): Promise<void> {
  await appendDispatchRecordEntry(sql, input, answerFailureRecordEntry(input, nowIso));
}

/** Default recorder: {@link appendDispatchRecord} through the org pool. */
async function defaultRecordDispatchAttempts(input: ConsultDispatchRecordInput): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  await appendDispatchRecord(getOrgPg().sql as unknown as Sql, input, new Date().toISOString());
}

// ── Source cool-down (WI-10003198, plan review-routing-through-relevance-router P-002) ──
//
// Measured 2026-09-26: one source (fa2b9674, an earlier incarnation of
// su-5078d176) was launched 144 times — 72 forks, 72 converts — and psu refused
// every one within seconds, because each new consult routed to it re-ran the
// same doomed walk. A source whose launches keep failing is therefore skipped
// for a cool-down instead of launched again. The state is DERIVED from the
// persisted walks on consult_state.dispatch_attempts (migration 1225), not kept
// in a second table: those records are already the ground truth for what was
// launched and how it ended, so nothing can drift.

/** Consecutive failed launches (since the source's last dispatch) that start a cool-down. */
export const SOURCE_LAUNCH_FAILURE_THRESHOLD = 3;
/** How long a source is skipped after its latest failed launch once the threshold is met. */
export const SOURCE_COOLDOWN_MS = 60 * 60_000;
/** How far back failed launches still count toward the threshold. */
export const SOURCE_FAILURE_LOOKBACK_MS = 6 * 60 * 60_000;

/** Attempt reasons that mean a session was actually launched (or its launch
 *  composed) and did not survive. Skips — walls, pressure, unsupported
 *  operations — launch nothing and are never counted. */
const LAUNCH_FAILURE_REASONS: ReadonlySet<string> = new Set<DispatchSkipReason>([
  'launch-failed',
  'kickoff-not-persisted',
  'launch-exited',
  'first-turn-rejected',
  'first-turn-provider-error',
]);

/** The fields of a persisted walk ({@link dispatchRecordEntry}) the cool-down reads. */
export interface PersistedDispatchRecord {
  at: string;
  sourceOwnerId?: string;
  dispatched?: boolean;
  answeringOwnerId?: string | null;
  attempts?: Array<{
    firstTurnUnjudged?: Partial<FirstTurnUnjudged>;
    answeringTurn?: Partial<FirstTurnUnjudged>;
    outcome?: string;
    reason?: string;
    agent?: string;
    model?: string;
    launchError?: string;
    launchLogPath?: string;
    detail?: string;
  }>;
}

export interface SourceCooldown {
  /** Failed launches counted, newest first, back to the last dispatch. */
  failures: number;
  /** ISO time the cool-down ends. */
  until: string;
  /** The newest counted failure, for the refusal detail. */
  lastFailure: string;
}

/**
 * The cool-down a source is in, or null. Pure. Walks the source's persisted
 * walks newest first and counts failed launches until it meets one that
 * dispatched (a success resets the count). A walk that launched nothing — a
 * refusal, an all-skipped walk, or an earlier cool-down — neither counts nor
 * resets, so a cool-down never extends itself.
 */
export function sourceCooldownFrom(
  records: readonly PersistedDispatchRecord[],
  nowMs: number,
  {
    threshold = SOURCE_LAUNCH_FAILURE_THRESHOLD,
    cooldownMs = SOURCE_COOLDOWN_MS,
    lookbackMs = SOURCE_FAILURE_LOOKBACK_MS,
  } = {},
): SourceCooldown | null {
  const sorted = [...records]
    .filter((r) => typeof r?.at === 'string' && Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let failures = 0;
  let newestFailureAt: number | null = null;
  let lastFailure = '';
  for (const record of sorted) {
    const at = Date.parse(record.at);
    if (nowMs - at > lookbackMs) break;
    if (record.dispatched === true) break;
    for (const attempt of record.attempts ?? []) {
      if (attempt?.outcome !== 'failed' || !attempt.reason || !LAUNCH_FAILURE_REASONS.has(attempt.reason)) continue;
      failures += 1;
      if (newestFailureAt == null) {
        newestFailureAt = at;
        lastFailure =
          `${attempt.reason} on ${attempt.agent ?? '?'}/${attempt.model ?? '?'}` +
          (attempt.launchError ? `: ${clip(attempt.launchError, 200)}` : '');
      }
    }
  }
  if (failures < threshold || newestFailureAt == null) return null;
  const until = newestFailureAt + cooldownMs;
  if (nowMs >= until) return null;
  return { failures, until: new Date(until).toISOString(), lastFailure };
}

/**
 * The source's persisted walks since `sinceIso`, newest first, across every
 * consult in the workspace. Exported for the real-Postgres test; production
 * calls it through {@link defaultReadSourceDispatchRecords}.
 */
export async function readSourceDispatchRecords(
  sql: Sql,
  workspaceId: string,
  sourceOwnerId: string,
  sinceIso: string,
  limit = 60,
): Promise<PersistedDispatchRecord[]> {
  // The consult bound is the lookback plus the longest a consult stays open
  // (measured 2026-09-26: p99 8 h, max 32 h over 1,300 consults), so a walk
  // appended to a long-lived consult is still seen. Records carry an ISO `at`
  // from toISOString(), which compares correctly as text.
  const rows = await sql<Array<{ e: unknown }>>`
    SELECT r.e
      FROM harness_shared.consult_state c
     CROSS JOIN LATERAL jsonb_array_elements(c.dispatch_attempts) AS r(e)
     WHERE c.workspace_id = ${workspaceId}
       AND c.created_at >= ${sinceIso}::timestamptz - interval '2 days'
       AND jsonb_array_length(c.dispatch_attempts) > 0
       AND r.e->>'sourceOwnerId' = ${sourceOwnerId}
       AND r.e->>'at' >= ${sinceIso}
     ORDER BY r.e->>'at' DESC
     LIMIT ${limit}
  `;
  return rows
    .map((row) => (typeof row.e === 'string' ? (JSON.parse(row.e) as unknown) : row.e))
    .filter((e): e is PersistedDispatchRecord => !!e && typeof e === 'object' && typeof (e as { at?: unknown }).at === 'string');
}

/** Default reader: {@link readSourceDispatchRecords} through the org pool. */
async function defaultReadSourceDispatchRecords(
  workspaceId: string,
  sourceOwnerId: string,
  sinceIso: string,
): Promise<PersistedDispatchRecord[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return readSourceDispatchRecords(getOrgPg().sql as unknown as Sql, workspaceId, sourceOwnerId, sinceIso);
}

/** Strip terminal control sequences (CSI and OSC) and carriage returns. */
function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '');
}

/** psu prints its own refusals as whole `psu: …` lines, so the whole line is the reason. */
const PSU_FAILURE_LINE =
  /^psu(?:-pty-host)?: .*(?:refus|requires|must|could not|cannot|can only|failed|no session|not found|not all present|unavailable|unrecoverable|DROPPED|still in progress)/i;
/** The native host's nonretryable receipt is terminal evidence for this answer turn. */
const NATIVE_TERMINAL_FAILURE_LINE =
  /^\[psu\] native-turn-failed agent=(?:claude|codex) code=[A-Za-z0-9_.-]{1,120} retryable=false retryAfterMs=(?:unknown|\d+)$/i;
/**
 * The CLI's own failures arrive inside TUI output drawn with cursor-movement
 * escapes, not newlines, so they sit mid-way through one long rendered "line"
 * (which can open with the consult brief itself). Only the matched fragment is
 * the reason — keeping the line would clip to its start and report the brief.
 */
const MIDLINE_FAILURES: RegExp[] = [
  /You(?:'ve| have) hit your (?:session|weekly|usage) limit(?:\s*·\s*resets[^()\n·]{0,40}(?:\([^()\n]{0,40}\))?)?/gi,
  /(?:^|⎿)[ \t]*(API Error:[^\n]{0,480})[ \t]*$/gi,
  /Tool reference \S+ not found/g,
];
const LAUNCH_EXIT_LINE = /^\[papercusp\] initial terminal command exited with status \d+/;
// Match an actual CLI error line or its terminal result glyph, never a consult
// brief quoting the failure it asks the reviewer to investigate.
const CONTEXT_LIMIT_LOG_RE =
  /(?:^|⎿)[ \t]*(Context limit reached\s*·\s*\/clear to continue|(?:API Error:\s*400\s+)?Prompt is too long)[ \t]*$/gi;
// Codex renders this with its terminal error glyph, sometimes immediately before
// psu appends the dropped-kickoff notice. A prose quotation is not a rejection.
const MESSAGE_LIMIT_LOG_RE =
  /^■[ \t]*(Message exceeds the maximum length of \d+ characters \(\d+ provided\))\.?(?=[ \t]*(?:$|psu:))/g;

/**
 * The failure a launch log ends on: the LAST launcher failure (psu's own
 * refusal, an account wall, a dropped kickoff), plus the terminal exit status
 * when present. Pure, for tests; the default reader feeds it the log's tail.
 */
export function launchLogFailureReason(logText: string): string | null {
  const lines = stripTerminalControl(logText)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let failure: string | null = null;
  let exit: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (PSU_FAILURE_LINE.test(line)) {
      failure = line;
      continue;
    }
    if (NATIVE_TERMINAL_FAILURE_LINE.test(line) &&
        lines.slice(index + 1).every((trailing) => LAUNCH_EXIT_LINE.test(trailing))) {
      failure = line;
      continue;
    }
    if (LAUNCH_EXIT_LINE.test(line)) {
      exit = line.replace(/; headless launch exiting\.?$/, '');
      continue;
    }
    const contextFailures = [...line.matchAll(CONTEXT_LIMIT_LOG_RE)];
    if (contextFailures.length) {
      failure = contextFailures[contextFailures.length - 1][1].trim();
      continue;
    }
    const messageFailures = [...line.matchAll(MESSAGE_LIMIT_LOG_RE)];
    if (messageFailures.length) {
      failure = messageFailures[messageFailures.length - 1][1].trim();
      continue;
    }
    for (const re of MIDLINE_FAILURES) {
      const hits = [...line.matchAll(re)];
      if (hits.length) {
        const hit = hits[hits.length - 1]!;
        failure = (hit[1] ?? hit[0]).trim();
      }
    }
  }
  if (!failure && !exit) return null;
  return clip([failure, exit].filter(Boolean).join(' · '), 300);
}

/** Default reader: the last 64 KiB of the launch log. Never throws. */
async function defaultReadLaunchLogReason(logPath: string | null | undefined): Promise<string | null> {
  if (!logPath) return null;
  try {
    const { open } = await import('node:fs/promises');
    const fh = await open(logPath, 'r');
    try {
      const { size } = await fh.stat();
      const length = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, size - length);
      return launchLogFailureReason(buf.toString('utf8'));
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Default `stopFailedLaunch`: kill the spawned session's ledger task, i.e. its
 * whole scope subtree, by the task id `spawnHeadless` returned.
 *
 * WHY THIS EXISTS. A rank that fails after its spawn succeeded (the kickoff never
 * persisted, or verification lost to a child death) used to be recorded as
 * `failed` while its process was left running. The walk then launched the next
 * rank, and the orphan idled on its pty forever: it was never announced as the
 * consult's responder, so nothing would ever route to it or settle it. Measured
 * 2026-09-24: 77 of the 94 consult processes found running, and 178 of the 203
 * the task reaper had stranded earlier, were such unannounced orphans.
 *
 * The KILL is keyed on the task id, never on the owner id: a conversion shares
 * the expert's own identity, so an owner-keyed stop could hit the expert's live
 * session.
 *
 * The row close (`neverRan`) is keyed on the ANSWERING owner id, which
 * `walkConsultDispatch` mints fresh for this rank on every operation, so no other
 * session can hold it. It runs only after a CONFIRMED kill: if the process could
 * still be alive it might yet boot, and closing its row would mark a running
 * session ended.
 */
export async function defaultStopFailedLaunch(
  taskId: string | null | undefined,
  neverRan?: { answeringOwnerId: string },
): Promise<string> {
  if (!taskId) return 'no task id to stop (unledgered spawn)';
  let stopped: string;
  try {
    const { killTask } = await import('../task-manager/control');
    const outcome = await killTask(taskId);
    if (!outcome.ok) {
      if (outcome.error !== 'already_gone') {
        return `stop of task ${taskId} refused: ${outcome.error ?? 'unknown'}`;
      }
      // `killTask` only returns `already_gone` after systemd confirms that this
      // exact task scope has been collected. Its exit watcher may not have
      // persisted the terminal ledger row yet, so reconcile through the task
      // store before the reviewer recruiter re-reads task state.
      const { closeTask } = await import('../task-manager/store');
      const closed = await closeTask(taskId, {
        state: 'ended_unobserved',
        exitReason: 'scope already gone during failed-launch containment',
      });
      stopped = closed
        ? `verified task ${taskId} scope already gone; recorded ended_unobserved`
        : `verified task ${taskId} scope already gone; ledger row already terminal or unavailable`;
    } else {
      stopped = `stopped task ${taskId}`;
    }
  } catch (e) {
    return `stop of task ${taskId} threw: ${(e as Error)?.message ?? String(e)}`;
  }
  if (!neverRan?.answeringOwnerId) return stopped;
  return `${stopped}; ${await closeNeverRanLaunchRow(neverRan.answeringOwnerId)}`;
}

/** Close a never-ran answering identity's open adv_sessions row. Never throws. */
async function closeNeverRanLaunchRow(answeringOwnerId: string): Promise<string> {
  try {
    const { getLatestActiveAdvSessionByOwner, markAdvSessionEnded } = await import('../adv-sessions');
    const row = await getLatestActiveAdvSessionByOwner(answeringOwnerId);
    if (!row) return `no open adv_session for ${answeringOwnerId}`;
    const closed = await markAdvSessionEnded(row.id, null, 'cleanup');
    return closed
      ? `closed adv_session #${row.id} as never-ran (cleanup)`
      : `adv_session #${row.id} was already ended`;
  } catch (e) {
    return `close of ${answeringOwnerId}'s adv_session threw: ${(e as Error)?.message ?? String(e)}`;
  }
}

/** The account-pool provider that funds a backend. OMP is not a pooled
 *  subscription, so it has no wall to probe — reported available rather than
 *  guessed at. */
function providerForBackend(agent: ExpertBackend): 'claude' | 'codex' | null {
  if (agent === 'claude') return 'claude';
  if (agent === 'codex') return 'codex';
  return null;
}

/**
 * Default wall probe: read the account-pool projection for the backend's
 * provider and ask whether ANY account still has headroom.
 *
 * Deliberately the cheap PROJECTION read, not `accounts:probe-capacity` — the
 * upstream probe costs one request per account and this runs on the requester's
 * critical path for every rank. A stale projection can affect one ranked decision;
 * the walk records the route or skip reason and continues its configured ranks.
 * A confirmed gateway-off or empty-pool state selects the existing system/CLI
 * account route. Unknown preflight state is recorded as routing-unavailable,
 * before consuming an expert launch attempt.
 */
export async function defaultProbeBackendAvailable(
  agent: ExpertBackend,
  workspaceId: string,
  model?: string | null,
): Promise<BackendAvailability> {
  const provider = providerForBackend(agent);
  if (!provider) return { available: true, detail: `${agent} is not a pooled subscription — no wall to probe` };
  let gatewayOn: boolean | null = null;
  try {
    const [{ loadAccountPool }, { anyAccountAvailable, isSpawnEligible, poolForProvider }, { getFlag }, { FLAGS }] = await Promise.all([
      import('../deployment/account-pool-store'),
      import('../deployment/account-pool'),
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    gatewayOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
    if (gatewayOn === false) {
      return resolveConsultBackendAvailability(provider, {
        gatewayOn: false,
        poolAccountCount: null,
        poolHasHeadroom: null,
      });
    }
    if (gatewayOn !== true) {
      return resolveConsultBackendAvailability(provider, {
        gatewayOn: null,
        poolAccountCount: null,
        poolHasHeadroom: null,
      });
    }
    const pool = poolForProvider(await loadAccountPool(workspaceId), provider);
    const now = Date.now();
    // Codex auto routing has no account pin: the gateway paces and fails over at
    // request time. A predictive local pause must not veto that route before its
    // authoritative gateway probe. Keep usage, credential and sustained-limit
    // exclusions, and keep the strict pause guard for Claude CLI launches.
    const hasHeadroom = provider === 'codex'
      ? pool.accounts.some((account) => isSpawnEligible(account, now))
      : anyAccountAvailable(pool, now);
    const verdict = resolveConsultBackendAvailability(provider, {
      gatewayOn: true,
      poolAccountCount: pool.accounts.length,
      poolHasHeadroom: pool.accounts.length > 0 ? hasHeadroom : null,
    });
    // The local pool view cannot see gateway-side exclusions; ask the gateway the
    // same question the launcher will (WI-6554700010029514).
    if (provider === 'codex' && verdict.available && verdict.accountRoute === 'auto') {
      return applyCodexGatewayRefusal(verdict, provider, await readCodexGatewayPoolStats(), now, model);
    }
    return verdict;
  } catch (e) {
    return {
      available: false,
      failureReason: 'account-routing-unavailable',
      routeReason: provider + ' gateway/pool preflight failed',
      detail: provider + ' account-routing preflight failed (' +
        ((e as Error)?.message ?? String(e)) + '); automatic launch was not attempted' +
        (gatewayOn === false ? '; system/CLI route remains available' : ''),
    };
  }
}

/** A cascade CAS can succeed just before another responder closes the row. */
async function defaultIsConsultOpen(workspaceId: string, conversationId: string): Promise<boolean> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const [row] = await getOrgPg().sql<Array<{ state: string; closed_at: Date | string | null }>>`
    SELECT state, closed_at
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
     LIMIT 1
  `;
  return Boolean(
    row &&
      row.closed_at == null &&
      (row.state === 'awaiting_responder' || row.state === 'active'),
  );
}

/**
 * Serialize the terminal consult transition with the last process-creation
 * boundary. consultCloseCore already locks this row FOR UPDATE; this lease holds
 * the same row lock across child_process.spawn(), then rolls back the read-only
 * transaction so a close either wins first (and launch is refused) or commits
 * only after the answering process exists.
 */
export async function acquireConsultSpawnLease(
  workspaceId: string,
  conversationId: string,
  sql?: Sql,
): Promise<ConsultSpawnLease | null> {
  const dbSql = sql ?? ((await import('@papercusp/db-org')).getOrgPg().sql as unknown as Sql);
  const connection = await dbSql.reserve();
  let transactionOpen = false;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[consult-dispatch] consult spawn lease rollback failed: ${reason.slice(0, 500)}`);
    } finally {
      transactionOpen = false;
      connection.release();
    }
  };

  try {
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    const [row] = await connection<Array<{ state: string; closed_at: Date | string | null }>>`
      SELECT state, closed_at
        FROM harness_shared.consult_state
       WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
       FOR UPDATE
    `;
    if (!row || row.closed_at != null || (row.state !== 'awaiting_responder' && row.state !== 'active')) {
      await release();
      return null;
    }
    return { release };
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Confirm the source has something a fork/convert can actually read. Delegated
 * to the shared preflight so the launch paths cannot diverge on what counts as
 * a resumable transcript.
 */
async function defaultCheckResumeTranscript(target: ResumeTarget) {
  const { checkConsultResumeTranscript } = await import('./resume-transcript-preflight');
  return checkConsultResumeTranscript(target);
}

/** Nonzero/signal child termination is concrete evidence that a spawned
 *  answering session did not survive to become a responder. */
function childExitFailure(exit: SpawnChildExit): string | null {
  if (exit.error) return `answering-session spawn errored after return: ${exit.error.message}`;
  if (exit.signal) return `answering-session process exited on signal ${exit.signal}`;
  if (exit.code != null && exit.code !== 0) {
    return `answering-session process exited with status ${exit.code}`;
  }
  return null;
}

/** The operation a rank implies against this source, or the reason there is none. */
export function planDispatchOperation(
  source: {
    agent: string | null;
    live: boolean;
    tracked?: boolean;
    historical?: boolean;
    role?: string | null;
    portStatus?: string | null;
  },
  rank: Pick<AllowedExpertModel, 'agent'>,
): { operation: DispatchOperation } | { operation: null; reason: DispatchSkipReason; detail: string } {
  const sourceAgent = (source.agent ?? '').toLowerCase();
  if (!['claude', 'codex', 'omp'].includes(sourceAgent)) {
    return {
      operation: null,
      reason: 'conversion-unavailable',
      detail:
        `unsupported source backend ${sourceAgent || 'unknown'}`,
    };
  }
  // WI-6554700010030461: psu resolves every tracked fork/resume through the
  // resumable list, which hides a session-port target whose port never
  // delivered. Launching one fails per rank with "not a resumable tracked row",
  // so treat it as untracked here; the brief fallback still reaches the expert.
  if (!portStatusAllowsResume(source.portStatus)) {
    return {
      operation: null,
      reason: 'source-session-untracked',
      detail:
        `the source's tracked row is a session-port target whose port is '${source.portStatus}', not ` +
        'delivered; psu refuses to resume or fork such a row, so the rank is skipped before launch',
    };
  }
  if (source.tracked === false) {
    return {
      operation: null,
      reason: 'source-session-untracked',
      detail:
        'a cross-backend session port needs an exact psu-tracked source session; this raw native session ' +
        'can only be resumed or forked in place, so the rank is skipped before launch',
    };
  }
  // Tracked Claude forks already preserve the live expert. Every other pair
  // uses the maintained port with a preparation-bound independent answer owner.
  const operation = sourceAgent === 'claude' && rank.agent === 'claude' && !source.historical ? 'fork' : 'convert';
  if (operation === 'convert' && source.role != null) {
    return { operation: null, reason: 'conversion-unavailable',
      detail: 'session-port protocol v1 requires a plain tracked SU source' };
  }
  return { operation };
}

/**
 * `resolveResumeTarget` can exact-pin an older/native transcript while its
 * `binding` describes the owner's current adv_sessions incarnation. A consult
 * fork or session port needs the exact source itself to be psu-tracked; the
 * launcher rejects a raw native source after spawn, so compare the pin with the
 * persisted binding before any rank is launched.
 */
function isExactTrackedResumeTarget(target: Pick<ResumeTarget, 'ownerId' | 'sessionId' | 'ompThreadId' | 'agent' | 'binding'>): boolean {
  const nativeId = target.sessionId ?? (target.agent === 'omp' ? target.ompThreadId : null);
  const boundNativeId = target.agent === 'omp'
    ? target.binding?.ompThreadId ?? target.binding?.sessionId : target.binding?.sessionId;
  return Boolean(
    target.ownerId &&
      nativeId &&
      target.binding?.coordOwnerId === target.ownerId &&
      boundNativeId === nativeId,
  );
}

/**
 * Get an allowed model answering `question` from `sourceOwnerId`'s transcript,
 * by forking or converting that session. Resolves ALWAYS (never throws) — the
 * caller falls back to its pre-dispatch outcome on `dispatched:false`.
 */
export async function dispatchConsultResponder(
  opts: {
    /** The expert whose TRANSCRIPT is the knowledge source (the routed pick). */
    sourceOwnerId: string;
    conversationId: string;
    reviewerModel?: ConsultReviewerModel;
    nativeConsult?: NativeConsultConstraints;
    /** Canonical screen rebuilt from the persisted target on every dispatch. */
    checkApprover?: import('./acceptance-bar-amendment-review').AmendmentReviewerScreen;
    /** Router-matched transcript turns; exact native session wins over the
     * owner's newest session so the routed evidence and carried source agree. */
    evidence?: ConsultDispatchEvidenceRef[];
    /**
     * Delivered as the answering session's first turn. A FUNCTION is resolved
     * per rank with the operation that rank actually implies, because a fork and
     * a conversion inherit history differently and a brief that names the wrong
     * one tells the session something false about its own provenance. A plain
     * string is the operation-independent case.
     */
    brief: string | ((operation: DispatchOperation) => string);
    /**
     * Called with the answering identity before a fork is launched, because
     * the child can post while spawnHeadless is still waiting for its kickoff
     * receipt. For conversions, the identity is already known and is stamped
     * after launch. The caller persists it here; failures are best-effort.
     */
    onAnsweringOwner?: (answeringOwnerId: string) => void | Promise<void>;
    /** Called only after the launcher proves the native kickoff was persisted.
     * False means this dispatch no longer owns the selected reply window. */
    onKickoff?: (kickoffAt: string, answeringOwnerId: string) => boolean | Promise<boolean>;
  },
  ctx: ConsultDispatchContext,
  deps: Partial<ConsultDispatchDeps> = {},
): Promise<ConsultDispatchResult> {
  const d: ConsultDispatchDeps = {
    resolveResumeTarget,
    checkEvidenceIncarnationOwnedBy: async (target, sessionId) => {
      const { getOrgPg } = await import('@papercusp/db-org');
      return evidenceIncarnationOwnedBy(getOrgPg().sql as unknown as Sql,
        { coordOwnerId: target.ownerId, agent: target.agent }, sessionId);
    },
    checkResumeTranscript: defaultCheckResumeTranscript,
    checkPortTranscript: async (target, transcript, evidenceSpan) => {
      const { checkConsultSessionPortTranscript } = await import('./resume-transcript-preflight');
      return checkConsultSessionPortTranscript(target, transcript, evidenceSpan);
    },
    isConsultOpen: defaultIsConsultOpen,
    reserveConsultSpawnLease: acquireConsultSpawnLease,
    analyzeClaudeTranscript: analyzeClaudeResumeTranscriptFile,
    analyzeCodexRollout: analyzeCodexRolloutFile,
    buildAgentLaunchCommand,
    injectLaunchedByArg,
    buildConsoleEnvelope,
    spawnHeadless,
    verifyResumeStarted,
    fetchContextPressure,
    estimateTranscriptTokens: (transcriptPath) => tokensFromFileSize(transcriptPath),
    bucketTranscriptPressure: bucketTokensAgainstOwnerLimit,
    probeBackendAvailable: defaultProbeBackendAvailable,
    mintOwnerId: () => `su-${randomUUID()}`,
    stopFailedLaunch: defaultStopFailedLaunch,
    readLaunchLogReason: defaultReadLaunchLogReason,
    recordDispatchAttempts: defaultRecordDispatchAttempts,
    readSourceDispatchRecords: defaultReadSourceDispatchRecords,
    nowMs: () => Date.now(),
    sleepMs: (ms: number) => sleep(ms),
    readCitedTurns: defaultReadCitedTurns,
    ...deps,
  };
  const result = await walkConsultDispatch(opts, ctx, d);
  // WI-10003197: every walk — dispatched, exhausted, or refused before any rank —
  // lands on its consult, so a failed answering session is visible without
  // searching fleet-logs. Best-effort: losing the record never costs the dispatch.
  try {
    await d.recordDispatchAttempts({
      workspaceId: ctx.workspaceId,
      conversationId: opts.conversationId,
      sourceOwnerId: opts.sourceOwnerId,
      result,
    });
  } catch {
    /* evidence write failed; the dispatch verdict stands */
  }
  return result;
}

async function walkConsultDispatch(
  opts: Parameters<typeof dispatchConsultResponder>[0],
  ctx: ConsultDispatchContext,
  d: ConsultDispatchDeps,
): Promise<ConsultDispatchResult> {
  const attempts: ConsultDispatchAttempt[] = [];
  const give = (detail: string): ConsultDispatchResult => ({
    dispatched: false,
    answeringOwnerId: null,
    operation: null,
    agent: null,
    model: null,
    verified: null,
    detail,
    attempts,
  });

  try {
    if (opts.checkApprover) {
      const verdict = await opts.checkApprover(opts.sourceOwnerId);
      if (verdict.eligible !== true) return give(`method_review_source_ineligible: ${verdict.reason}`);
    }
    // WI-10003198: a source whose launches keep failing is not launched again
    // until its cool-down ends. Checked first: it is the cheapest refusal, and
    // everything after it (resolve, preflight, pressure, walls) is wasted on a
    // source that will be refused anyway.
    let cooldown: SourceCooldown | null = null;
    try {
      const nowMs = d.nowMs();
      const records = await d.readSourceDispatchRecords(
        ctx.workspaceId,
        opts.sourceOwnerId,
        new Date(nowMs - SOURCE_FAILURE_LOOKBACK_MS).toISOString(),
      );
      cooldown = sourceCooldownFrom(records, nowMs);
    } catch {
      /* fail open — see ConsultDispatchDeps.readSourceDispatchRecords */
    }
    if (cooldown) {
      return give(
        `source ${opts.sourceOwnerId} is cooling down until ${cooldown.until}: its last ${cooldown.failures} ` +
          `answering-session launches failed (newest: ${cooldown.lastFailure}), so no session was launched`,
      );
    }

    const source = await resolveDispatchSource(opts, d);
    if ('refusal' in source) return give(source.refusal);
    const { target, evidenceSource } = source;
    if (opts.nativeConsult?.requireSourcePlanClaims) {
      const before = await (d.captureNativeBoundary ?? captureNativeConsultBoundary)(target, ctx.workspaceId);
      const mismatch = nativePlanClaimRequirementMismatch(before, opts.nativeConsult);
      if (mismatch) return give(mismatch);
    }
    const exactTracked = isExactTrackedResumeTarget(target);
    const boundNativeId = target.agent === 'omp'
      ? target.binding?.ompThreadId ?? target.binding?.sessionId : target.binding?.sessionId;
    // The port route already reads older evidence incarnations under their
    // tracked row. Use that seam instead of treating a rotated id as raw native
    // or silently forking the row's newer transcript. Both checks run again at
    // inspection, so an ownership change between resolution and spawn refuses.
    const historical = !exactTracked && evidenceSource !== null &&
      target.binding?.coordOwnerId === target.ownerId && Boolean(boundNativeId) &&
      target.sessionId === evidenceSource.sessionId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidenceSource.sessionId) &&
      Number.isSafeInteger(target.advSessionId) && target.advSessionId > 0 &&
      await d.checkEvidenceIncarnationOwnedBy(target, evidenceSource.sessionId);
    const launchTarget = historical ? { ...target, resumeId: String(target.advSessionId) } : target;
    // P-002 / D-008: a brief quotes the evidence session's turns as the
    // expert's. A coord binding that names ANOTHER owner contradicts that
    // attribution, and so does a binding to a DIFFERENT native session than
    // the evidence one that the incarnation proof did not cover (historical).
    // Such a source keeps its untracked refusal unbriefed.
    const briefAttributionContested =
      (Boolean(target.binding?.coordOwnerId) && target.binding?.coordOwnerId !== target.ownerId) ||
      (Boolean(boundNativeId) && evidenceSource !== null && boundNativeId !== evidenceSource.sessionId && !historical);

    let transcript: { available: boolean; detail: string; transcriptPath?: string };
    try {
      transcript = await d.checkResumeTranscript(target);
    } catch (e) {
      return give(
        `transcript availability preflight failed; dispatch was refused before any launch ` +
          `(${(e as Error)?.message ?? String(e)})`,
      );
    }
    if (!transcript.available) {
      return give(`source transcript unavailable; dispatch was refused before any launch (${transcript.detail})`);
    }

    // EI-22563829644276962, carried forward: a source sitting at the CRITICAL
    // context band cannot take a turn even after a kickoff receipt is accepted.
    // A FORK inherits that whole transcript, so it inherits the wall; a CONVERT
    // re-renders the history into the TARGET's budget and does not. So this is a
    // per-operation skip, not a source-level refusal — the walk can still reach
    // the expert through a conversion.
    let forkBlockedByPressure: string | null = null;
    if (target.ownerId) {
      try {
        const pressure = await d.fetchContextPressure([target.ownerId]);
        if (pressure.get(target.ownerId) === 'critical') {
          forkBlockedByPressure =
            `${target.ownerId} is at CRITICAL context (at or above 90% of its compaction limit), so a fork ` +
            'would inherit a transcript with no room to answer';
        }
      } catch (e) {
        // Unknown pressure is not evidence the source is safe to fork. Fail
        // closed on the FORK legs only; the conversion legs are unaffected.
        forkBlockedByPressure =
          `context-pressure preflight failed for ${target.ownerId} ` +
          `(${(e as Error)?.message ?? String(e)}); forking was refused rather than assumed safe`;
      }
    }

    // WI-10004888: the owner-level read above measures the owner's CURRENT
    // native session, but a fork replays the evidence-selected session (pinned
    // to target.sessionId above), which can be an older, larger transcript from
    // before a carry-respawn. Measured: owner at 81% ('high') while the forked
    // session estimated 407,627 tokens, 90.6% of the same 450K limit, and the
    // fork started over its limit and could only decline. So bucket the
    // transcript the fork will actually replay, against the same limit and
    // bands. An unknown estimate does not block: the owner-level gate above
    // already fails closed, and conversion legs are unaffected either way.
    if (!forkBlockedByPressure && target.ownerId && transcript.transcriptPath) {
      try {
        const tokens = await d.estimateTranscriptTokens(transcript.transcriptPath);
        if (tokens != null && (await d.bucketTranscriptPressure(target.ownerId, tokens)) === 'critical') {
          forkBlockedByPressure =
            `the fork source transcript for ${target.ownerId} (session ${target.sessionId ?? 'unknown'}) ` +
            `estimates ${tokens} tokens, at or above 90% of its compaction limit, so a fork would inherit ` +
            'a transcript with no room to answer';
        }
      } catch {
        // Fail open on this leg only; see the comment above.
      }
    }

    // WI-10004260: a Claude source whose LATEST assistant output is a provider
    // "Tool reference … not found in available tools" 400 is a poisoned
    // transcript. A FORK replays that exact history, so it inherits the poison
    // and 400s on its first turn — measured twice on one acceptance consult,
    // where the dead forks held the grading slot for ~30 minutes each. A
    // CONVERT re-renders the history and does not inherit it, so, like the
    // pressure gate above, this skips the fork legs only. An unreadable
    // transcript is not evidence of poison: the kickoff proof still guards it.
    let forkBlockedByPoison: string | null = null;
    const sourceAgent = (target.agent ?? '').toLowerCase();
    if ((sourceAgent === 'claude' || sourceAgent === 'claude-code') && transcript.transcriptPath) {
      try {
        const analysis = d.analyzeClaudeTranscript(transcript.transcriptPath);
        // WI-10006539: byte/owner pressure can miss an evidence-selected
        // transcript whose last provider response already rejected its size.
        // Forking preserves that wall; the configured conversion ranks can
        // still render the exact evidence into a fresh target context.
        if (analysis && (analysis.trailingContextLimitTurns ?? 0) > 0) {
          forkBlockedByPressure =
            `${target.ownerId ?? 'the source'}'s transcript ends in a provider context rejection ` +
            `(${analysis.lastContextLimitEvidence ?? 'Prompt is too long'}), so a fork would inherit ` +
            'a transcript with no room to answer';
        }
        if (analysis && analysis.trailingMissingToolReferenceTurns > 0) {
          forkBlockedByPoison =
            `${target.ownerId ?? 'the source'}'s transcript ends in ${analysis.trailingMissingToolReferenceTurns} ` +
            `provider "Tool reference not found" rejection(s)` +
            (analysis.lastMissingToolReferenceName ? ` (last: '${analysis.lastMissingToolReferenceName}')` : '') +
            ', so a fork would replay the same history and fail on its first turn';
        }
      } catch {
        // Fail open on the analysis only — see the comment above.
      }
    }

    // A matrix trial may not substitute seed models for missing configured ranks.
    const allowedRanks = opts.nativeConsult
      ? normalizeExpertModelAllowlist(await d.loadRanks?.(ctx.workspaceId))
      : await resolveExpertModelAllowlist(ctx.workspaceId, d);
    const requested = opts.reviewerModel;
    const backendRanks = opts.nativeConsult ? allowedRanks.filter(rank => rank.agent === opts.nativeConsult!.targetBackend) : allowedRanks;
    const ranks = requested
      ? backendRanks.filter((rank) => rank.agent === requested.agent && rank.model === requested.model)
        .map((rank) => ({
          ...rank,
          model: requested.effort ? `${rank.model}:${requested.effort}` : rank.model,
        }))
      : backendRanks;
    if (ranks.length === 0) {
      return give(requested
        ? `requested reviewer model ${requested.agent}/${requested.model} is absent from the current expert allowlist`
        : opts.nativeConsult ? `native target backend ${opts.nativeConsult.targetBackend} has no configured allowed model`
        : 'the expert-model allowlist resolved empty — no model is allowed to answer consults');
    }

    // Every native rank uses this one target backend. A provider-capacity
    // refusal cannot be repaired by selecting another source transcript.
    let nativeCapacity: BackendAvailability | null = null;
    if (opts.nativeConsult) {
      nativeCapacity = await d.probeBackendAvailable(opts.nativeConsult.targetBackend, ctx.workspaceId);
      if (!nativeCapacity.available) {
        for (const rank of ranks) attempts.push({
          rank: rank.rank, agent: rank.agent, model: rank.model, operation: null,
          outcome: 'skipped', reason: nativeCapacity.failureReason ?? 'account-walled',
          ...(nativeCapacity.accountRoute ? { accountRoute: nativeCapacity.accountRoute } : {}),
          ...(nativeCapacity.routeReason ? { accountRouteReason: nativeCapacity.routeReason } : {}),
          detail: nativeCapacity.detail,
        });
        const detail = `native target ${opts.nativeConsult.targetBackend} capacity unavailable: ${nativeCapacity.detail}`;
        return { ...give(detail), targetCapacityUnavailable: detail };
      }
    }

    // Every conversion rank ports the same exact source. Check once, before any
    // launch, and retain the refusal on each affected rank for the next-expert
    // cascade. Provider walls and native fork eligibility remain independent.
    let portTranscript: BackendAvailability | null = null;
    // Both port preflight and a fresh brief ground themselves in the same
    // exact cited rows. Cache failures too: another model cannot repair this
    // source. Partial/foreign/duplicate rows never authorize either operation.
    let citedTurns: CitedTranscriptTurn[] | null = null;
    let citedTurnsFailure: string | null = null;
    const readCitedSource = async (): Promise<{ turns: CitedTranscriptTurn[] | null; failure: string | null }> => {
      if (!evidenceSource || citedTurns !== null || citedTurnsFailure !== null) {
        return { turns: citedTurns, failure: citedTurnsFailure };
      }
      try {
        const wanted = [...new Set(evidenceSource.evidence.map((ref) => ref.turn_idx))];
        const rows = await d.readCitedTurns(ctx.workspaceId, evidenceSource.sessionId, wanted);
        if (rows.length !== wanted.length || new Set(rows.map((row) => row.turn_idx)).size !== wanted.length ||
            rows.some((row) => !wanted.includes(row.turn_idx) || !row.text.trim())) {
          citedTurnsFailure = `exact cited turns are not all readable for ${evidenceSource.sessionId} (${wanted.join(', ')})`;
        } else {
          citedTurns = rows;
        }
      } catch (e) {
        citedTurnsFailure = `reading the cited turns of ${evidenceSource.sessionId} failed: ` +
          `${(e as Error)?.message ?? String(e)}`;
      }
      return { turns: citedTurns, failure: citedTurnsFailure };
    };
    // P-002 / D-008: ranks the session port skips ON PURPOSE. When nothing else
    // dispatches, each is retried as a fresh session briefed with cited turns.
    const briefRanks: AllowedExpertModel[] = [];
    for (const rank of ranks) {
      const plan = planDispatchOperation(
        {
          agent: target.agent,
          live: target.live,
          tracked: exactTracked || historical,
          historical,
          role: target.role,
          portStatus: target.portStatus ?? null,
        },
        rank,
      );
      if (plan.operation === null) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation: null,
          outcome: 'skipped',
          reason: plan.reason,
          detail: plan.detail,
        });
        if (BRIEF_FALLBACK_REASONS.has(plan.reason) && !briefAttributionContested) briefRanks.push(rank);
        continue;
      }
      const operation = plan.operation;
      if (operation === 'convert' && !evidenceSource) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation,
          outcome: 'skipped',
          reason: 'evidence-span-unavailable',
          detail: 'cross-model conversion requires exact matched transcript turns; no evidence span was supplied',
        });
        continue;
      }
      if (operation === 'fork' && forkBlockedByPressure) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation,
          outcome: 'skipped',
          reason: 'source-context-critical',
          detail: forkBlockedByPressure,
        });
        continue;
      }
      if (operation === 'fork' && forkBlockedByPoison) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation,
          outcome: 'skipped',
          reason: 'source-transcript-poisoned',
          detail: forkBlockedByPoison,
        });
        continue;
      }

      // Every rank re-probes with its own model: the native target probe above
      // answers provider-wide, and an account can serve one model but refuse
      // another (WI-6554700010030413). Later ranks also see capacity a launch changed.
      const capacity = await d.probeBackendAvailable(rank.agent, ctx.workspaceId, rank.model);
      if (!capacity.available) {
        attempts.push({
          rank: rank.rank,
          agent: rank.agent,
          model: rank.model,
          operation,
          outcome: 'skipped',
          reason: capacity.failureReason ?? 'account-walled',
          ...(capacity.accountRoute ? { accountRoute: capacity.accountRoute } : {}),
          ...(capacity.routeReason ? { accountRouteReason: capacity.routeReason } : {}),
          detail: capacity.detail,
        });
        continue;
      }
      const accountRoute = capacity.accountRoute ?? (providerForBackend(rank.agent) ? 'auto' : 'default');

      if (operation === 'convert') {
        if (!portTranscript) {
          try {
            const cited = await readCitedSource();
            portTranscript = cited.failure || !cited.turns
              ? { available: false, detail: cited.failure ?? 'no cited turns' }
              : await d.checkPortTranscript(target, transcript, {
                  sessionId: evidenceSource!.sessionId,
                  turnIndices: [...new Set(evidenceSource!.evidence.map((ref) => ref.turn_idx))],
                  contextTurns: 2,
                  evidenceTurns: cited.turns.map((row) => ({
                    turnIdx: row.turn_idx, timestamp: row.ts, speaker: row.speaker, text: row.text,
                  })),
                });
          } catch (e) {
            portTranscript = { available: false,
              detail: `session-port transcript preflight failed: ${(e as Error)?.message ?? String(e)}` };
          }
        }
        if (!portTranscript.available) {
          attempts.push({ rank: rank.rank, agent: rank.agent, model: rank.model,
            operation, outcome: 'skipped', reason: 'conversion-unavailable', detail: portTranscript.detail });
          // A fresh answering session can still quote indexed evidence when
          // native porting is impossible. Keep attribution and explicit native
          // trials fail-closed; the brief loop rechecks capacity and closure.
          if (!briefAttributionContested && !opts.nativeConsult) briefRanks.push(rank);
          continue;
        }
      }

      const { attempt, replaced } = await launchAnsweringSessionWithProviderRetry({
        ...opts,
        accountRoute,
        ...(capacity.routeReason ? { accountRouteReason: capacity.routeReason } : {}),
        ...(evidenceSource ? { evidenceSource } : {}),
      }, ctx, d, launchTarget, rank, operation);
      attempts.push(...replaced, attempt.record);
      // Closure is not a failed rank. Continuing would spend more launch
      // capacity on a consult whose terminal answer already won the race.
      if (attempt.record.reason === 'consult-closed' || attempt.record.reason === 'kickoff-expiry-refresh-failed') {
        return give(attempt.record.detail);
      }
      // WI-10004645: every fork rank replays the SAME source history, and a
      // "Tool reference … not found" first reply comes from a reference in that
      // history the fork's toolset lacks. Once one fork of this source is
      // rejected that way, the other fork ranks would be too (measured: rank 2
      // re-forked the source rank 1 had just failed on, and died identically).
      // Conversions re-render the history, so they stay eligible.
      if (operation === 'fork' && attempt.record.reason === 'first-turn-rejected' && !forkBlockedByPoison) {
        forkBlockedByPoison =
          `rank #${rank.rank} (${rank.agent}/${rank.model}) forked ${target.ownerId ?? 'the source'} and its ` +
          'first reply was a provider rejection; every fork replays the same ' +
          'source history, so the remaining fork ranks would fail the same way';
      }
      if (attempt.record.outcome === 'dispatched') {
        return {
          dispatched: true,
          answeringOwnerId: attempt.answeringOwnerId,
          operation,
          agent: rank.agent,
          model: rank.model,
          verified: attempt.verified,
          detail: attempt.record.detail,
          attempts,
        };
      }
    }

    // P-002 / D-008: the expert cannot be forked or converted on purpose, so
    // launch a FRESH session under its own identity, briefed with the expert's
    // cited turns. Every brief rank leaves a recorded outcome (R-12).
    for (const rank of briefRanks) {
      const base = { rank: rank.rank, agent: rank.agent, model: rank.model, operation: 'brief' as const };
      if (!evidenceSource) {
        attempts.push({ ...base, outcome: 'skipped', reason: 'evidence-span-unavailable',
          detail: 'a cited-turn brief needs router-matched transcript turns; no evidence span was supplied' });
        continue;
      }
      const { turns: citedTurns, failure: citedTurnsFailure } = await readCitedSource();
      if (citedTurnsFailure || !citedTurns || citedTurns.length === 0) {
        attempts.push({ ...base, outcome: 'skipped', reason: 'evidence-span-unavailable',
          detail: citedTurnsFailure ?? 'no cited turns' });
        continue;
      }
      const capacity = await d.probeBackendAvailable(rank.agent, ctx.workspaceId, rank.model);
      if (!capacity.available) {
        attempts.push({
          ...base,
          outcome: 'skipped',
          reason: capacity.failureReason ?? 'account-walled',
          ...(capacity.accountRoute ? { accountRoute: capacity.accountRoute } : {}),
          ...(capacity.routeReason ? { accountRouteReason: capacity.routeReason } : {}),
          detail: capacity.detail,
        });
        continue;
      }
      const accountRoute = capacity.accountRoute ?? (providerForBackend(rank.agent) ? 'auto' : 'default');
      const { attempt, replaced } = await launchAnsweringSessionWithProviderRetry({
        ...opts,
        evidenceSource,
        citedTurns,
        accountRoute,
        ...(capacity.routeReason ? { accountRouteReason: capacity.routeReason } : {}),
      }, ctx, d, target, rank, 'brief');
      attempts.push(...replaced, attempt.record);
      if (attempt.record.reason === 'consult-closed') return give(attempt.record.detail);
      if (attempt.record.outcome === 'dispatched') {
        return {
          dispatched: true,
          answeringOwnerId: attempt.answeringOwnerId,
          operation: 'brief',
          agent: rank.agent,
          model: rank.model,
          verified: attempt.verified,
          detail: attempt.record.detail,
          attempts,
        };
      }
    }

    return give(
      `every allowed expert model was exhausted for ${opts.sourceOwnerId} (${attempts.length} rank(s) tried): ` +
        attempts.map((a) => `#${a.rank} ${a.agent}/${a.model} ${a.reason ?? a.outcome}`).join('; '),
    );
  } catch (e) {
    return give(`dispatch threw: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** One rank's launch. Never throws — a thrown launcher error is this rank's
 *  failure, and the walk owns what happens next. */
/**
 * WI-6554700010018146: launches one rank may spend when its first reply is a
 * transient provider error. The fault is the provider's, not the responder's, so
 * the same rank earns one more launch before the walk moves past it; a second
 * provider error cascades, so a provider outage cannot hold the walk on one rank.
 */
export const PROVIDER_ERROR_LAUNCHES_PER_RANK = 2;

/**
 * {@link launchAnsweringSession}, relaunched while its first reply is a transient
 * provider error and launches remain. Returns the final launch plus the records of
 * the launches it replaced, which the caller records in order before the final one.
 */
async function launchAnsweringSessionWithProviderRetry(
  ...args: Parameters<typeof launchAnsweringSession>
): Promise<{ attempt: Awaited<ReturnType<typeof launchAnsweringSession>>; replaced: ConsultDispatchAttempt[] }> {
  const replaced: ConsultDispatchAttempt[] = [];
  for (let launch = 1; ; launch += 1) {
    const attempt = await launchAnsweringSession(...args);
    if (attempt.record.reason !== 'first-turn-provider-error' || launch >= PROVIDER_ERROR_LAUNCHES_PER_RANK) {
      return { attempt, replaced };
    }
    replaced.push({
      ...attempt.record,
      detail: `${attempt.record.detail} Relaunching the same rank (launch ${launch} of ` +
        `${PROVIDER_ERROR_LAUNCHES_PER_RANK}): the provider failed, not the responder.`,
    });
  }
}

async function launchAnsweringSession(
  opts: {
    sourceOwnerId: string;
    conversationId: string;
    evidenceSource?: ConsultEvidenceSource;
    accountRoute?: ConsultAccountRoute;
    accountRouteReason?: string;
    /** `brief` only: the cited turns quoted into the fresh session's kickoff. */
    citedTurns?: CitedTranscriptTurn[];
    brief: string | ((operation: DispatchOperation) => string);
    onAnsweringOwner?: (answeringOwnerId: string) => void | Promise<void>;
    onKickoff?: (kickoffAt: string, answeringOwnerId: string) => boolean | Promise<boolean>;
    checkApprover?: import('./acceptance-bar-amendment-review').AmendmentReviewerScreen;
  },
  ctx: ConsultDispatchContext,
  d: ConsultDispatchDeps,
  target: ResumeTarget,
  rank: AllowedExpertModel,
  operation: DispatchOperation,
): Promise<{ record: ConsultDispatchAttempt; answeringOwnerId: string | null; verified: boolean | null }> {
  const base = {
    rank: rank.rank,
    agent: rank.agent,
    model: rank.model,
    operation,
    ...(opts.accountRouteReason ? {
      accountRoute: opts.accountRoute ?? (providerForBackend(rank.agent) ? 'auto' : 'default'),
      accountRouteReason: opts.accountRouteReason,
    } : {}),
  } as const;
  const failed = (reason: DispatchSkipReason, detail: string) => ({
    record: { ...base, outcome: 'failed' as const, reason, detail },
    answeringOwnerId: null,
    verified: null,
  });
  const skipped = (reason: DispatchSkipReason, detail: string) => ({
    record: { ...base, outcome: 'skipped' as const, reason, detail },
    answeringOwnerId: null,
    verified: null,
  });
  const consultClosed = () => skipped(
    'consult-closed',
    `consult ${opts.conversationId} is no longer open; skipped ${rank.agent}/${rank.model} before spawn`,
  );

  // Both the tracked fork and the prepared port bind a new answering identity
  // before the child can reply; the expert retains its own identity and work.
  const answeringOwnerId = d.mintOwnerId();
  if (!answeringOwnerId) {
    return failed(
      'launch-failed',
      'the source session records no coord identity, so a conversion has no identity to continue',
    );
  }

  let cmd: string;
  try {
    cmd = operation === 'brief'
      // P-002 / D-008: a FRESH session on the rank's backend. It names no source
      // session, so nothing of the expert's transcript is replayed or ported.
      ? d.buildAgentLaunchCommand({
          mode: 'fresh',
          agent: rank.agent,
          model: rank.model,
          modelSource: 'explicit',
          headless: true,
          account: opts.accountRoute ?? (providerForBackend(rank.agent) ? 'auto' : 'default'),
          ownerId: answeringOwnerId,
        })
      : d.buildAgentLaunchCommand({
      mode: operation === 'fork' ? 'fork' : 'resume',
      sessionId: target.sessionId,
      resumeId: target.resumeId ?? target.sessionId,
      agent: target.agent,
      // P-002/R-12: name the TARGET backend explicitly on a conversion. Omitting
      // it lets psu back-fill the backend from the model name alone, which
      // silently degrades the conversion into a same-backend resume.
      ...(operation === 'convert' ? { targetAgent: rank.agent } : {}),
      model: rank.model,
      modelSource: 'explicit',
      headless: true,
      // The wall probe measures the provider pool. Route pooled Claude/Codex
      // launches through that same pool so another account's headroom is usable.
      account: opts.accountRoute ?? (providerForBackend(rank.agent) ? 'auto' : 'default'),
      ownerId: answeringOwnerId,
    });
  } catch (e) {
    // The composer refuses commands psu would reject at boot (an impossible
    // conversion, a model-less codex port). That is this rank's failure, not
    // the consult's.
    return failed('launch-failed', `launch command could not be composed: ${(e as Error)?.message ?? String(e)}`);
  }
  // Both operations mint a child answering identity, so the requester is its
  // launch parent. The expert remains the transcript source only.
  cmd = d.injectLaunchedByArg(cmd, ctx.launchedBy).command;

  let envelope: Awaited<ReturnType<typeof buildConsoleEnvelope>>;
  try {
    const operatorBaseUrl = ctx.launchOperatorBaseUrl ?? resolveSpawnHostOperatorBaseUrl();
    if (ctx.launchOperatorBaseUrl !== undefined) {
      const url = new URL(operatorBaseUrl);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
          !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash ||
          (ctx.launchOperatorHost !== undefined && ctx.launchOperatorHost !== hostname())) {
        throw new Error('saved consult launch runtime is invalid or belongs to another machine');
      }
    }
    envelope = await d.buildConsoleEnvelope({
      workspaceId: ctx.workspaceId,
      slug: ctx.harnessSlug,
      operatorBaseUrl,
      // The default console MCP endpoint is the long-lived live proxy. A
      // consult must prepare and answer on its accepting runtime: staging and
      // background source guards may differ from the deployed live build.
      agentMcpBaseUrl: operatorBaseUrl,
      // The answering session is an MCP-connected agent (it must call
      // consult:reply), not a bare command.
      skipMcpJson: false,
    });
  } catch (e) {
    return failed('launch-failed', `console envelope failed: ${(e as Error)?.message ?? String(e)}`);
  }

  // Codex stores its rollout in a per-adv-session home; the transcript preflight
  // read that exact root, so carry it through the detached psu boundary or psu
  // can resume against a different home and report the source rollout missing.
  const codexHome = target.agent === 'codex' && operation !== 'brief'
    ? codexHomeForSessionKey(target.advSessionId) : null;
  // A fork can run its first turn before spawnHeadless returns: it starts the
  // child, then waits for boot/kickoff receipts. Persist the participant before
  // crossing that boundary. If the reservation fails, do not launch a child
  // whose consult:reply would be refused as not_a_participant.
  if (!(await d.isConsultOpen(ctx.workspaceId, opts.conversationId))) return consultClosed();
  if (opts.onAnsweringOwner) {
    try {
      await opts.onAnsweringOwner(answeringOwnerId);
    } catch {
      return failed(
        'answering-owner-stamp-failed',
        'could not persist the answering identity before spawn; no session was launched',
      );
    }
  }
  if (opts.checkApprover) {
    try {
      // The reservation above writes source→answerer before this fresh canonical
      // read. Do not reuse a preselection closure: its lineage cache predates it.
      if (!opts.onAnsweringOwner) return failed('approval-ineligible', 'method review requires a durable answering-owner reservation');
      const verdict = await opts.checkApprover(answeringOwnerId);
      if (verdict.eligible !== true) return failed('approval-ineligible', `method_review_answerer_ineligible: ${verdict.reason}`);
    } catch (error) {
      return failed('approval-ineligible', `method_review_answerer_screen_failed: ${String(error)}`);
    }
  }
  // The answer-owner stamp is async too. Close can win while it is writing, so
  // validate again immediately before crossing the side-effecting spawn seam.
  if (!(await d.isConsultOpen(ctx.workspaceId, opts.conversationId))) return consultClosed();

  let spawnLease: ConsultSpawnLease | null = null;
  const releaseSpawnLease = async (): Promise<void> => {
    const lease = spawnLease;
    if (!lease) return;
    spawnLease = null;
    await lease.release();
  };
  let spawn: Awaited<ReturnType<ConsultDispatchDeps['spawnHeadless']>>;
  try {
    spawn = await d.spawnHeadless({
    envelope: {
      ...envelope,
      env: {
        ...envelope.env,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        // The brief rides the ENV, never a --kickoff= value: free-form text
        // inside the console greeting one-liner breaks the shell.
        PAPERCUSP_KICKOFF_PROMPT:
          `${typeof opts.brief === 'function' ? opts.brief(operation) : opts.brief}` +
          (operation === 'brief' && opts.evidenceSource
            ? `\n\n${renderCitedTurnsBlock({ ownerId: opts.sourceOwnerId, sessionId: opts.evidenceSource.sessionId },
                opts.citedTurns ?? [])}`
            : opts.evidenceSource
            ? `\n\nEXACT TRANSCRIPT EVIDENCE: ${opts.evidenceSource.evidence
                .map((ref) => `${ref.session_id}#${ref.turn_idx}`).join('; ')}. ` +
              `These refs belong to this source session; use them as the grounding span.`
            : ''),
        ...(operation === 'convert' && opts.evidenceSource
          ? {
              PAPERCUSP_CONSULT_EVIDENCE_SPAN: JSON.stringify({
                sessionId: opts.evidenceSource.sessionId,
                turnIndices: opts.evidenceSource.evidence.map((ref) => ref.turn_idx),
                contextTurns: 2,
              }),
            }
          : {}),
      },
      greetingCmd: cmd,
      cwd: operation === 'brief' ? envelope.cwd : target.cwd ?? envelope.cwd,
    },
    // The envelope contains the superuser MCP door, but spawnHeadless only
    // materializes it in the fork's cwd when explicitly enabled. The answer
    // session must be able to call consult:reply from its first turn.
    writeMcpJson: true,
    label: `consult-${operation} · ${answeringOwnerId.slice(0, 16)}`,
    logDir: join(papercuspPathForWorkspace(ctx.workspaceId), 'fleet-logs'),
    launchedBy: ctx.launchedBy ?? undefined,
    fleetSlug: null,
    coordOwnerId: answeringOwnerId,
    // EI-24106882795589775: an answering session is single-purpose, but a headless
    // interactive CLI does not exit when it ends its turn — "reply, then END YOUR
    // TURN" leaves an idle TUI alive, and its presence keepalive keeps vouching for
    // it. Recording WHAT this session answers lets the task reaper end it the
    // moment that consult is settled for it (`consult-settled`), keyed on this
    // exact ledger row — never on the owner id, which a conversion shares with
    // the expert's own, possibly live, session. `sourceOwnerId` is the expert this
    // session answers for — the reaper locates its cascade slot by it, because the
    // `answeringOwnerId` stamp on the selection is absent on most consults.
    ledgerDetail: {
      consultAnswer: {
        conversationId: opts.conversationId,
        operation,
        answeringOwnerId,
        sourceOwnerId: opts.sourceOwnerId,
      },
    },
    kickoffProof: true,
    beforeSpawn: async () => {
      spawnLease = await d.reserveConsultSpawnLease(ctx.workspaceId, opts.conversationId);
      return spawnLease !== null;
    },
    afterSpawn: releaseSpawnLease,
    });
  } finally {
    // Also release when the spawn implementation errors before it can invoke
    // afterSpawn; successful console-spawn releases immediately after spawn().
    await releaseSpawnLease();
  }
  if (spawn.status !== 'ok') {
    if (spawn.cancelled) return consultClosed();
    const launchError = await d.readLaunchLogReason(spawn.logPath);
    const result = failed(
      'launch-failed',
      `spawn failed (code ${spawn.code}): ${spawn.error}` +
        (spawn.logPath ? `; log ${spawn.logPath}` : '') +
        (launchError ? `; launcher said: ${launchError}` : ''),
    );
    return {
      ...result,
      record: {
        ...result.record,
        ...(spawn.logPath ? { launchLogPath: spawn.logPath } : {}),
        ...(launchError ? { launchError } : {}),
      },
    };
  }
  // A detached spawn can report `ok` after the shell starts even when the
  // command never submitted the brief. Require the host's parent-visible native
  // transcript receipt before treating this rank as dispatched — an unsubmitted
  // brief would otherwise create a phantom responder the consult waits on.
  if (spawn.kickoffProof?.persisted !== true) {
    // The walk is about to launch another rank; this one must not outlive the
    // verdict (see defaultStopFailedLaunch). It never ran a turn, so its row is
    // closed as never-ran rather than left for the idle reaper (WI-10006690).
    const stopped = await d.stopFailedLaunch(spawn.taskId, { answeringOwnerId });
    const launchError = await d.readLaunchLogReason(spawn.logPath);
    const result = failed(
      'kickoff-not-persisted',
      `spawn did not persist its kickoff in the native transcript ` +
        `(${spawn.kickoffProof?.reason ?? 'kickoff-proof-missing'}; log ${spawn.logPath ?? '?'}); ${stopped}` +
        (launchError ? `; launcher said: ${launchError}` : ''),
    );
    return {
      ...result,
      record: {
        ...result.record,
        ...(spawn.logPath ? { launchLogPath: spawn.logPath } : {}),
        ...(launchError ? { launchError } : {}),
      },
    };
  }
  // The first-turn wait below is bounded from this instant (WI-10004645).
  const kickoffSeenAtMs = d.nowMs();
  if (opts.onKickoff) {
    let refreshed = false;
    let refreshError: string | null = null;
    try {
      refreshed = await opts.onKickoff(new Date(kickoffSeenAtMs).toISOString(), answeringOwnerId);
    } catch (error) {
      refreshError = String(error).slice(0, 300);
    }
    if (!refreshed) {
      let stopped: string;
      try {
        stopped = await d.stopFailedLaunch(spawn.taskId);
      } catch (error) {
        stopped = `stop failed: ${String(error).slice(0, 200)}`;
      }
      return {
        record: {
          ...base,
          outcome: 'failed',
          reason: 'kickoff-expiry-refresh-failed',
          detail: `native kickoff was persisted, but the selected reply window could not be refreshed` +
            `${refreshError ? ` (${refreshError})` : ''}; stopped the answering child: ${stopped}`,
        },
        answeringOwnerId: null,
        verified: null,
      };
    }
  }

  // Race host registration against a durable child-death observation, so the
  // result cannot report a booting session for a process that already died.
  const verifyPromise = d.verifyResumeStarted(answeringOwnerId, { timeoutMs: DISPATCH_VERIFY_TIMEOUT_MS });
  let verify: Awaited<ReturnType<typeof d.verifyResumeStarted>>;
  if (spawn.childExit) {
    const winner = await Promise.race([
      verifyPromise.then((result) => ({ kind: 'verify' as const, result })),
      spawn.childExit.then((exit) => ({ kind: 'exit' as const, exit })),
    ]);
    if (winner.kind === 'exit') {
      const failure = childExitFailure(winner.exit);
      if (failure) {
        // The root died, but its scope can still hold descendants (MCP servers,
        // wrapper chains) — clear it before reporting the rank failed. The host
        // never registered, so its row is closed as never-ran (WI-10006690).
        await d.stopFailedLaunch(spawn.taskId, { answeringOwnerId });
        const launchError = await d.readLaunchLogReason(spawn.logPath);
        return {
          record: {
            ...base,
            outcome: 'failed',
            reason: 'launch-exited',
            detail:
              `${failure} before ${answeringOwnerId} registered a live host (log ${spawn.logPath ?? '?'})` +
              (launchError ? `; launcher said: ${launchError}` : ''),
            ...(launchError ? { launchError } : {}),
            ...(spawn.logPath ? { launchLogPath: spawn.logPath } : {}),
          },
          answeringOwnerId: null,
          verified: false,
        };
      }
      // A clean exit is not the targeted failure, but it cannot establish
      // liveness either — keep the three-state host verdict.
      verify = await verifyPromise;
    } else {
      verify = winner.result;
    }
  } else {
    verify = await verifyPromise;
  }

  // WI-10004260 (part B): the kickoff receipt names the answering session's own
  // native transcript. If its first reply is already a provider "Tool reference
  // … not found" 400, this session is dead on arrival, even though its host
  // may register as live: Claude Code shows the error and waits for input. Measured
  // on an acceptance consult: the fork recorded 'dispatched', then held the
  // grading slot silently until its cascade expiry.
  //
  // WI-10004645: reading once, right after the verification wait, was not
  // enough. That wait can return in milliseconds, before the reply exists — a
  // fork recorded 'dispatched' 2.2s before its 400 landed. And a fork's file
  // carries the source's copied history, so an assistant record does not by
  // itself mean the fork has replied. So: wait, bounded from the kickoff, for
  // the first assistant record AFTER the fork's own prompt, then judge that
  // reply. Expiry or an unreadable transcript keeps the dispatch (no reply yet
  // is not a rejection), so this can turn a dead dispatch into a fast cascade
  // but never refuse a good one.
  const answeringTranscript = spawn.kickoffProof?.nativeRef;
  // Set when the transcript was readable but no reply had landed by the bound;
  // the dispatch stands, and its record says the first turn was not judged.
  let firstTurnUnjudgedAfterMs: number | null = null;
  // What the expiry sweep re-reads to judge that reply later (EI-27111739698817170).
  let firstTurnUnjudged: FirstTurnUnjudged | undefined;
  // Set when a Claude rank's first reply could not be judged at all: the kickoff
  // proof named no native transcript, or the transcript was unreadable. Neither
  // is evidence of a rejection, so the dispatch stands — but the record must say
  // the check did not run. A silent record reads exactly like a fork whose first
  // reply was judged clean, which hid a dead-on-arrival fork (WI-10006676).
  let firstTurnUncheckedReason: string | null = null;
  // WI-6554700010029533: Codex ranks are judged too. Their kickoff proof names the
  // rollout, and a Codex convert walled by a usage limit on its first turn otherwise
  // held its cascade slot until bounded pickup recovery (measured 13-27 min).
  const judgesFirstTurn = rank.agent === 'claude' || rank.agent === 'codex';
  if (judgesFirstTurn && !(typeof answeringTranscript === 'string' && answeringTranscript.endsWith('.jsonl'))) {
    firstTurnUncheckedReason = 'the kickoff proof named no native transcript';
  }
  if (judgesFirstTurn && typeof answeringTranscript === 'string' && answeringTranscript.endsWith('.jsonl')) {
    const judgedAgent = rank.agent as 'claude' | 'codex';
    let rejection: FirstTurnRejection | null = null;
    const deadline = kickoffSeenAtMs + FIRST_TURN_WAIT_MS;
    // The read-count bound is independent of the clock, so a stalled clock
    // cannot turn this into an unbounded loop.
    const maxPolls = Math.ceil(FIRST_TURN_WAIT_MS / FIRST_TURN_POLL_MS);
    let readable = true;
    let replied = false;
    for (let poll = 0; ; poll += 1) {
      const analysis = readFirstTurnAnalysis(judgedAgent, answeringTranscript, d);
      if (!analysis) {
        // Unreadable is not evidence of a rejection; keep the dispatch.
        readable = false;
        break;
      }
      if (analysis.assistantTurnsSinceLastPrompt > 0) {
        replied = true;
        // A transient provider error stops this session, and the walk relaunches
        // this rank once before moving on (WI-6554700010018146).
        rejection = firstTurnRejection(analysis);
        break;
      }
      const remainingMs = deadline - d.nowMs();
      if (poll >= maxPolls || remainingMs <= 0) break;
      await d.sleepMs(Math.min(FIRST_TURN_POLL_MS, remainingMs));
    }
    if (readable && !replied) {
      firstTurnUnjudgedAfterMs = Math.max(0, d.nowMs() - kickoffSeenAtMs);
      // EI-27111739698817170: the window closing is not the end of the check. The
      // expiry sweep re-judges this transcript with the same classifier.
      firstTurnUnjudged = {
        agent: judgedAgent,
        transcriptPath: answeringTranscript,
        kickoffAt: new Date(kickoffSeenAtMs).toISOString(),
      };
    }
    if (!readable) firstTurnUncheckedReason = `its transcript ${answeringTranscript} could not be read`;
    if (rejection) {
      const stopped = await d.stopFailedLaunch(spawn.taskId);
      return {
        record: {
          ...base,
          outcome: 'failed',
          // Walk onward after recording the rejection.
          reason: firstTurnRejectionReason(rejection),
          detail:
            `${operation} of ${opts.sourceOwnerId} → ${rank.agent}/${rank.model} as ${answeringOwnerId}: ` +
            describeFirstTurnRejection(rejection, 'transient provider error') +
            ` in ${answeringTranscript}; ${stopped}`,
        },
        answeringOwnerId: null,
        verified: false,
      };
    }
  }

  const firstTurnNote = firstTurnUnjudgedAfterMs !== null
    ? ` First reply not written ${firstTurnUnjudgedAfterMs}ms after kickoff, so it was not checked for a ` +
      'provider rejection yet; the consult expiry sweep re-checks it.'
    : firstTurnUncheckedReason
      ? ` First reply not checked for a provider rejection: ${firstTurnUncheckedReason}.`
      : '';
  return {
    record: {
      ...base,
      outcome: 'dispatched',
      ...(spawn.logPath ? { launchLogPath: spawn.logPath } : {}),
      detail: (verify.started
        ? `${operation} of ${opts.sourceOwnerId} → ${rank.agent}/${rank.model} as ${answeringOwnerId}: ` +
          `live host registered after ${verify.waitedMs}ms (log ${spawn.logPath ?? '?'}).`
        : `${operation} of ${opts.sourceOwnerId} → ${rank.agent}/${rank.model} as ${answeringOwnerId}: ` +
          `spawned, no live host after ${verify.waitedMs}ms — still booting (NOT a failure; the cascade ` +
          `expiry guards the reply). Log ${spawn.logPath ?? '?'}.`) + firstTurnNote,
      ...(firstTurnUnjudged ? { firstTurnUnjudged } : {}),
      // An interim message is not a completed consult. Retain the same native
      // evidence pointer until its answer, so a later terminal provider error
      // can be handled by the existing expiry/cascade path.
      ...(judgesFirstTurn && typeof answeringTranscript === 'string' && answeringTranscript.endsWith('.jsonl')
        ? { answeringTurn: {
            agent: rank.agent as 'claude' | 'codex',
            transcriptPath: answeringTranscript,
            kickoffAt: new Date(kickoffSeenAtMs).toISOString(),
          } }
        : {}),
    },
    answeringOwnerId,
    verified: verify.started ? true : null,
  };
}

/** Bind the consult dispatch seam for a given requester context. */
export function makeConsultDispatcher(
  ctx: ConsultDispatchContext,
  deps: Partial<ConsultDispatchDeps> = {},
): (opts: { sourceOwnerId: string; conversationId: string; brief: string; evidence?: ConsultDispatchEvidenceRef[] }) => Promise<ConsultDispatchResult> {
  return (opts) => dispatchConsultResponder(opts, ctx, deps);
}

/**
 * The first turn the answering session receives. The `summary`/`body` handed to
 * the old wake seam already say why this expert was routed and which verbs
 * settle the consult, so they carry over verbatim — a brief and a wake body want
 * the same content. What changes is the FRAME: this session was launched FOR the
 * consult and has no inbox notification to discover it in, so the brief must
 * state the conversation id and that answering is the whole job.
 *
 * P-004 owns the full answer-only posture (reply-then-end, nothing inherited);
 * this is the delivery frame P-003 needs to make the launch answerable at all.
 */
export function consultDispatchBrief(input: {
  conversationId: string;
  sourceOwnerId: string;
  operation: DispatchOperation;
  summary: string;
  body: string;
}): string {
  // The complete request is already persisted on this conversation before the
  // delivery seam runs. Reuse that read door instead of submitting an oversized
  // duplicate to the native client; never clip the review's actual evidence.
  const request = input.summary.length + input.body.length <= CONSULT_INLINE_REQUEST_MAX
    ? `${input.summary}\n\n${input.body}`
    : `${clip(input.summary, 1_000)}\n\n` +
      `The complete request is stored on conversation ${input.conversationId}; it is not truncated. ` +
      `Read results[0].conversation.body and all replies before judging. If a response is truncated, ` +
      `use capability:read with its returned cursor arguments, follow next_cursor until eof:true ` +
      `and next_cursor:null, and recover every omitted source block before answering.\n\n` +
      consultResponderVerbMenu({ conversationId: input.conversationId });
  const provenance =
    input.operation === 'fork'
      ? `You are a FORK of ${input.sourceOwnerId}'s session: their history is above, and you are a NEW ` +
        `identity running alongside them. They were NOT notified and must not be. The inherited ` +
        `transcript is historical evidence.`
      : input.operation === 'brief'
      ? `You are a FRESH answering session, briefed with turns CITED from ${input.sourceOwnerId}'s transcript. ` +
        `You did NOT inherit or continue their session: the quoted turns below are historical evidence. ` +
        `You are a NEW identity; their claims, locks, modes and work stay with them. They were NOT notified ` +
        `and must not be.`
      : `You are an isolated answering session using ${input.sourceOwnerId}'s exact transcript: their history ` +
        `was carried across as evidence. You are a NEW identity; their claims, locks, modes and work stay ` +
        `with them. They were NOT notified and must not be.`;
  return (
    `🧭 CONSULT — you were launched to answer ONE question, on consult conversation ${input.conversationId}.\n` +
    `${provenance}\n\n` +
    `The request below sets the review subject and evidence standard. Transcript provenance does not ` +
    `restrict a current-subject or first-principles review to older history. Read the complete request ` +
    `and cited evidence, distinguish what you verified from what you cannot ground, and never treat ` +
    `an unrelated transcript as proof of the current subject.\n\n` +
    // P-004 answer-only posture. The brief is the ONLY thing that shapes this
    // session's behaviour — it boots with a fresh identity, no fleet, no loop
    // and no claims — so the posture has to be stated here or the inherited
    // transcript's agenda becomes this session's agenda. A fork reads its own
    // history as "what I was doing", which is precisely the failure: it would
    // resume the source's work under a new id, double-claiming their lane.
    `⛔ ANSWER-ONLY — this session exists for this ONE question and ends with it.\n` +
    `Reply (or decline) on the conversation above, then END YOUR TURN. Do NOT resume ` +
    `whatever the inherited transcript was doing: that work belongs to the session it ` +
    `came from, which is still its owner and was NOT notified. Do not claim work-items, ` +
    `do not arm a loop, do not start a plan, do not edit files. Your transcript is ` +
    `EVIDENCE to answer from, not an agenda to continue.\n\n` +
    request
  );
}

/**
 * The consult DELIVERY seam, in the shape every consult call site already binds
 * (`{ responder, conversationId, summary, body }` → a delivery count).
 *
 * D-010: the seam's SHAPE is preserved and its MEANING replaced. `responder` is
 * now the expert whose TRANSCRIPT answers, not an agent to ping; a non-zero
 * count means an answering session was launched from that transcript, and zero
 * means the whole allowlist was exhausted for them — which every caller already
 * treats as "advance to the next expert".
 *
 * `pickupConfirmed` is honest in a way the wake seam could not be: a launch with
 * a persisted native kickoff receipt AND a registered live host is a STARTED
 * turn, not a queued delivery. A still-booting launch reports the delivery
 * without claiming pickup.
 */
export function makeConsultReachDispatcher(
  ctx: ConsultDispatchContext,
  deps: Partial<ConsultDispatchDeps> = {},
): (opts: {
  responder: string;
  conversationId: string;
  summary: string;
  body: string;
  evidence?: ConsultDispatchEvidenceRef[];
  /** Persist the answering identity before a fork is launched, or before a
   *  conversion's verification wait, so the first reply is already authorized. */
  onAnsweringOwner?: (answeringOwnerId: string) => void | Promise<void>;
  /** Refresh a cascade reply deadline after native kickoff persistence. */
  onKickoff?: (kickoffAt: string, answeringOwnerId: string) => boolean | Promise<boolean>;
}) => Promise<{
  queued: number;
  woke: number;
  pickupConfirmed: boolean;
  answeringOwnerId: string | null;
  dispatch: ConsultDispatchResult;
  targetCapacityUnavailable?: string;
}> {
  return async (opts) => {
    // The routed consult's saved snapshot is the authority on later reply,
    // decline and expiry cascades. A closure from the initial call is gone by
    // then, so never rely on it to keep the model constraint.
    const choice = deps.readDispatchChoice ? await deps.readDispatchChoice(ctx.workspaceId, opts.conversationId)
      : deps.readReviewerModel ? { reviewerModel: await deps.readReviewerModel(ctx.workspaceId, opts.conversationId), nativeConsult: null }
      : await readPersistedDispatchChoice(ctx.workspaceId, opts.conversationId);
    const { reviewerModel, nativeConsult } = choice;
    const methodReview = 'methodReview' in choice ? choice.methodReview : undefined;
    const checkApprover = methodReview ? async (ownerId: string) => {
      const check = deps.checkApprover ?? (await import('../rubrics')).checkAcceptanceBarApproverEligibility;
      return check({ ...methodReview, ownerId });
    } : undefined;
    // Initial getFeedbackProd binds workspace ranks itself. Later decline and
    // expiry writers construct a new dispatcher, so load that same workspace
    // setting here instead of comparing the saved choice against the seed.
    const dispatchDeps = (reviewerModel || nativeConsult) && !deps.loadRanks
      ? {
          ...deps,
          loadRanks: (workspaceId: string) =>
            import('./expert-routing-settings')
              .then(async ({ readConsultExpertRoutingSettings, bindConsultExpertRoutingSettings }) =>
                bindConsultExpertRoutingSettings(await readConsultExpertRoutingSettings(workspaceId)).loadRanks(workspaceId)),
        }
      : deps;
    const dispatch = await dispatchConsultResponder(
      {
        sourceOwnerId: opts.responder,
        conversationId: opts.conversationId,
        ...(reviewerModel ? { reviewerModel } : {}),
        ...(nativeConsult ? { nativeConsult } : {}),
        ...(checkApprover ? { checkApprover } : {}),
        ...(opts.evidence ? { evidence: opts.evidence } : {}),
        ...(opts.onAnsweringOwner ? { onAnsweringOwner: opts.onAnsweringOwner } : {}),
        ...(opts.onKickoff ? { onKickoff: opts.onKickoff } : {}),
        // Per-rank, because a walled rank-1 can turn a fork into a conversion and
        // the two inherit history differently.
        brief: (operation) =>
          consultDispatchBrief({
            conversationId: opts.conversationId,
            sourceOwnerId: opts.responder,
            operation,
            summary: opts.summary,
            body: opts.body,
          }),
      },
      'launchOperatorBaseUrl' in choice && choice.launchOperatorBaseUrl
        ? { ...ctx, launchOperatorBaseUrl: choice.launchOperatorBaseUrl,
            launchOperatorHost: choice.launchOperatorHost }
        : ctx,
      dispatchDeps,
    );
    const pickupConfirmed = dispatch.dispatched && dispatch.verified === true;
    return {
      queued: dispatch.dispatched ? 1 : 0,
      woke: pickupConfirmed ? 1 : 0,
      pickupConfirmed,
      answeringOwnerId: dispatch.answeringOwnerId,
      ...(dispatch.targetCapacityUnavailable ? { targetCapacityUnavailable: dispatch.targetCapacityUnavailable } : {}),
      dispatch,
    };
  };
}

/** Interactive disposition calls accept the next launch before returning.
 * Recovery is owned by consult_state and the existing expiry sweep. */
export function makeDeferredConsultReachDispatcher(ctx: ConsultDispatchContext, deps: {
  getSql?: () => import('postgres').Sql;
  continueDispatch?: typeof continueCascadeDispatchProd;
} = {}) {
  return async (opts: Parameters<ReturnType<typeof makeConsultReachDispatcher>>[0]) => {
    const [{ getOrgPg }, { queueCascadeDispatch }] = await Promise.all([
      import('@papercusp/db-org'), import('./cascade-core'),
    ]);
    if (!(await queueCascadeDispatch(deps.getSql?.() ?? getOrgPg().sql, ctx.workspaceId, opts))) {
      return { woke: 0, answeringOwnerId: null };
    }
    void (deps.continueDispatch ?? continueCascadeDispatchProd)(ctx.workspaceId, opts.conversationId, ctx).catch(() => {});
    return { woke: 0, pending: true };
  };
}

export async function continueCascadeDispatchProd(
  workspaceId: string, conversationId: string, context?: ConsultDispatchContext,
  options: Pick<Partial<ConsultDispatchDeps>, 'loadRanks'> = {},
): Promise<boolean> {
  const [{ getOrgPg }, { continueCascadeDispatchCore }] = await Promise.all([
    import('@papercusp/db-org'), import('./cascade-core'),
  ]);
  const sql = getOrgPg().sql;
  // Initial delivery carries the same settings snapshot used for routing.
  // A recovered delivery has no closure: restore the persisted workspace
  // policy rather than silently falling back to the hardcoded seed models.
  const loadRanks = options.loadRanks ?? (await import('./expert-routing-settings')
    .then(async ({ readConsultExpertRoutingSettings, bindConsultExpertRoutingSettings }) =>
      bindConsultExpertRoutingSettings(await readConsultExpertRoutingSettings(workspaceId)).loadRanks));
  const [conversation] = await sql<Array<{ harness_slug: string | null }>>`
    SELECT harness_slug FROM harness_shared.coord_conversations
     WHERE workspace_id = ${workspaceId} AND id = ${conversationId}`;
  return continueCascadeDispatchCore(workspaceId, conversationId, {
    getSql: () => sql,
    dispatch: (isCurrent) => makeConsultReachDispatcher(context ?? {
      workspaceId, harnessSlug: conversation?.harness_slug ?? null, launchedBy: 'system:consult-expiry-sweep',
    }, { isConsultOpen: isCurrent, loadRanks }),
  });
}

async function readPersistedDispatchChoice(workspaceId: string, conversationId: string): Promise<{
  reviewerModel: ConsultReviewerModel | null; nativeConsult: NativeConsultConstraints | null;
  methodReview?: { rubricId: string; applierId: string };
  launchOperatorBaseUrl?: string;
  launchOperatorHost?: string;
}> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const [row] = await getOrgPg().sql<Array<{ policy: string | null; reviewer_model: unknown; native_consult: unknown;
    method_rubric: string | null; requester_id: string; launch_base: string | null; launch_host: string | null }>>`
    SELECT routing->>'policy' AS policy, routing->'reviewerModel' AS reviewer_model, routing->'nativeConsult' AS native_consult,
           routing->>'methodReviewRubricRef' AS method_rubric, requester_id,
           routing #>> '{request,payload,launchOperatorBaseUrl}' AS launch_base,
           routing #>> '{request,payload,launchOperatorHost}' AS launch_host
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
  `;
  const nativeConsult = row?.native_consult == null ? null : nativeConsultConstraintsSchema.parse(row.native_consult);
  const { methodReviewTarget } = await import('./selection-policies');
  const rubricId = methodReviewTarget({ policy: row?.policy ?? undefined,
    methodReviewRubricRef: row?.method_rubric ?? undefined });
  if (rubricId && !row?.requester_id?.trim()) throw new Error('method_review_requester_missing');
  const methodReview = rubricId ? { rubricId, applierId: row!.requester_id } : undefined;
  const launchRuntime = row?.launch_base != null ? { launchOperatorBaseUrl: row.launch_base,
    ...(row.launch_host != null ? { launchOperatorHost: row.launch_host } : {}) } : {};
  if (row?.reviewer_model == null) return { reviewerModel: null, nativeConsult,
    ...(methodReview ? { methodReview } : {}), ...launchRuntime };
  if (row.policy !== ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY && row.policy !== RUBRIC_VETTING_POLICY) {
    throw new Error('reviewer model exists outside an authorized review policy');
  }
  const raw = typeof row.reviewer_model === 'string' ? JSON.parse(row.reviewer_model) as unknown : row.reviewer_model;
  if (!raw || typeof raw !== 'object') throw new Error('invalid persisted reviewer model');
  const model = raw as Record<string, unknown>;
  if (!['claude', 'codex', 'omp'].includes(String(model.agent)) ||
    typeof model.model !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(model.model) ||
    (model.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(model.effort)))) {
    throw new Error('invalid persisted reviewer model');
  }
  return { reviewerModel: model as unknown as ConsultReviewerModel, nativeConsult, ...launchRuntime };
}
