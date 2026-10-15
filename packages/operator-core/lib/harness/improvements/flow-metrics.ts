/**
 * flow-metrics.ts — FLOW (not stock) metrics for the self-improvement loop
 * (learning-system-audit-improvements-2026-06-09 P-041).
 *
 * The Learning tab's scoreboard counts STOCKS (total captured / open / resolved)
 * — numbers that only ever grow and say nothing about whether the loop is
 * actually cycling. This module computes the FLOWS:
 *
 *   - `captured7d` / `resolved7d` — items created vs resolved/closed in the
 *     trailing 7 days. Resolution time is approximated by `updatedAt` on a
 *     resolved/closed item (the lifecycle write IS the state transition — same
 *     approximation the recurrence-decay clock uses, see digest.ts).
 *   - `medianOpenAgeDays` — is the open backlog fresh churn or sediment?
 *   - `recurringSignatureCount` — passed through from the digest's
 *     `recurringSignatures` (computed once there — NOT re-derived here).
 *   - `watchdog` — is the hard feed-in alive? last tick + ticks/captures in 24h.
 *
 * `computeImprovementFlow` is PURE over injected rows (unit-testable without
 * PG); `readWatchdogFlowTicks` is the thin PG read beside it, using the same
 * `getOrgPg()` access the neighboring watchdog readers use.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { ImprovementCandidate } from './policy';
import type { DispatchStats } from './dispatch-ledger';
import { readAgentReviewState, verificationConflict, verificationParties } from './agent-review-policy';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import type { PullLedgerRow } from '../../agent-tools/scheduler/pull_ledger';
import type { AgentReviewState, VerificationParties } from './agent-review-policy';
import type { WorkItem, listAllWorkItemsForFileExport } from '../../work-items';
import type { resolveFleetMetricScope, selectFleetMetricCurrentItems } from '../../agent-tools/fleet/fleet-metrics-scope';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgentReviewTiming {
  /** Each age has its own writer/basis; null means missing, invalid or ambiguous. */
  reportAgeMs: number | null;
  ledgerRouteAgeMs: number | null;
  reviewWaitMs: number | null;
  revisionAgeMs: number | null;
  admissionDelayMs: number | null;
  enteredAt: string | null;
  round: number | null;
  reviewTimeUnknown: 'no-review' | 'missing-round-time' | 'round-mismatch' | 'invalid-round-time' | null;
}

/** P-030: first routing time is NOT current-round review entry, even on round one. */
export function computeAgentReviewTiming(input: {
  payload: unknown;
  createdAt?: string | null;
  reviewRoutedAtMs: number | null;
  nowMs: number;
}): AgentReviewTiming {
  const object = (x: unknown): Record<string, unknown> =>
    x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
  const payload = object(input.payload);
  const instant = (x: unknown): number | null => {
    if (typeof x !== 'string' || !x.trim()) return null;
    const ms = Date.parse(x);
    return Number.isFinite(ms) && ms >= 0 && ms <= input.nowMs ? ms : null;
  };
  const age = (ms: number | null): number | null => ms == null ? null : input.nowMs - ms;
  const admission = object(payload.admissionReview);
  const admissionEntry = instant(admission.enteredAt);
  const admissionEnd = instant(admission.terminalAt);
  const review = readAgentReviewState(payload);
  const timing = object(object(payload.agentReview).timing);
  const enteredMs = instant(timing.enteredAt);
  const decidedMs = instant(timing.decidedAt);
  const decisionValid = decidedMs != null && enteredMs != null && decidedMs >= enteredMs;
  const reviewTimeUnknown = !review ? 'no-review'
    : !Object.keys(timing).length ? 'missing-round-time'
    : timing.round !== review.round ? 'round-mismatch'
    : enteredMs == null || (review.status === 'pending'
        ? timing.decidedAt !== undefined
        : !decisionValid) ? 'invalid-round-time'
    : null;
  const valid = reviewTimeUnknown === null;
  const routed = input.reviewRoutedAtMs;
  return {
    reportAgeMs: age(instant(input.createdAt)),
    ledgerRouteAgeMs: age(typeof routed === 'number' && Number.isFinite(routed) && routed >= 0 && routed <= input.nowMs ? routed : null),
    reviewWaitMs: valid ? (review!.status === 'pending' ? input.nowMs : decidedMs!) - enteredMs! : null,
    revisionAgeMs: valid && review!.status === 'revision-requested' ? age(decidedMs) : null,
    admissionDelayMs: admissionEntry != null && admissionEnd != null && admissionEnd >= admissionEntry
      ? admissionEnd - admissionEntry : null,
    enteredAt: valid ? new Date(enteredMs!).toISOString() : null,
    round: review?.round ?? null,
    reviewTimeUnknown,
  };
}

export interface AgentReviewServiceScope {
  workspaceId: string;
  harnessSlug: string;
  sinceMs: number;
  nowMs: number;
  /** The measured worker roster, not every agent or human who happened to grade an idea. */
  verifierIds: readonly string[];
  verificationSpecs: readonly { specId: string; revision: number }[];
}

/** Current stock waits, never creation age substituted for a stage-entry clock. */
export function computeQueueWaitingTimes(rows: readonly { payload: unknown; createdAt: string | null }[], nowMs: number) {
  const aggregate = (values: readonly (number | null)[]) => {
    const known = values.filter((value): value is number => value !== null);
    const oldestKnownMs = known.length ? known.reduce((oldest, value) => Math.max(oldest, value), 0) : null;
    return { population: values.length, known: known.length, unknown: values.length - known.length,
      oldestKnownMs, oldestMs: known.length === values.length ? oldestKnownMs : null };
  };
  const reports: (number | null)[] = [], reviews: (number | null)[] = [], revisions: (number | null)[] = [];
  const admissions: (number | null)[] = [], admissionDelays: (number | null)[] = [];
  for (const row of rows) {
    const timing = computeAgentReviewTiming({ ...row, reviewRoutedAtMs: null, nowMs });
    reports.push(timing.reportAgeMs);
    const review = readAgentReviewState(row.payload);
    if (review?.status === 'pending') reviews.push(timing.reviewWaitMs);
    if (review?.status === 'revision-requested') revisions.push(timing.revisionAgeMs);
    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
    const admission = payload.admissionReview && typeof payload.admissionReview === 'object'
      ? payload.admissionReview as Record<string, unknown> : {};
    if (admission.state === 'pending') {
      const entered = typeof admission.enteredAt === 'string' ? Date.parse(admission.enteredAt) : NaN;
      admissions.push(Number.isFinite(entered) && entered >= 0 && entered <= nowMs ? nowMs - entered : null);
    }
    if (admission.state === 'terminal') admissionDelays.push(timing.admissionDelayMs);
  }
  return { unit: 'milliseconds' as const,
    reportAge: aggregate(reports), reviewWait: aggregate(reviews), revisionAge: aggregate(revisions),
    admissionWait: aggregate(admissions), admissionDelay: aggregate(admissionDelays),
    writers: { reportAge: 'work_items.created_ts', reviewWait: 'agentReview.timing.enteredAt (matching round)',
      revisionAge: 'agentReview.timing.decidedAt (matching round)',
      admissionWait: 'admissionReview.enteredAt (recorded pending reviews only)',
      admissionDelay: 'admissionReview.enteredAt -> terminalAt (recorded terminal reviews only)' } };
}

export interface AgentReviewServiceRow {
  id: string;
  workspaceId: string;
  harnessSlug: string;
  state: string;
  payload: unknown;
  createdBy: string | null;
  terminalOwner: string | null;
  createdAt: string | null;
  reviewRoutedAtMs: number | null;
  ledger: { ideaId: string; routedRef: string; grade: number | null; gradedBy: string | null } | null;
}

const REVIEW_HISTORY_MARKER = '\n\nagent-review-round-v1:';

/** Extend the existing dated round comment; no second history store or inferred dates. */
export function agentReviewRoundComment(summary: string, item: {
  id: string; harness: string | null; payload: unknown; createdBy?: string | null; terminalOwner?: string | null;
}, review: AgentReviewState, grade: number, reviewer: string): string {
  return summary + REVIEW_HISTORY_MARKER + JSON.stringify({ id: item.id, harness: item.harness,
    review, grade, reviewer, parties: verificationParties(item) });
}

export interface AgentReviewHistoryPost {
  id: string;
  harnessSlug: string;
  author: string | null;
  body: string;
}

/** Legacy prose is not a dated lifecycle receipt. Missing or conflicting rounds stay unknown. */
export function computeAgentReviewHistory(scope: AgentReviewServiceScope,
  rows: readonly AgentReviewServiceRow[], posts: readonly AgentReviewHistoryPost[]) {
  const subjects = new Map(rows.filter(row => row.workspaceId === scope.workspaceId &&
    row.harnessSlug === scope.harnessSlug).map(row => [row.id, row]));
  const rounds = new Map<string, { fingerprint: string; enteredMs: number; decidedMs: number;
    status: AgentReviewState['status']; reviewer: string; parties: VerificationParties } | null>();
  let invalidReceipts = 0;
  for (const post of posts) {
    const offset = post.body.indexOf(REVIEW_HISTORY_MARKER);
    if (offset < 0 || post.harnessSlug !== scope.harnessSlug) continue;
    try {
      const snapshot = JSON.parse(post.body.slice(offset + REVIEW_HISTORY_MARKER.length));
      const subject = subjects.get(post.id);
      const current = subject && readAgentReviewState(subject.payload);
      const review = readAgentReviewState({ agentReview: snapshot.review });
      const parties = snapshot.parties;
      const enteredMs = Date.parse(review?.timing?.enteredAt ?? '');
      const decidedMs = Date.parse(review?.timing?.decidedAt ?? '');
      if (!current || !review || snapshot.id !== post.id || snapshot.harness !== post.harnessSlug ||
          review.status === 'pending' || review.round >= current.round) continue;
      const key = `${post.id}@${review.round}`;
      if (typeof snapshot.reviewer !== 'string' || snapshot.reviewer !== post.author ||
          !Number.isInteger(snapshot.grade) || snapshot.grade < 1 || snapshot.grade > 5 ||
          (review.status === 'approved' ? snapshot.grade < 4 : snapshot.grade > 3) ||
          !parties || !Array.isArray(parties.reporters) || !Array.isArray(parties.implementers) ||
          ![...parties.reporters, ...parties.implementers].every(id => typeof id === 'string') ||
          !parties.reporters.includes(review.submittedBy) ||
          !Number.isFinite(enteredMs) || !Number.isFinite(decidedMs) || enteredMs < 0 ||
          decidedMs < enteredMs || decidedMs > scope.nowMs) {
        invalidReceipts++; rounds.set(key, null); continue;
      }
      const fingerprint = JSON.stringify(snapshot);
      if (rounds.has(key) && rounds.get(key)?.fingerprint !== fingerprint) rounds.set(key, null);
      else if (!rounds.has(key)) rounds.set(key, { fingerprint, enteredMs, decidedMs,
        status: review.status, reviewer: snapshot.reviewer, parties });
    } catch { invalidReceipts++; }
  }
  let priorRounds = 0, recordedRounds = 0, arrivals = 0, outcomesUnknown = 0;
  const outcomes = { approved: 0, revisionRequested: 0 };
  const workers = new Set(scope.verifierIds);
  for (const row of subjects.values()) priorRounds += (readAgentReviewState(row.payload)?.round ?? 1) - 1;
  for (const receipt of rounds.values()) {
    if (!receipt) continue;
    recordedRounds++;
    if (receipt.enteredMs >= scope.sinceMs && receipt.enteredMs <= scope.nowMs) arrivals++;
    if (receipt.decidedMs < scope.sinceMs) continue;
    if (!workers.has(receipt.reviewer) || verificationConflict(receipt.parties, receipt.reviewer)) outcomesUnknown++;
    else if (receipt.status === 'approved') outcomes.approved++;
    else outcomes.revisionRequested++;
  }
  return { basis: 'dated-review-comments' as const, priorRounds, recordedRounds,
    unmeasuredRounds: priorRounds - recordedRounds, arrivals,
    outcomes: workers.size ? outcomes : null, outcomesUnknown, invalidReceipts };
}

/** A census of CURRENT review rounds. Overwritten earlier rounds are explicitly unmeasured.
 * A dispatch's status=ok is never an outcome: use the scheduler's recorded disposition,
 * including a late settlement, and the lifecycle decision corroborated by its grade ledger.
 */
export function computeAgentReviewService(
  scope: AgentReviewServiceScope,
  rows: readonly AgentReviewServiceRow[],
  pulls: readonly (PullLedgerRow & { workspaceId: string })[],
  historyPosts: readonly AgentReviewHistoryPost[] = [],
) {
  if (!Number.isFinite(scope.sinceMs) || !Number.isFinite(scope.nowMs) || scope.sinceMs > scope.nowMs) {
    throw new Error('Invalid review service window');
  }
  const inWindow = (ms: number) => Number.isFinite(ms) && ms >= scope.sinceMs && ms <= scope.nowMs;
  const workers = new Set(scope.verifierIds);
  const specs = new Set(scope.verificationSpecs.map(s => `${s.specId}@${s.revision}`));
  let currentRounds = 0, arrivals = 0, arrivalsUnknown = 0;
  let pending = 0, pendingTimingUnknown = 0, overdueKnown = 0, outcomesUnknown = 0;
  let oldestKnownPendingWaitMs: number | null = null;
  const outcomes = { approved: 0, revisionRequested: 0 };
  for (const row of rows) {
    if (row.workspaceId !== scope.workspaceId || row.harnessSlug !== scope.harnessSlug) continue;
    const review = readAgentReviewState(row.payload);
    if (!review) continue;
    currentRounds++;
    const timing = computeAgentReviewTiming({ ...row, nowMs: scope.nowMs });
    if (timing.enteredAt === null) arrivalsUnknown++;
    else if (inWindow(Date.parse(timing.enteredAt))) arrivals++;
    if (review.status === 'pending' && !ANY_FAMILY_TERMINAL_STATES.includes(row.state)) {
      pending++;
      if (timing.reviewWaitMs === null) pendingTimingUnknown++;
      else {
        oldestKnownPendingWaitMs = Math.max(oldestKnownPendingWaitMs ?? 0, timing.reviewWaitMs);
        if (timing.reviewWaitMs >= DAY_MS) overdueKnown++;
      }
    }
    if (review.status === 'pending') continue;
    if (timing.reviewWaitMs === null) { outcomesUnknown++; continue; }
    if (!inWindow(Date.parse(review.timing!.decidedAt!))) continue;
    const ledger = row.ledger;
    if (!ledger || ledger.ideaId !== review.ledgerIdeaId || ledger.routedRef !== `wi:${row.id}` ||
        ledger.grade === null || !Number.isInteger(ledger.grade) || ledger.grade < 1 || ledger.grade > 5 ||
        !ledger.gradedBy || !workers.has(ledger.gradedBy) ||
        verificationConflict(verificationParties(row), ledger.gradedBy) !== null ||
        (review.status === 'approved' ? ledger.grade < 4 : ledger.grade > 3)) {
      outcomesUnknown++;
      continue;
    }
    if (review.status === 'approved') outcomes.approved++;
    else outcomes.revisionRequested++;
  }
  let attempts = 0, claimed = 0, noClaim = 0, pickupUnknown = 0, unscopedPickupAttempts = 0;
  const noClaimReasons: Record<string, number> = {};
  for (const pull of pulls) {
    if (pull.workspaceId !== scope.workspaceId || pull.harness !== scope.harnessSlug ||
        !pull.bee || !workers.has(pull.bee) || !inWindow(Date.parse(pull.at))) continue;
    if (!pull.specId || pull.revision === null) { unscopedPickupAttempts++; continue; }
    if (!specs.has(`${pull.specId}@${pull.revision}`)) continue;
    attempts++;
    const late = pull.lateSettlement;
    if (late) {
      if (!inWindow(Date.parse(late.settledAt)) || late.kind === 'rejected-unknown') pickupUnknown++;
      else if (late.kind === 'claimed') claimed++;
      else { noClaim++; noClaimReasons['late-no-claim'] = (noClaimReasons['late-no-claim'] ?? 0) + 1; }
    } else if (pull.disposition === 'claimed' && pull.item) claimed++;
    else if (pull.disposition === 'no-claim') {
      noClaim++;
      const reason = pull.reason ?? 'reason-unrecorded';
      noClaimReasons[reason] = (noClaimReasons[reason] ?? 0) + 1;
    } else pickupUnknown++;
  }
  const history = computeAgentReviewHistory(scope, rows, historyPosts);
  return { scope, basis: 'current-review-rounds' as const, currentRounds, arrivals, arrivalsUnknown,
    priorRoundsUnmeasured: history.unmeasuredRounds, history, pending, pendingTimingUnknown, overdueKnown,
    oldestKnownPendingWaitMs,
    oldestPendingWaitMs: pendingTimingUnknown ? null : oldestKnownPendingWaitMs,
    outcomes: workers.size ? outcomes : null, outcomesUnknown,
    pickups: workers.size && specs.size ? { attempts, claimed, noClaim, unknown: pickupUnknown, noClaimReasons } : null,
    unscopedPickupAttempts };
}

/** Complete scoped census before serialization; no display LIMIT can change these totals. */
export async function readAgentReviewService(scope: AgentReviewServiceScope, options: { itemIds?: readonly string[] } = {}) {
  let stage = 'review-census';
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{
      id: string; state: string; payload: unknown; created_ts: number | null;
      created_by: string | null; terminal_owner: string | null;
      idea_id: string | null; routed_ref: string | null; routed_at: number | null;
      human_grade: number | null; graded_by: string | null;
    }[]>`
      SELECT wi.feature_id AS id, wi.status AS state, wi.payload, wi.created_ts,
             wi.payload #>> '{_ei,created_by}' AS created_by, wi.terminal_owner,
             l.idea_id, l.routed_ref, l.routed_at, l.human_grade, l.graded_by
        FROM harness_shared.work_items wi
        LEFT JOIN harness_shared.scout_routed_ideas l
          ON l.workspace_id = wi.workspace_id AND l.harness_slug = wi.harness_slug
         AND l.idea_id = wi.payload #>> '{agentReview,ledgerIdeaId}'
       WHERE wi.workspace_id = ${scope.workspaceId} AND wi.harness_slug = ${scope.harnessSlug}
         AND jsonb_typeof(wi.payload -> 'agentReview') = 'object'
         AND (${options.itemIds === undefined} OR wi.feature_id = ANY(${[...(options.itemIds ?? [])]}::text[]))`;
    stage = 'pickup-ledger';
    const pulls = await sql<{
      invoked_at: Date; coord_owner_id: string | null; harness_slug: string; status: string;
      duration_ms: number | null; disposition: unknown; late_settlement: unknown;
    }[]>`
      SELECT invoked_at, coord_owner_id, harness_slug, status, duration_ms,
             metadata_json -> 'schedulerDisposition' AS disposition,
             metadata_json -> 'schedulerLateSettlement' AS late_settlement
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
         AND tool_name = 'scheduler:get_next' AND coord_owner_id = ANY(${[...scope.verifierIds]}::text[])
         AND invoked_at >= ${new Date(scope.sinceMs)} AND invoked_at <= ${new Date(scope.nowMs)}`;
    stage = 'round-history';
    const history = await sql<{ id: string; author: string | null; body: string }[]>`
      SELECT wi.feature_id AS id, p.author_id AS author, p.body
        FROM harness_shared.work_items wi
        JOIN harness_shared.coord_threads t ON t.workspace_id = wi.workspace_id
         AND ((t.parent_kind = 'issue' AND t.parent_ref = wi.feature_id)
           OR (t.parent_kind = 'feature' AND t.parent_ref = wi.harness_slug || '#' || wi.feature_id))
        JOIN harness_shared.coord_thread_posts p ON p.workspace_id = t.workspace_id AND p.thread_id = t.thread_id
       WHERE wi.workspace_id = ${scope.workspaceId} AND wi.harness_slug = ${scope.harnessSlug}
         AND strpos(p.body, ${REVIEW_HISTORY_MARKER}) > 0
         AND (${options.itemIds === undefined} OR wi.feature_id = ANY(${[...(options.itemIds ?? [])]}::text[]))`;
    stage = 'service-computation';
    const { pullLedgerRowFromInvocation } = await import('../../agent-tools/scheduler/pull_ledger');
    return { status: 'known' as const, ...computeAgentReviewService(scope, rows.map(row => ({
      id: row.id, state: row.state, payload: row.payload, workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      createdBy: row.created_by, terminalOwner: row.terminal_owner,
      createdAt: row.created_ts === null ? null : new Date(Number(row.created_ts)).toISOString(),
      reviewRoutedAtMs: row.routed_at === null ? null : Number(row.routed_at),
      ledger: row.idea_id && row.routed_ref ? { ideaId: row.idea_id, routedRef: row.routed_ref,
        grade: row.human_grade === null ? null : Number(row.human_grade), gradedBy: row.graded_by } : null,
    })), pulls.map(pull => ({ workspaceId: scope.workspaceId,
      ...pullLedgerRowFromInvocation({ ...pull, invoked_at: new Date(pull.invoked_at).toISOString() }),
    })), history.map(post => ({ ...post, harnessSlug: scope.harnessSlug }))) };
  } catch (error) {
    return { status: 'unknown' as const, scope, reason: 'service-read-failed' as const,
      failure: { stage, message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : null } };
  }
}

/** P-030: reuse the fleet's authoritative spec/roster/window and uncapped internal census.
 * An implementation fleet, failed roster or absent spec cannot stand in for verifier service.
 */
export async function readFleetAgentReviewService(input: { workspaceId: string; harness: string; fleet: string },
  injected?: {
    resolveScope: typeof resolveFleetMetricScope;
    listItems: typeof listAllWorkItemsForFileExport;
    selectItems: typeof selectFleetMetricCurrentItems;
    readService: typeof readAgentReviewService;
  }) {
  try {
    let deps = injected;
    if (!deps) {
      const module = await import('../../agent-tools/fleet/fleet-metrics-scope');
      deps = { resolveScope: module.resolveFleetMetricScope, selectItems: module.selectFleetMetricCurrentItems,
        listItems: (await import('../../work-items')).listAllWorkItemsForFileExport,
        readService: readAgentReviewService };
    }
    const resolved = await deps.resolveScope({ ...input, flowMode: 'current-spec' });
    if (!resolved.ok) return { status: 'unknown' as const, population: input,
      reason: 'fleet-service-scope-unavailable', detail: resolved.reason, recoverVia: resolved.recoverVia };
    if (resolved.claimSpec.current.lane !== 'verification') return { status: 'not-applicable' as const,
      population: input, reason: 'fleet-spec-is-not-verification' };
    const items: WorkItem[] = await deps.listItems({ harness: input.harness, includeObservations: false });
    const selected = deps.selectItems(resolved, items);
    const service = await deps.readService({ workspaceId: input.workspaceId, harnessSlug: input.harness,
      sinceMs: Date.parse(resolved.scope.window.startAt), nowMs: Date.parse(resolved.scope.window.endAt),
      verifierIds: resolved.populationLifecycle.currentRunnableRoster.ownerIds,
      verificationSpecs: [{ specId: resolved.claimSpec.current.specId, revision: resolved.scope.stock.revision }] },
    { itemIds: selected.map(item => item.id) });
    return { ...service, population: { ...input, kind: 'fleet-current-spec' as const,
      specId: resolved.claimSpec.current.specId, revision: resolved.scope.stock.revision,
      matchedItems: selected.length, censusItems: items.length, limitApplied: false,
      selection: 'canonical-claim-spec-matcher' as const, roster: 'current-runnable-roster' as const,
      snapshot: 'selection-then-service-read' as const } };
  } catch (error) {
    return { status: 'unknown' as const, population: input, reason: 'fleet-service-read-failed',
      detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Minimal watchdog tick row the flow rollup needs (injected — see readWatchdogFlowTicks). */
export interface WatchdogFlowTick {
  /** tick_at, epoch ms. */
  tickAtMs: number;
  /** How many improvements that tick captured (length of the `captured` id array). */
  capturedCount: number;
}

export interface ImprovementFlow {
  /** Items created in the trailing 7 days. */
  captured7d: number;
  /** Items whose state is resolved/closed AND whose last update is in the trailing 7 days. */
  resolved7d: number;
  /** captured7d − resolved7d. Positive = the backlog grew this week. */
  net7d: number;
  /** Median age (days, 0.1 precision) of the OPEN items; null when nothing is open. */
  medianOpenAgeDays: number | null;
  /** Count of recurring friction signatures — from digest.recurringSignatures (reused, not re-derived). */
  recurringSignatureCount: number;
  watchdog: {
    /** ISO timestamp of the most recent tick, or null if the watchdog never ticked. */
    lastTickAt: string | null;
    /** Ticks in the trailing 24h. */
    ticks24h: number;
    /** Improvements captured by ticks in the trailing 24h. */
    captured24h: number;
  };
  /**
   * Auto-implement dispatch ledger rollup (consume-edges P-010 / B-04) — is the
   * BACK edge cycling (fired vs actually fixed, in-progress vs presumed-dead)?
   * Computed once in dispatch-ledger.ts and passed through (not re-derived
   * here, same rule as recurringSignatureCount); null when the ledger read
   * failed or wasn't attempted.
   */
  dispatch: DispatchStats | null;
}

function parseMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ComputeImprovementFlowOptions {
  /** Now, in ms — passed for deterministic tests; the resolver passes Date.now(). */
  nowMs?: number;
  /** digest.recurringSignatures.length — the digest already computed it; pass it through. */
  recurringSignatureCount?: number;
  /** computeDispatchStats(...) over the ledger read — passed through, not re-derived. */
  dispatchStats?: DispatchStats | null;
}

/**
 * Pure flow rollup over the candidate + watchdog-tick rows. Deterministic given
 * `nowMs`; no PG, no clock reads.
 */
export function computeImprovementFlow(
  candidates: ImprovementCandidate[],
  ticks: WatchdogFlowTick[],
  opts: ComputeImprovementFlowOptions = {},
): ImprovementFlow {
  const nowMs = opts.nowMs ?? Date.now();
  const weekStart = nowMs - 7 * DAY_MS;
  const dayStart = nowMs - DAY_MS;

  let captured7d = 0;
  let resolved7d = 0;
  const openAges: number[] = [];
  for (const c of candidates) {
    const createdMs = parseMs(c.createdAt);
    if (createdMs !== null && createdMs >= weekStart && createdMs <= nowMs) captured7d += 1;

    const state = c.state ?? 'open';
    if (state === 'open') {
      if (createdMs !== null) openAges.push(Math.max(0, (nowMs - createdMs) / DAY_MS));
      continue;
    }
    // resolved/closed — approximate the resolution time by the last lifecycle
    // update (updated_at), same clock the recurrence-decay matcher reads.
    const resolvedMs = parseMs(c.updatedAt) ?? createdMs;
    if (resolvedMs !== null && resolvedMs >= weekStart && resolvedMs <= nowMs) resolved7d += 1;
  }
  openAges.sort((a, b) => a - b);
  const med = median(openAges);

  let lastTickMs: number | null = null;
  let ticks24h = 0;
  let captured24h = 0;
  for (const t of ticks) {
    if (lastTickMs === null || t.tickAtMs > lastTickMs) lastTickMs = t.tickAtMs;
    if (t.tickAtMs >= dayStart && t.tickAtMs <= nowMs) {
      ticks24h += 1;
      captured24h += t.capturedCount;
    }
  }

  return {
    captured7d,
    resolved7d,
    net7d: captured7d - resolved7d,
    medianOpenAgeDays: med === null ? null : Math.round(med * 10) / 10,
    recurringSignatureCount: opts.recurringSignatureCount ?? 0,
    watchdog: {
      lastTickAt: lastTickMs === null ? null : new Date(lastTickMs).toISOString(),
      ticks24h,
      captured24h,
    },
    dispatch: opts.dispatchStats ?? null,
  };
}

/**
 * PG read for the watchdog half of the flow: the most recent tick rows
 * (tick_at + captured count), newest-first. Bounded — the watchdog ticks
 * ~96/day/host and rows are retention-pruned, so the cap comfortably covers
 * the 24h window while still carrying the true last tick even when it's old.
 */
export async function readWatchdogFlowTicks(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<WatchdogFlowTick[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(1, opts.limit ?? 1000), 2000);
  const rows = await sql<{ tick_at: Date | string; captured_count: number }[]>`
    SELECT tick_at, COALESCE(array_length(captured, 1), 0) AS captured_count
      FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
     ORDER BY tick_at DESC
     LIMIT ${limit}`;
  return rows
    .map((r) => ({
      tickAtMs: r.tick_at instanceof Date ? r.tick_at.getTime() : Date.parse(String(r.tick_at)),
      capturedCount: Number(r.captured_count) || 0,
    }))
    .filter((t) => !Number.isNaN(t.tickAtMs));
}
