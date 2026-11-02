/**
 * G2 admission predicate — the SINGLE source of truth for "is this feature-family
 * work-item auto-runnable without auditor screening?".
 *
 * Plan: shared-hive-trust-admission-2026-06-14 (P-001). Successor to the shipped
 * papercusp-user-protection-gate-2026-05-31, whose gate was enforced ONLY on the
 * feature-frontier read (`dbos/orchestrator-loop.ts` readFrontierFeatures +
 * `@papercusp/orchestrator` state-pg.ts readFeaturesPg). The Hive's fleet/blackboard
 * distribution layer — `claimNextWorkItem`, `claimWorkItem`, `claimReplicaSlotLocal`,
 * `fleet:place_batch` (gatherFrontier) — grew up around that one read and never
 * inherited the predicate, so un-screened REMOTE work was claimable + runnable. This
 * module is that one predicate, applied at EVERY claim/place chokepoint so a future
 * path can't silently re-open the hole.
 *
 * Rule (mirrors `@papercusp/orchestrator` isAutoPickable, D-006 of the predecessor):
 * an item is auto-pickable iff it was authored LOCALLY (origin 'local' or NULL, the
 * pre-G1 back-compat case) OR the auditor ADMITTED it (audit_verdict = 'admit').
 * Remote + un-admitted ⇒ quarantined — fail-safe: it holds even if the auditor lane
 * is unwired/errors/lags. The TRUST-LIST fast-path (a trusted author's
 * verified_author_github_user_id) joins this predicate in Phase 3; the column lands
 * in Phase 2. Until then this is the exact behaviour of the proven frontier gate,
 * brought to every other path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { ACTIONABLE_CONDITION_PREFIXES, FROZEN_REPAIR_LEG_CONDITION_PREFIX } from './coord/actionable-conditions';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';
import { readRoutinePause } from './harness/routines/release-pause-ttl';
import type { GreenMainSloBreachMetric } from './release/green-main-slo';
import type { DedupCandidateMethod } from './agent-tools/work_items/dedup-candidates-stamp';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * JS form — filter already-loaded rows (placement-gather, list surfacing). Keep this
 * byte-identical in meaning to {@link autoPickableWhereSql}; the drift-guard test
 * (P-006) asserts both agree with `@papercusp/orchestrator` isAutoPickable.
 */
export function isAutoPickable(
  origin: string | null | undefined,
  auditVerdict: string | null | undefined,
  verifiedAuthorGithubUserId?: number | null,
  trustedGithubUserIds?: ReadonlySet<number>,
  authorPubkey?: string | null,
  ownAuthorPubkeys?: ReadonlySet<string>,
): boolean {
  // Local features always bypass the auditor — origin NULL = local (pre-G1 back-compat).
  if (origin == null || origin === 'local') return true;
  // Remote features are pickable when the auditor has admitted them…
  if (auditVerdict === 'admit') return true;
  // …OR the OWN-NODE fast-path: the row was authored by a substrate-log key this
  // workspace already knows as its own (see ownAuthorWhereSql for why that is sound).
  // A blank/absent pubkey NEVER qualifies — see the guards there.
  if (authorPubkey != null && authorPubkey !== '' && ownAuthorPubkeys != null && ownAuthorPubkeys.has(authorPubkey)) {
    return true;
  }
  // …OR the TRUST fast-path (Phase 3 / P-010): a remote+un-admitted item whose
  // VERIFIED author (P-008, never a self-claimed id) is in the owner's LOCAL trust
  // list. The verified id must be present AND in the trusted set — a NULL verified
  // id (unverified / revoked binding / local row) never satisfies it. The caller
  // supplies the workspace's trusted set (it is owner/workspace-scoped — D-004).
  if (
    verifiedAuthorGithubUserId != null &&
    trustedGithubUserIds != null &&
    trustedGithubUserIds.has(verifiedAuthorGithubUserId)
  ) {
    return true;
  }
  return false;
}

/**
 * Issue-family (bug/change/task) LOCAL-claimability predicate — the issue-family
 * counterpart of {@link isAutoPickable}, but SIMPLER: a federated (origin='remote')
 * issue-family row is owned EXCLUSIVELY by its authoring peer's core (the
 * hyperbee->PG projector writes it under LWW — see EI-7833 / migration 521's
 * engineer_issues_view_dml remote-skip guard, and the hard invariant enforced at
 * work-items.ts's issue-family setWorkItemState: "its authoring peer must
 * claim/resolve it"). Unlike the feature family, there is NO audit-admit /
 * trust-list escape hatch here — a remote issue-family row is never locally
 * claimable, full stop. `origin` NULL (pre-federation back-compat) or 'local' is
 * locally claimable; anything else (today only 'remote') is not.
 *
 * WI-3649: `claimNextIssueWorkItem` (the claim_next/scheduler:get_next self-select),
 * `listWorkItems`'s issue branch (`admissibleOnly`), and `observeWorkItem` must all
 * apply this SAME predicate so "claimable"/"available" means what the actual claim
 * path (`claimIssue`'s view-trigger) will honor — mirroring EI-7841's fix, which
 * closed the identical read/write gap for the feature family only.
 */
export function isIssueLocallyClaimable(origin: string | null | undefined): boolean {
  return origin == null || origin === 'local';
}

/**
 * ADMISSION-GATE state — the second, orthogonal admission axis (plan
 * work-queue-admission-and-bulk-dedup-2026-08-24, owner-directed 2026-08-24).
 *
 * WHY IT LIVES HERE rather than in a new module: this file is already "the SINGLE
 * source of truth for is-this-claimable", and the predecessor's whole lesson (see
 * the header) is that an admission rule defined next to ONE consumer silently fails
 * to reach the others. A parallel gate would repeat that exact mistake.
 *
 * ORTHOGONAL, NOT a replacement: the G2 legs above answer "may we run work authored
 * ELSEWHERE?"; this answers "has this item cleared DUPLICATE screening?". A claim
 * chokepoint must satisfy both.
 *
 * The states, and why NULL means admitted:
 *   NULL         legacy / pre-gate row ⇒ ADMITTED (back-compat, exactly as origin
 *                NULL = local above). Every row predating migration 944 is NULL, and
 *                treating those as pending would quarantine the entire live backlog.
 *   'pending'    born-pending; invisible to claim/place until the promoter judges it.
 *   'admitted'   promoter judged it — duplicate screening only, NEVER merit
 *                (redundancy kappa 0.679 vs merit kappa 0.289; plan charter).
 *   'auto'       filing-time bypass: plan-promoted (already passed plan review) or
 *                critical/security severity (post-hoc review instead).
 *   'unreviewed' FAIL-OPEN auto-promotion — the promoter was dead or lagging past its
 *                deadline. Claimable BY DESIGN: the measured system bottleneck is
 *                distribution (greenlit plans sat six days unclaimed), so a dead
 *                promoter must never silently starve the queue. Tagged so the stats
 *                ledger can alarm on a non-zero steady-state count.
 *
 * FAIL-SAFE DIRECTION IS DELIBERATELY INVERTED relative to the G2 legs. There, an
 * unwired auditor must not admit foreign code, so unknown ⇒ refuse. Here, an unwired
 * promoter must not freeze the queue, so unknown ⇒ admit. Both choose the direction
 * whose failure mode is recoverable: a duplicate that slips through is merged later;
 * a starved queue stops all work and is invisible until someone notices.
 */
export type WorkItemAdmission = 'pending' | 'admitted' | 'auto' | 'unreviewed';

/**
 * The `admission` value a NEW item is born with, or `null` for "don't stamp it"
 * (legacy/pre-gate semantics — {@link isAdmitted} reads NULL as admitted).
 *
 * Deliberately NOT `WorkItemAdmission` at the create seam: a filing path may only
 * ever mint 'pending' (gated) or 'auto' (a filing-time bypass it can justify on the
 * spot). 'admitted' is the PROMOTER's verdict and 'unreviewed' is the fail-open
 * watchdog's — neither is something a writer may claim about itself, so the type
 * refuses it rather than relying on a convention nobody reads.
 */
export type BornAdmission = Extract<WorkItemAdmission, 'pending' | 'auto'>;

/**
 * A row is admitted when duplicate screening is not pending AND it carries no duplicate
 * verdict (migration 1534, bug-inflow-one-problem-one-row-2026-10-18#D-001: owner
 * directive #1990 — a duplicate is a FIELD the gate checks, not a comment). ANY non-null
 * `duplicate_of` means "this problem already has a row", whether or not the canonical is
 * still open, so the duplicate is never claimable. Pass `duplicateOf` whenever the row
 * was read with it; {@link admittedWhereSql} is the SQL twin and applies both halves.
 */
export function isAdmitted(
  admission: string | null | undefined,
  duplicateOf?: string | null,
): boolean {
  return admission !== 'pending' && duplicateOf == null;
}

/**
 * The model promoter's cadence, owned HERE rather than in work-items-admission-promoter.ts
 * (which re-exports it, so its existing consumers are unchanged).
 *
 * EI-21973318733042066: the claim path has to be able to STATE the bound a pending row
 * clears within, and it must not pull a batched-LLM runner's whole module graph into every
 * claim to read one number. Owning it beside {@link isAdmitted} keeps the predicate and its
 * cadence in one module.
 */
export const DEFAULT_PROMOTER_TICK_MINUTES = 30;

/**
 * How many promoter ticks a row may sit pending before the INDEPENDENT deterministic
 * fail-open runner admits it as 'unreviewed' — `runAdmissionFailOpen`'s
 * `startedAt - 2 * tickMinutes` cutoff. This is what makes admission-pending a WAIT rather
 * than a refusal: nobody has to act for it to clear, even if the promoter is dead.
 */
export const ADMISSION_FAIL_OPEN_TICKS = 2;

/** Seconds until the promoter's next tick would normally admit a pending row. */
export function admissionPromoterTickSec(tickMinutes = DEFAULT_PROMOTER_TICK_MINUTES): number {
  return tickMinutes * 60;
}

/** Seconds until the fail-open backstop admits a pending row regardless of the promoter. */
export function admissionFailOpenSec(tickMinutes = DEFAULT_PROMOTER_TICK_MINUTES): number {
  return ADMISSION_FAIL_OPEN_TICKS * tickMinutes * 60;
}

/**
 * EI-24023740620851074 — worst-case seconds from a row's creation until the fail-open
 * backstop admits it. {@link admissionFailOpenSec} is the runner's CUTOFF AGE, not its
 * bound: the runner admits only rows older than the cutoff AT THE MOMENT IT FIRES, and it
 * fires once per tick (the seeded cron `0 15,45 * * * *`, pinned one tick apart by the
 * bound test). A row one second short of the cutoff at one fire waits a whole extra tick,
 * so the honest guarantee is cutoff + one cadence. Publishing the bare cutoff as
 * `guaranteedWithinSec` told refused callers to retry at ~60m for rows that could not clear
 * before ~90m — reported independently five times.
 */
export function admissionFailOpenGuaranteedSec(tickMinutes = DEFAULT_PROMOTER_TICK_MINUTES): number {
  return admissionFailOpenSec(tickMinutes) + admissionPromoterTickSec(tickMinutes);
}

/**
 * A scheduled backstop's nominal cadence is not evidence that it is running. The
 * claim floor only quotes its deadline while the latest completed fail-open run
 * is within one full admission deadline; beyond that, the caller must see an
 * overdue or unknown backstop instead of a recycled static promise.
 */
export const ADMISSION_FAIL_OPEN_LIVENESS_STALE_SEC = admissionFailOpenGuaranteedSec();

export type AdmissionFailOpenLiveness =
  | {
      status: 'healthy';
      lastSuccessAtMs: number;
      lastAttemptAtMs: number | null;
      lastAttemptStatus: string | null;
      ageMs: number;
      thresholdMs: number;
    }
  | {
      status: 'overdue';
      reason: string;
      lastSuccessAtMs: number | null;
      lastAttemptAtMs: number | null;
      lastAttemptStatus: string | null;
      ageMs: number | null;
      overdueBySec: number;
      thresholdMs: number;
    }
  | {
      status: 'paused';
      reason: string | null;
      lastSuccessAtMs: number | null;
      lastAttemptAtMs: number | null;
      lastAttemptStatus: string | null;
      thresholdMs: number;
    }
  | {
      status: 'inactive';
      reason: string;
      lastSuccessAtMs: number | null;
      lastAttemptAtMs: number | null;
      lastAttemptStatus: string | null;
      thresholdMs: number;
    }
  | {
      status: 'unknown';
      reason: string;
      lastSuccessAtMs: number | null;
      lastAttemptAtMs: number | null;
      lastAttemptStatus: string | null;
      thresholdMs: number;
    };

/** Pure classifier shared by the claim-floor read and its unit tests. */
export function classifyAdmissionFailOpenLiveness(input: {
  routineExists: boolean;
  active: boolean | null;
  createdAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastAttemptAtMs?: number | null;
  lastAttemptStatus?: string | null;
  pause: unknown;
  nowMs: number;
  staleSec?: number;
}): AdmissionFailOpenLiveness {
  const thresholdMs = (input.staleSec ?? ADMISSION_FAIL_OPEN_LIVENESS_STALE_SEC) * 1000;
  const lastSuccessAtMs = Number.isFinite(input.lastSuccessAtMs) ? input.lastSuccessAtMs : null;
  const lastAttemptAtMs = Number.isFinite(input.lastAttemptAtMs) ? input.lastAttemptAtMs ?? null : null;
  const lastAttemptStatus = typeof input.lastAttemptStatus === 'string' ? input.lastAttemptStatus : null;
  if (!input.routineExists) {
    return {
      status: 'unknown', reason: 'the fail-open routine row is missing', lastSuccessAtMs,
      lastAttemptAtMs, lastAttemptStatus, thresholdMs,
    };
  }
  const pause = readRoutinePause(input.pause);
  if (pause.present) {
    return { status: 'paused', reason: pause.reason, lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, thresholdMs };
  }
  if (input.active !== true) {
    return {
      status: 'inactive', reason: 'the fail-open routine is inactive with no recorded pause',
      lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, thresholdMs,
    };
  }
  if (lastAttemptStatus !== null && lastAttemptStatus !== 'complete') {
    const attemptAgeMs = lastAttemptAtMs === null ? null : Math.max(0, input.nowMs - lastAttemptAtMs);
    if (attemptAgeMs !== null && attemptAgeMs > thresholdMs) {
      return {
        status: 'overdue',
        reason: `the most recent fail-open attempt is ${lastAttemptStatus} beyond the admission deadline`,
        lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, ageMs: attemptAgeMs,
        overdueBySec: Math.ceil((attemptAgeMs - thresholdMs) / 1000), thresholdMs,
      };
    }
    return {
      status: 'unknown',
      reason: `the most recent fail-open attempt is ${lastAttemptStatus}; no completed success proves a retry deadline`,
      lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, thresholdMs,
    };
  }

  const watermarkMs = lastSuccessAtMs ?? input.createdAtMs;
  if (watermarkMs == null || !Number.isFinite(watermarkMs)) {
    return {
      status: 'unknown', reason: 'no routine-creation or successful-run timestamp is available',
      lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, thresholdMs,
    };
  }
  const ageMs = Math.max(0, input.nowMs - watermarkMs);
  if (lastSuccessAtMs == null) {
    if (ageMs > thresholdMs) {
      return {
        status: 'overdue',
        reason: 'no successful fail-open run has completed since the routine was created',
        lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, ageMs,
        overdueBySec: Math.ceil((ageMs - thresholdMs) / 1000),
        thresholdMs,
      };
    }
    return {
      status: 'unknown', reason: 'no successful fail-open run has been recorded yet',
      lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, thresholdMs,
    };
  }
  if (ageMs > thresholdMs) {
    return {
      status: 'overdue',
      reason: 'the most recent successful fail-open run is older than the admission deadline',
      lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, ageMs,
      overdueBySec: Math.ceil((ageMs - thresholdMs) / 1000),
      thresholdMs,
    };
  }
  return { status: 'healthy', lastSuccessAtMs, lastAttemptAtMs, lastAttemptStatus, ageMs, thresholdMs };
}

/** Read the successful-run watermark written by `runWorkItemAdmissionFailOpen`. */
export async function readAdmissionFailOpenLiveness(
  workspaceId: string,
  sqlOverride?: OrgSql,
  nowMs = Date.now(),
): Promise<AdmissionFailOpenLiveness> {
  const thresholdMs = ADMISSION_FAIL_OPEN_LIVENESS_STALE_SEC * 1000;
  if (!workspaceId) {
    return {
      status: 'unknown', reason: 'workspace id is unavailable', lastSuccessAtMs: null,
      lastAttemptAtMs: null, lastAttemptStatus: null, thresholdMs,
    };
  }
  try {
    const sql = sqlOverride ?? getOrgPg().sql;
    const rows = await sql<Array<{
      active: boolean | null;
      created_at: Date | string | null;
      pause: unknown;
      last_success_at: Date | string | null;
      last_attempt_at: Date | string | null;
      last_attempt_status: string | null;
    }>>`
      SELECT r.active,
             r.created_at,
             r.metadata->'pause' AS pause,
             (
               SELECT max(ar.finished_at)
                 FROM harness_shared.admission_runs ar
                WHERE ar.workspace_id = ${workspaceId}
                  AND ar.harness_slug = ${operatorHomeHarnessSlug()}
                  AND ar.run_kind = 'promoter-tick'
                  AND ar.detail->>'mode' = 'fail-open'
                  AND ar.detail->>'status' = 'complete'
             ) AS last_success_at,
             latest.at AS last_attempt_at,
             latest.status AS last_attempt_status
        FROM harness_shared.routines r
        LEFT JOIN LATERAL (
          SELECT COALESCE(ar.finished_at, ar.started_at) AS at, ar.detail->>'status' AS status
            FROM harness_shared.admission_runs ar
           WHERE ar.workspace_id = ${workspaceId}
             AND ar.harness_slug = ${operatorHomeHarnessSlug()}
             AND ar.run_kind = 'promoter-tick'
             AND ar.detail->>'mode' = 'fail-open'
           ORDER BY ar.started_at DESC
           LIMIT 1
        ) latest ON TRUE
       WHERE r.workspace_id = ${workspaceId}
         AND r.install_slug = ${operatorHomeHarnessSlug()}
         AND r.name = 'work-item-admission-fail-open'
       LIMIT 1`;
    const row = rows[0];
    const toMs = (value: Date | string | null): number | null => {
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
      if (typeof value !== 'string') return null;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return classifyAdmissionFailOpenLiveness({
      routineExists: Boolean(row),
      active: row?.active ?? null,
      createdAtMs: toMs(row?.created_at ?? null),
      lastSuccessAtMs: toMs(row?.last_success_at ?? null),
      lastAttemptAtMs: toMs(row?.last_attempt_at ?? null),
      lastAttemptStatus: row?.last_attempt_status ?? null,
      pause: row?.pause,
      nowMs,
    });
  } catch {
    return {
      status: 'unknown', reason: 'the fail-open liveness read failed', lastSuccessAtMs: null,
      lastAttemptAtMs: null, lastAttemptStatus: null, thresholdMs,
    };
  }
}

export type AdmissionFailOpenRetryWindow =
  | {
      status: 'healthy';
      remainingSec: number;
      deadlineAtMs: number;
      lastSuccessAtMs: number;
      deadlineExpired: false;
      deadlineOverdueBySec: 0;
    }
  | {
      status: 'overdue';
      reason: string;
      overdueBySec: number;
      deadlineAtMs: number | null;
      deadlineExpired: boolean;
      deadlineOverdueBySec: number;
      lastSuccessAtMs: number | null;
    }
  | {
      status: 'paused' | 'inactive' | 'unknown';
      reason: string;
      deadlineAtMs: number | null;
      deadlineExpired: boolean;
      deadlineOverdueBySec: number;
      lastSuccessAtMs: number | null;
    };

/** Remaining per-item deadline, conditioned on a recent completed backstop run. */
export function admissionFailOpenRetryWindow(
  createdAtMs: number | null,
  nowMs: number,
  liveness: AdmissionFailOpenLiveness,
): AdmissionFailOpenRetryWindow {
  const validCreatedAt = createdAtMs != null && Number.isFinite(createdAtMs);
  const deadlineAtMs = validCreatedAt
    ? createdAtMs + admissionFailOpenGuaranteedSec() * 1000
    : null;
  const deadlineExpired = deadlineAtMs !== null && nowMs >= deadlineAtMs;
  const deadlineOverdueBySec = deadlineExpired && deadlineAtMs !== null
    ? Math.ceil(Math.max(0, nowMs - deadlineAtMs) / 1000)
    : 0;
  const lastSuccessAtMs = liveness.lastSuccessAtMs;
  if (deadlineAtMs === null) {
    return {
      status: 'unknown',
      reason: 'the work-item creation time is unavailable',
      deadlineAtMs,
      deadlineExpired: false,
      deadlineOverdueBySec: 0,
      lastSuccessAtMs,
    };
  }
  if (liveness.status === 'healthy') {
    if (deadlineExpired) {
      return {
        status: 'overdue',
        reason: 'the work-item admission deadline has passed',
        overdueBySec: deadlineOverdueBySec,
        deadlineAtMs,
        deadlineExpired,
        deadlineOverdueBySec,
        lastSuccessAtMs,
      };
    }
    return {
      status: 'healthy',
      remainingSec: Math.max(1, Math.ceil((deadlineAtMs - nowMs) / 1000)),
      deadlineAtMs,
      lastSuccessAtMs: liveness.lastSuccessAtMs,
      deadlineExpired: false,
      deadlineOverdueBySec: 0,
    };
  }
  if (liveness.status === 'overdue') {
    return {
      status: 'overdue',
      reason: liveness.reason,
      overdueBySec: Math.max(liveness.overdueBySec, deadlineOverdueBySec),
      deadlineAtMs,
      deadlineExpired,
      deadlineOverdueBySec,
      lastSuccessAtMs,
    };
  }
  return {
    status: liveness.status,
    reason: liveness.reason ?? 'the fail-open routine is paused',
    deadlineAtMs,
    deadlineExpired,
    deadlineOverdueBySec,
    lastSuccessAtMs,
  };
}

/** Accurate refusal text when no automatic retry deadline can be promised. */
export function admissionPendingBackstopExplanation(window: AdmissionFailOpenRetryWindow): string | null {
  if (window.status === 'healthy') return null;
  const lastRun = window.lastSuccessAtMs == null
    ? 'no successful fail-open run has been recorded'
    : `the last successful fail-open run completed at ${new Date(window.lastSuccessAtMs).toISOString()}`;
  const itemDeadline = window.deadlineExpired
    ? ` This row's ${Math.round(admissionFailOpenGuaranteedSec() / 60)}-minute deadline is overdue by about ${Math.ceil(window.deadlineOverdueBySec / 60)}m.`
    : '';
  if (window.status === 'overdue') {
    return `The independent fail-open admission backstop is OVERDUE: ${window.reason}; ${lastRun}. No automatic retry deadline remains.${itemDeadline}`;
  }
  if (window.status === 'paused') {
    return `The fail-open admission routine is paused${window.reason ? ` (${window.reason})` : ''}; ${lastRun}. No automatic retry deadline can be promised. Do not re-arm it to unblock this claim.${itemDeadline}`;
  }
  if (window.status === 'inactive') {
    return `The fail-open admission routine is inactive; ${lastRun}. No automatic retry deadline can be promised.${itemDeadline}`;
  }
  return `The fail-open admission backstop's last successful run could not be verified (${window.reason}); ${lastRun}. No automatic retry deadline can be promised.${itemDeadline}`;
}

/**
 * EI-22166155287498355: whether the work-item-admission-promoter's MOST RECENT
 * completed fire ended in an error (typically LLM account exhaustion) — the one
 * fact the admission-pending claim floor needs to publish an HONEST retry bound
 * instead of the promoter's healthy-cadence figure unconditionally.
 *
 * The refusal text used to say "typically within ~30m" whether or not the
 * promoter was actually doing that job — a routine that is `active:true` with a
 * recent `lastFiredAt` reads as healthy on every liveness surface even while its
 * WORK errors out every tick, so a caller had no way to tell "not yet" from "the
 * mechanism that would admit this is currently dead" (measured: fleet-wide
 * admission latency silently doubled to the fail-open bound for over an hour).
 *
 * `metadata.last_error` is CLEARED on every successful runner fire and SET on
 * every failed one (packages/operator-core/lib/dbos/routines-workflow.ts,
 * last_error_source:'runner'), so its mere presence already answers the question
 * — no extra staleness/consecutive-tick math needed.
 *
 * ⚠ EI-23383710942512978 — THAT LAST PARAGRAPH IS ONLY TRUE WHILE THE ROUTINE
 * STILL FIRES. "cleared on success, set on failure" is a statement about FIRES,
 * so the moment a routine stops firing, `last_error` FREEZES at whatever the
 * final fire left and nothing will ever clear it. A deliberate pause stops the
 * firing — so a promoter the OWNER paused reports its last pre-pause error
 * forever, and the floor rendered that as "the promoter's last fire errored, so
 * duplicate screening is currently NOT running".
 *
 * That misattribution is the actively dangerous direction: it reads as "a
 * background routine is broken", which invites the reader to re-arm it — and
 * here the routine was an LLM-SPENDING loop the owner paused with "re-arm only
 * on the owner's word". Measured 2026-09-16: `last_fired_at` 16:00:03Z preceded
 * `metadata.pause.pausedAtMs` 16:04:03Z by four minutes, and two separate agents
 * were sent to investigate a promoter fault that did not exist (one filed it as
 * a fleet-wide bug).
 *
 * So the cause is classified, not collapsed to a boolean. `routines:list` has
 * documented this exact distinction all along — "non-null `paused` means a
 * DELIBERATE hold ... a bare active:false with paused:null is the one worth
 * investigating" — and this floor simply did not honour it.
 *
 * Read-only, single indexed row lookup (routines_install_slug_name_key), and
 * fail-open on any query problem: an unreadable health signal must never make an
 * admission-pending refusal look WORSE than the caller already sees (same posture
 * as {@link loadOwnAuthorPubkeys} above).
 */
export type AdmissionPromoterStall =
  /** The promoter is armed and its last fire succeeded — the ordinary case. */
  | { stalled: false }
  /** Deliberately held by an operator/owner. NOT a fault; must not be re-armed to unblock a claim. */
  | { stalled: true; cause: 'paused'; pauseReason: string | null }
  /** Armed, but its last fire errored — the genuine fault this predicate was born for. */
  | { stalled: true; cause: 'errored' }
  /** Inactive with NO pause record: stopped, and nothing durable says why. Worth investigating. */
  | { stalled: true; cause: 'inactive' };

/** The row shape {@link classifyAdmissionPromoterStall} decides from. */
export interface AdmissionPromoterRow {
  active: boolean | null;
  lastFiredAtMs: number | null;
  /** Raw `metadata.pause` jsonb — parsed here via the shared {@link readRoutinePause}. */
  pause: unknown;
  lastError: string | null;
}

/**
 * The PURE decision behind {@link admissionPromoterStall}, split out so the
 * ordering rule above is unit-testable without a database — the DB half is a
 * single indexed SELECT with nothing to get wrong, and this half is where the
 * misattribution actually lived.
 */
export function classifyAdmissionPromoterStall(row: AdmissionPromoterRow): AdmissionPromoterStall {
  const pause = readRoutinePause(row.pause);
  const lastError = row.lastError && row.lastError.length > 0 ? row.lastError : null;

  if (pause.present) {
    // A deliberate hold OUTRANKS a stale error, but only when the error really is
    // an artifact of the last fire BEFORE the pause. If the routine somehow fired
    // and failed AFTER being paused, that error is live news and still wins —
    // "prefer paused" must not become "suppress every error on a paused routine".
    const errorPostDatesPause =
      lastError !== null &&
      pause.pausedAtMs !== null &&
      row.lastFiredAtMs !== null &&
      row.lastFiredAtMs > pause.pausedAtMs;
    if (!errorPostDatesPause) return { stalled: true, cause: 'paused', pauseReason: pause.reason };
    return { stalled: true, cause: 'errored' };
  }

  // No pause record. An inactive routine is stopped for an UNRECORDED reason, which
  // is a different (and more suspicious) thing than one that is armed and erroring.
  if (row.active === false) return { stalled: true, cause: 'inactive' };
  return lastError !== null ? { stalled: true, cause: 'errored' } : { stalled: false };
}

export async function admissionPromoterStall(
  workspaceId: string,
  sqlOverride?: OrgSql,
): Promise<AdmissionPromoterStall> {
  if (!workspaceId) return { stalled: false };
  try {
    const sql = sqlOverride ?? getOrgPg().sql;
    const rows = await sql<
      { active: boolean | null; last_fired_at: Date | null; pause: unknown; last_error: string | null }[]
    >`
      SELECT active,
             last_fired_at,
             metadata->'pause'      AS pause,
             metadata->>'last_error' AS last_error
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId}
         AND install_slug = ${operatorHomeHarnessSlug()}
         AND name = 'work-item-admission-promoter'
       LIMIT 1`;
    const row = rows[0];
    if (!row) return { stalled: false };
    const firedMs = row.last_fired_at ? new Date(row.last_fired_at).getTime() : Number.NaN;
    return classifyAdmissionPromoterStall({
      active: row.active,
      lastFiredAtMs: Number.isFinite(firedMs) ? firedMs : null,
      pause: row.pause,
      lastError: row.last_error,
    });
  } catch {
    return { stalled: false };
  }
}

/** Clip a pause reason into refusal text without letting an essay dominate the message. */
const clipReason = (reason: string): string =>
  reason.length <= 240 ? reason : `${reason.slice(0, 237).trimEnd()}...`;

/**
 * The refusal `basis` for each stall cause. Lives beside the predicate (like
 * {@link admissionPendingExplanation} and {@link admissionPendingCreateRemedy})
 * so the cause and the sentence describing it cannot drift apart.
 *
 * Every stalled cause shares the SAME bound — the fail-open runner is the only
 * thing admitting rows in all three — so what changes here is the ATTRIBUTION,
 * which is the whole defect: the bound was already honest, the blame was not.
 */
export function admissionStallBasis(stall: AdmissionPromoterStall): string {
  const failOpenTail =
    'the independent work-item-admission-fail-open runner is the only mechanism presently admitting rows';
  if (!stall.stalled) {
    return (
      'the work-item-admission-promoter cron tick, with the independent ' +
      'work-item-admission-fail-open runner as the backstop if that promoter is dead'
    );
  }
  if (stall.cause === 'paused') {
    return (
      'duplicate screening is PAUSED BY A DELIBERATE HOLD, not broken — ' +
      (stall.pauseReason ? `the recorded reason is: "${clipReason(stall.pauseReason)}"; ` : 'no reason was recorded; ') +
      'do NOT re-arm the promoter to unblock this claim (it is a background LLM-spending loop and the ' +
      `hold may be an owner directive); ${failOpenTail}`
    );
  }
  if (stall.cause === 'inactive') {
    return (
      'the work-item-admission-promoter is INACTIVE with no recorded pause reason, so duplicate ' +
      `screening is currently NOT running and nothing durable says why; ${failOpenTail}`
    );
  }
  return (
    "the work-item-admission-promoter's last fire errored, so duplicate screening is " +
    `currently NOT running; ${failOpenTail}`
  );
}

/**
 * The create-time admission bypasses: the durable `admitted_by` value each one writes,
 * paired with the caller-facing condition that earns it. ONE source — the create path
 * mints from these literals (typed as {@link AdmissionBypassReason}, so removing one is a
 * compile error there) and the claim path's admission-pending remedy is RENDERED from this
 * record, so a bypass added or removed cannot leave either surface behind.
 *
 * EI-21973318733042066 is why the remedy has to be rendered rather than written out: the
 * reporter proposed "let an item's creator name a specific intended owner, so it bypasses
 * screening" as a NEW mechanism. `bypass:explicit-assignment` already IS that mechanism —
 * 235 uses in the three days before the report — and nothing on the refusal path said so,
 * so a launched agent hit a 30-minute wall that its creator could have avoided for free.
 */
export const ADMISSION_CREATE_BYPASSES = [
  { reason: 'bypass:plan-item', condition: 'the item implements a plan item' },
  { reason: 'bypass:severity-critical', condition: "severity:'critical'" },
  { reason: 'bypass:topic-security', condition: "a 'security' topic" },
  { reason: 'bypass:explicit-assignment', condition: 'assign_to names the intended owner' },
] as const satisfies readonly { reason: string; condition: string }[];

export type AdmissionBypassReason = (typeof ADMISSION_CREATE_BYPASSES)[number]['reason'];

/**
 * The operator-facing explanation of the `admission-pending` claim floor, with its bound
 * DERIVED from the cadence above rather than restated. The old string said only "wait for
 * admitted/unreviewed", which is why the reporter could not tell "not yet" from "never".
 */
export function admissionPendingExplanation(
  tickMinutes = DEFAULT_PROMOTER_TICK_MINUTES,
  /**
   * WI-6554700010018098 / EI-25209690807142935: `failOpenExclusion` = the fail-open runner
   * never admits this row (see {@link ADMISSION_FAIL_OPEN_EXCLUSIONS}), so its wait has NO
   * fixed bound and the generic sentence's ceiling would be a false promise. `duplicateOf`
   * names the canonical row for a `duplicate-verdict`. Omitted = the row-agnostic sentence,
   * which names the exceptions.
   */
  opts: { failOpenExclusion?: AdmissionFailOpenExclusion | null; duplicateOf?: string | null } = {},
): string {
  const preamble =
    'duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or ' +
    'fleet process; launch and queue admission are separate capabilities. A launched agent still needs ' +
    'claimable or validly pre-assigned work. ';
  if (opts.failOpenExclusion === 'duplicate-verdict') {
    const twin = opts.duplicateOf ? ` (${opts.duplicateOf})` : '';
    return (
      preamble +
      `This row carries a typed DUPLICATE VERDICT: it was adjudicated the same problem as its canonical row${twin}. ` +
      'No admission path admits a row with a duplicate verdict, the independent fail-open runner included, ' +
      'so this does NOT clear on its own and there is no bound to wait out. Work the canonical row instead.'
    );
  }
  if (opts.failOpenExclusion === 'degraded-dedup-coverage') {
    return (
      preamble +
      "This row's file-time duplicate screen could NOT RUN (its dedup coverage is degraded), so the " +
      'independent fail-open runner will not admit it unscreened. That runner re-screens such rows ' +
      `(one attempt per row every ${ADMISSION_FAIL_OPEN_TICKS} ticks of the ${tickMinutes}-minute promoter) ` +
      'and admits the row when the re-screen comes back clean; a re-screen that finds twins hands it to the ' +
      "promoter's model review. After " + `${ADMISSION_DEGRADED_RESCREEN_ATTEMPTS} re-screens that still cannot run, ` +
      "the runner admits it as 'unreviewed' and the promoter reviews it afterwards. So this wait has NO fixed " +
      'bound, but it CLEARS ON ITS OWN. It is not a permanent refusal — but do not wait on it: check whether an existing row already ' +
      'covers the same problem, or use a create-time admission route for genuinely distinct work.'
    );
  }
  if (opts.failOpenExclusion === 'duplicate-candidates') {
    return (
      preamble +
      'This row carries DUPLICATE CANDIDATES found when it was filed, at least one stronger than a soft ' +
      'semantic match, so only the promoter\'s model ' +
      `review can admit it (as distinct) or merge it into its twin. The promoter runs on a ${tickMinutes}-minute ` +
      'tick but reviews only a few rows per tick, candidate rows first, so this wait has NO fixed bound; ' +
      'the independent fail-open runner deliberately never admits a row with unresolved strong candidates. ' +
      'It still CLEARS ON ITS OWN, and it is not a permanent refusal — but do not wait on it: check ' +
      'whether a named candidate is the same problem and work that row instead, or use a create-time ' +
      'admission route for genuinely distinct work.'
    );
  }
  return (
    preamble +
    'The durable promoter owns admission, and this floor CLEARS ON ITS ' +
    `OWN: the promoter runs on a ${tickMinutes}-minute tick, and an independent fail-open runner ` +
    `admits a row still pending after ${ADMISSION_FAIL_OPEN_TICKS} ticks ` +
    `(${ADMISSION_FAIL_OPEN_TICKS * tickMinutes} min) as 'unreviewed' once its duplicate screen is clean. ` +
    'Two exceptions: a row whose file-time screen could not run is re-screened by that runner (one attempt ' +
    `per row every ${ADMISSION_FAIL_OPEN_TICKS} ticks) and admitted when the re-screen comes back clean, or as ` +
    `'unreviewed' after ${ADMISSION_DEGRADED_RESCREEN_ATTEMPTS} re-screens that cannot run; a row with a duplicate ` +
    'candidate stronger than a soft semantic match waits for the promoter\'s model review, which has no fixed bound. ' +
    'It is a WAIT, not a permanent ' +
    'refusal — but a just-created item is typically unclaimable for most of a tick, which outlives ' +
    'many short-lived agents, so waiting is often the wrong move.'
  );
}

/**
 * What the caller can actually DO about an admission-pending refusal. Rendered from
 * {@link ADMISSION_CREATE_BYPASSES} so it cannot drift from the create path that honours it.
 */
export function admissionPendingCreateRemedy(): string {
  return (
    'Choose the work route before creating a replacement. Existing-plan fleet work should use ' +
    'plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc ' +
    'work should be created atomically with assign_to naming the intended owner, then launched with ' +
    'capability:launch-agent. Any one of these makes a NEW item born admitted: ' +
    ADMISSION_CREATE_BYPASSES.map((b) => b.condition).join('; ') +
    '. These are create-time admission bypasses, not blanket authority: assign_to is still checked ' +
    "against the target's live fleet scope, dependencies, locks, security, credentials and resource " +
    'admission; a scope mismatch files the item unassigned and explains why. Launching does not change ' +
    'an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; ' +
    'only the existing server-derived dispatch/force paths may grant their narrower exceptions.'
  );
}

/**
 * SQL form of {@link isAdmitted} — UNQUALIFIED columns, for single-table queries over
 * `harness_features_consolidated` / `work_items`, matching {@link autoPickableWhereSql}.
 *
 * `IS DISTINCT FROM` rather than `<> 'pending' OR IS NULL`: plain `<>` is NULL-false in
 * three-valued logic, which would silently exclude every legacy row — the exact
 * negated-predicate trap the own-author leg's comment warns about.
 */
export function admittedWhereSql(sql: OrgSql, qualifier?: 'wi' | 'ei') {
  // `qualifier` is a closed internal union, never caller input. Keeping all three
  // relation shapes behind this one builder prevents the feature view, the issue
  // base table, and the aliased engineer_issues listing from drifting into subtly
  // different NULL semantics.
  const prefix = qualifier ? `${qualifier}.` : '';
  const admission = sql.unsafe(`${prefix}admission`);
  // Migration 1534 (D-001): a duplicate verdict is a typed column every relation shape
  // carries (base table + both views), so the gate reads it here, once, for every
  // claim/place chokepoint.
  const duplicateOf = sql.unsafe(`${prefix}duplicate_of`);
  return sql`(${admission} IS DISTINCT FROM 'pending' AND ${duplicateOf} IS NULL)`;
}

/**
 * `wi.`-qualified form — compose ONLY into the issue claim/diagnose queries that alias
 * the base table as `wi` (same contract as {@link isIssueLocallyClaimableWhereSql}).
 */
export function admittedWhereSqlWi(sql: OrgSql) {
  return admittedWhereSql(sql, 'wi');
}

/**
 * EI-26988974367709614 — the ONE admission ACTIONABILITY contract, shared by ordinary
 * self-select ({@link admissionHoldExclusionSql}, a claim floor beside `ok_admission`) and
 * by the work-item resume packet (`agent-tools/work_items/resume.ts`). Before this the two
 * disagreed: {@link admittedWhereSql} served every non-pending row, including a fail-open
 * `unreviewed` row the promoter had since HELD, while resume told whoever claimed it not to
 * act. Measured on Luna Max 2026-10-26: 380 open held rows; members claimed them, were told
 * not to act, released, and the next member re-claimed them (WI-6554700010029608).
 *
 * The two payload facts, and what each means for an implementation worker:
 *
 * - `payload.admissionHold` (any value but null/false): the LIVE promoter judged the row and
 *   chose not to promote it — a protected twin it cannot judge yet (`deferred: twin …`), a
 *   claimed canonical (`claimed re-review`), a recurrence-identity guard, or an ambiguous
 *   duplicate. NOT actionable: working it risks duplicating the twin's work. The promoter
 *   lifts the hold when it promotes or merges the row, so the row returns to the queue on its
 *   own. The fail-open rationale above ("a dead promoter must never starve the queue") does
 *   not cover a hold: a hold is a verdict from a promoter that is alive.
 * - `payload.admissionReview.state = 'pending'` WITHOUT a hold: the plain fail-open case — a
 *   post-hoc duplicate review that runs alongside the work. Actionable by design (the
 *   `'unreviewed'` doc above); the caller is only cautioned that a later merge verdict ends it.
 *
 * Claim-by-id stays open, as for every self-select floor: the floor removes held rows from
 * opportunistic pulls, and the resume packet tells a named claimant why not to act.
 */
export function isAdmissionHoldActive(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const hold = (payload as Record<string, unknown>).admissionHold;
  return hold !== null && hold !== undefined && hold !== false;
}

export type AdmissionActionability =
  | { actionable: true; caution: string | null }
  | { actionable: false; reason: string };

/** JS form of the contract above, for an already-loaded row. */
export function admissionActionability(payload: unknown): AdmissionActionability {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  const review = record.admissionReview && typeof record.admissionReview === 'object'
    && !Array.isArray(record.admissionReview)
    ? record.admissionReview as Record<string, unknown> : {};
  const pendingReview = review.state === 'pending';
  if (isAdmissionHoldActive(record)) {
    return {
      actionable: false,
      reason: pendingReview
        ? 'A live admission review is pending and an admission hold remains; do not follow the stored checkpoint action.'
        : 'A live admission hold remains; do not follow the stored checkpoint action.',
    };
  }
  return pendingReview
    ? {
      actionable: true,
      caution: 'A post-hoc duplicate review is pending on this fail-open row; work may proceed, ' +
        'but stop if the promoter merges it into a canonical item.',
    }
    : { actionable: true, caution: null };
}

/**
 * SQL twin of {@link isAdmissionHoldActive}, as a self-select floor: TRUE iff the row carries
 * NO active admission hold. A NULL payload or a missing/JSON-null/false hold passes, matching
 * the JS twin value-for-value. `payloadCol` is a closed literal union, never caller input.
 */
export function admissionHoldExclusionSql(
  sql: OrgSql,
  payloadCol: 'wi.payload' | 'payload' | 'ei.payload' | 'target.payload' = 'wi.payload',
) {
  return sql`COALESCE(COALESCE(${sql.unsafe(payloadCol)}, '{}'::jsonb) -> 'admissionHold', 'null'::jsonb)
    IN ('null'::jsonb, 'false'::jsonb)`;
}

/**
 * EI-25209690807142935 / EI-26282407214531658 — the rows the INDEPENDENT fail-open runner
 * (`runAdmissionFailOpen`) never admits, however old they get, in the order a refusal names
 * them. Each is unresolved duplicate work that only adjudication clears:
 *
 * - `duplicate-verdict` — migration 1534's typed `duplicate_of`: the row already HAS its row.
 * - `duplicate-candidates` — file-time detection found twin(s) by a method stronger than
 *   {@link FAIL_OPEN_ADMISSIBLE_CANDIDATE_METHOD}; only the promoter's model review admits it
 *   as distinct (work-queue-exclusion-alarm-duplicates-2026-10-16 P-002). Soft-only rows are
 *   admitted `unreviewed` and reviewed afterwards (EI-26515695311006297).
 * - `degraded-dedup-coverage` — the file-time screen could not run, so admitting it would admit
 *   an unscreened row; the runner re-screens it and admits on a clean result — or, after
 *   {@link ADMISSION_DEGRADED_RESCREEN_ATTEMPTS} re-screens that still cannot run, admits it
 *   `unreviewed` so a leg outage cannot park it forever (EI-26515695311006297).
 *
 * ONE record drives BOTH the runner's eligibility ({@link failOpenDedupEligibleWhereSql}) and
 * the claim floor's attribution ({@link failOpenExclusionSql}). Before this, the claim floor
 * re-derived only the candidate leg (WI-6554700010018098) and kept publishing the fail-open
 * ceiling as `guaranteedWithinSec` to degraded-coverage and duplicate-verdict rows the runner
 * excludes — measured on EI-26277464744695494 (2026-10-18), a degraded row promised 90 min.
 */
export const ADMISSION_FAIL_OPEN_EXCLUSIONS = [
  'duplicate-verdict',
  'duplicate-candidates',
  'degraded-dedup-coverage',
] as const;

export type AdmissionFailOpenExclusion = (typeof ADMISSION_FAIL_OPEN_EXCLUSIONS)[number];

/**
 * EI-26515695311006297 — the weakest file-time duplicate signal. A row whose EVERY candidate
 * came from this method alone is NOT a `duplicate-candidates` exclusion: the fail-open runner
 * admits it as `unreviewed`, and the promoter (whose batch reads `admission IN ('pending',
 * 'unreviewed')` with `admissionReview.state = 'pending'`) still adjudicates the pair
 * afterwards. Measured 2026-10-28: ~234 candidate-bearing rows/day were filed while the model
 * promoter admitted ~10/day, so a candidate row in practice never reached a review window and
 * the "no fixed bound" wait was unbounded in fact. A candidate with any other method (hard
 * semantic, lexical, exact-key, containment, or a legacy entry with NO method) still excludes.
 */
export const FAIL_OPEN_ADMISSIBLE_CANDIDATE_METHOD = 'semantic-soft' satisfies DedupCandidateMethod;

/**
 * EI-26515695311006297 — a degraded-coverage row stops being an exclusion once the fail-open
 * runner's re-screen (work-items-admission-dedup-rescreen.ts) has recorded this many attempts
 * in `payload.dedupCoverage.rescreen.attempts` and the screen still could not run. Without a
 * terminal fallback a persistently unavailable leg (lexical, measured 2026-10-28) parked such
 * rows pending FOREVER — 137 of them. After the last attempt the row is admitted as
 * `unreviewed`, so the promoter's review still runs; only claimability stops waiting on a leg
 * that is down. The re-screen cooldown is two promoter ticks, so this is ≥ ~2 hours of retries.
 */
export const ADMISSION_DEGRADED_RESCREEN_ATTEMPTS = 3;

/** Per-exclusion "this row IS excluded" predicate. `qualifier` is a closed internal union. */
function failOpenExclusionPredicates(
  sql: OrgSql,
  qualifier?: 'wi',
): ReadonlyArray<readonly [AdmissionFailOpenExclusion, ReturnType<OrgSql>]> {
  const prefix = qualifier ? `${qualifier}.` : '';
  const duplicateOf = sql.unsafe(`${prefix}duplicate_of`);
  const payload = sql.unsafe(`${prefix}payload`);
  const candidates = sql`(${payload} -> 'dedupCandidates')`;
  // Every predicate below is NULL-free, so `NOT (excluded)` is the exact complement.
  // CASE (not OR) guards jsonb_array_elements: SQL does not promise OR short-circuits, and a
  // non-array value would raise. A non-array or non-object entry stays excluded (conservative).
  const strongCandidate = sql`CASE WHEN jsonb_typeof(${candidates}) = 'array'
      THEN EXISTS (SELECT 1 FROM jsonb_array_elements(${candidates}) AS fo_cand(c)
                    WHERE fo_cand.c ->> 'method' IS DISTINCT FROM ${FAIL_OPEN_ADMISSIBLE_CANDIDATE_METHOD}::text)
      ELSE TRUE END`;
  const rescreenAttempts = sql`(CASE WHEN ${payload} #>> '{dedupCoverage,rescreen,attempts}' ~ '^[0-9]+$'
      THEN (${payload} #>> '{dedupCoverage,rescreen,attempts}')::numeric ELSE 0 END)`;
  const byReason: Record<AdmissionFailOpenExclusion, ReturnType<OrgSql>> = {
    'duplicate-verdict': sql`${duplicateOf} IS NOT NULL`,
    'duplicate-candidates': sql`(${candidates} IS NOT NULL AND ${strongCandidate})`,
    // COALESCE first, so the complement below is exact: a NULL flag reads as not-degraded.
    'degraded-dedup-coverage': sql`(lower(COALESCE(${payload} #>> '{dedupCoverage,degraded}', 'false')) = 'true'
      AND ${rescreenAttempts} < ${ADMISSION_DEGRADED_RESCREEN_ATTEMPTS}::int)`,
  };
  return ADMISSION_FAIL_OPEN_EXCLUSIONS.map((reason) => [reason, byReason[reason]] as const);
}

/**
 * SQL: TRUE iff NO fail-open exclusion applies — the dedup half of the runner's eligibility
 * (age, `admission = 'pending'` and status are the runner's own). Written as `NOT (excluded)`
 * conjuncts, which Postgres normalises to the plain `IS NULL` / `<>` forms.
 */
export function failOpenDedupEligibleWhereSql(sql: OrgSql, qualifier?: 'wi') {
  return failOpenExclusionPredicates(sql, qualifier)
    .map(([, excluded]) => sql`NOT (${excluded})`)
    .reduce((acc, clause) => sql`${acc} AND ${clause}`);
}

/**
 * SQL: the FIRST {@link AdmissionFailOpenExclusion} that applies to the row, or NULL when the
 * fail-open runner would admit it once it is old enough. The claim floor reads this to decide
 * whether it may publish the fail-open bound at all.
 */
export function failOpenExclusionSql(sql: OrgSql, qualifier?: 'wi') {
  const whens = failOpenExclusionPredicates(sql, qualifier)
    .map(([reason, excluded]) => sql`WHEN ${excluded} THEN ${reason}::text`)
    .reduce((acc, clause) => sql`${acc} ${clause}`);
  return sql`CASE ${whens} ELSE NULL END`;
}

/** Narrow a DB text value to the closed exclusion union; anything else is "no exclusion". */
export function asAdmissionFailOpenExclusion(value: unknown): AdmissionFailOpenExclusion | null {
  return (ADMISSION_FAIL_OPEN_EXCLUSIONS as readonly unknown[]).includes(value)
    ? (value as AdmissionFailOpenExclusion)
    : null;
}

/**
 * SQL form — a composable WHERE fragment for the porsager `sql` instance the caller
 * already holds (so it composes into that query). Columns are UNQUALIFIED — use only
 * in single-table queries over `harness_features_consolidated` (every claim/place
 * chokepoint is one). Pass the caller's own `sql`.
 *
 *   ...WHERE ... AND ${autoPickableWhereSql(sql)}
 */
export function autoPickableWhereSql(sql: OrgSql, workspaceId?: string) {
  // TRUST fast-path (Phase 3 / P-010). The subquery MUST be explicitly scoped to
  // `workspaceId` — NOT left to user_trust_list's RLS — because the admin db
  // handle BYPASSES RLS at some claim chokepoints, so an unscoped subquery would
  // trust-admit a workspace-A feature whose verified author is trusted in
  // workspace B (a cross-workspace trust leak, D-004). `workspaceId` omitted ⇒ the
  // trust leg is dropped entirely (fail-safe: the gate only ever UNDER-admits when
  // the caller can't scope it — never over-admits). verified_author_github_user_id
  // (P-008) is NULL for local / unverified / revoked-binding rows, so only a
  // genuinely-verified trusted author satisfies it.
  const trustLeg = workspaceId
    ? sql` OR (verified_author_github_user_id IS NOT NULL AND verified_author_github_user_id IN (SELECT trusted_github_user_id FROM harness_shared.user_trust_list WHERE workspace_id = ${workspaceId}))`
    : sql``;
  const ownLeg = workspaceId ? sql` OR ${ownAuthorWhereSql(sql, workspaceId)}` : sql``;
  return sql`(origin = 'local' OR origin IS NULL OR audit_verdict = 'admit'${trustLeg}${ownLeg})`;
}

/**
 * OWN-NODE admission leg — the default that makes a single owner's own machines
 * trust each other with no configuration [owner 2026-07-13: "trust our own
 * nodes ... that should be the default. all new papercusp installs should have
 * that behavior without needing to do anything"].
 *
 * WHY THIS EXISTS. `origin` records HOW A ROW ARRIVED, not who wrote it: an item
 * this workspace authored itself, once it round-trips through the 2-machine
 * federation path, comes back projected as origin='remote'. With the auditor lane
 * unbuilt (nothing in production has ever written audit_verdict) and the trust list
 * empty, such a row satisfied NO leg of the gate — so a pot whose whole frontier had
 * federated was quarantined against ITSELF: the Queen surveyed a frontier of zero,
 * correctly placed nothing, and reported success. Silent placement deadlock.
 *
 * WHAT MAKES A KEY "OURS" — and why this is sound rather than a loophole. A row is
 * stamped origin='local' only when OUR OWN core writes it; a peer's row is projected
 * as 'remote'. So "has authored a local-origin row in THIS workspace" is a property a
 * foreign key cannot manufacture from the outside — it is evidence our own substrate
 * log produced that key's writes. It also needs no registry and no setup: a fresh
 * install's first local write enrolls its own key, and a stranger's key never appears.
 *
 * NOT the device-attestation key space. `pot_members.device_attestations[].device_pubkey`
 * is a DIFFERENT key (and base64, where author_pubkey is hex) — it does not identify the
 * substrate log author, so it cannot answer this question.
 *
 * LOAD-BEARING GUARDS:
 *   - workspace-scoped (D-004), for the same admin-handle/RLS-bypass reason as the
 *     trust leg above; `workspaceId` omitted ⇒ the leg is dropped (fail-safe).
 *   - author_pubkey <> '' on BOTH sides. Blank-authored local rows exist (a pre-
 *     federation back-compat case); without this guard '' would enter the own-key set
 *     and admit EVERY remote row that also carries a blank author — turning a scoped
 *     trust decision into an open door.
 * The leg is POSITIVE (an OR arm), so a NULL author_pubkey is falsy in WHERE and simply
 * fails to admit — the three-valued-logic trap only bites a NEGATED predicate.
 */
export function ownAuthorWhereSql(sql: OrgSql, workspaceId: string) {
  return sql`(author_pubkey IS NOT NULL AND author_pubkey <> '' AND author_pubkey IN (
    SELECT DISTINCT author_pubkey
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId}
       AND (origin = 'local' OR origin IS NULL)
       AND author_pubkey IS NOT NULL
       AND author_pubkey <> ''
  ))`;
}

/**
 * ISSUE-FAMILY own-node leg (work-item-status-full-unify / owner 2026-07-20 "these can't be
 * truly remote"). The FEATURE family already trusts its own nodes via {@link ownAuthorWhereSql}
 * (owner 2026-07-13 "trust our own nodes = the default"); the issue family (isIssueLocallyClaimable)
 * historically hard-refused any origin!='local', with NO escape hatch. But `origin` records HOW a
 * row ARRIVED, not WHO wrote it: a bug THIS box authored, once it round-trips the hyperbee
 * federation, comes back projected origin='remote' — and when the box's substrate node identity
 * drifts (re-provision / device re-key / hive re-join), work authored under the OLD identity is
 * orphaned as un-claimable. This leg admits a remote issue whose author_pubkey is one this
 * workspace has ALSO written locally (evidence OUR substrate log produced it — a foreign key can't
 * manufacture that). Own-keys come from the work_items BASE (ALL families), because a substrate key
 * authors both features and issues; {@link ownAuthorWhereSql}'s harness_features_consolidated
 * source would miss an identity that authored only issues. Columns are `wi.`-qualified — compose
 * ONLY into the issue claim/diagnose queries that alias the base table as `wi`. Same LOAD-BEARING
 * guards as ownAuthorWhereSql: workspace-scoped (D-004), author_pubkey<>'' on BOTH sides.
 */
export function issueOwnAuthorWhereSql(sql: OrgSql, workspaceId: string) {
  return sql`(wi.author_pubkey IS NOT NULL AND wi.author_pubkey <> '' AND wi.author_pubkey IN (
    SELECT own.author_pubkey
      FROM harness_shared.work_items own
     WHERE own.workspace_id = ${workspaceId}
       AND (own.origin = 'local' OR own.origin IS NULL)
       AND own.author_pubkey IS NOT NULL
       AND own.author_pubkey <> ''
  ))`;
}

/**
 * WI-10003565 — is `id` an origin='remote' row authored by one of THIS workspace's own keys?
 * Read-only twin of {@link selfHealOwnNodeOriginIfStranded}, for a guard that must decide
 * BEFORE the write path runs (work_items:complete's early remote-authored refusal).
 * Workspace-scoped; any read failure answers false (fail-closed: the refusal stands).
 */
export async function isOwnNodeAuthoredRemoteRow(workspaceId: string, id: string): Promise<boolean> {
  if (!workspaceId || !id) return false;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${workspaceId} AND wi.feature_id = ${id}
         AND wi.origin = 'remote' AND ${issueOwnAuthorWhereSql(sql, workspaceId)}
       LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * WI-10006515 — batch twin of {@link isOwnNodeAuthoredRemoteRow} for a READ that classifies many
 * rows at once (a report must not write, so it cannot heal). Returns the subset of `ids` that are
 * origin='remote' rows authored by one of this workspace's own keys. Empty on any read failure
 * (fail-closed: every row keeps its remote classification). `harnessSlug` pins the physical row
 * when the caller's rows are harness-scoped, so a same-id twin elsewhere cannot mark them. Reads on
 * the shared pool, never a caller's transaction: a failed read here must not poison that tx.
 */
export async function ownNodeAuthoredRemoteIds(
  workspaceId: string,
  ids: readonly string[],
  opts: { harnessSlug?: string | null } = {},
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!workspaceId || ids.length === 0) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ feature_id: string }[]>`
      SELECT DISTINCT wi.feature_id FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${workspaceId} AND wi.feature_id = ANY(${[...ids]}::text[])
         ${opts.harnessSlug ? sql`AND wi.harness_slug = ${opts.harnessSlug}` : sql``}
         AND wi.origin = 'remote' AND ${issueOwnAuthorWhereSql(sql, workspaceId)}`;
    for (const r of rows) out.add(r.feature_id);
  } catch {
    out.clear();
  }
  return out;
}

/**
 * WI-10003565 — heal an own-node row's mislabelled `origin` so the remote-authored guard stops
 * stranding it. The claim gate already treats such a row as ours ({@link issueOwnAuthorWhereSql}:
 * `origin` records how a row ARRIVED, not who wrote it), but every write path refused it as
 * "remote-authored ... its authoring peer must claim/resolve it" — and the authoring peer IS this
 * node, so the row could be claimed and never closed. Measured: system-filed rows
 * (createdBy="system:*") match none of the caller-identity hatches, so they were undrainable.
 *
 * Same shape as selfHealAuthorOriginIfStranded: resets `origin` on the BASE table (the
 * `engineer_issues` view trigger no-ops any write while origin='remote'), and the WHERE clause IS
 * the identity check — a row whose author key this workspace never wrote locally is untouched.
 * Returns true iff a row was healed.
 */
export async function selfHealOwnNodeOriginIfStranded(
  workspaceId: string,
  id: string,
  /** WI-10006010: the pinned physical row; omitted, every same-id twin is eligible. */
  harnessSlug?: string | null,
): Promise<boolean> {
  if (!workspaceId || !id) return false;
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items wi
       SET origin = 'local'
     WHERE wi.workspace_id = ${workspaceId} AND wi.feature_id = ${id}
       ${harnessSlug ? sql`AND wi.harness_slug = ${harnessSlug}` : sql``}
       AND wi.origin = 'remote' AND ${issueOwnAuthorWhereSql(sql, workspaceId)}
    RETURNING wi.feature_id`;
  return rows.length > 0;
}

/**
 * The issue-family locally-claimable SQL floor, own-node aware — the composable counterpart of
 * {@link isIssueLocallyClaimable}. `(origin local/null OR own-node)`; `workspaceId` omitted ⇒ the
 * own-node leg is dropped (fail-safe: only ever UNDER-admits when unscoped). `wi.`-qualified.
 */
export function isIssueLocallyClaimableWhereSql(sql: OrgSql, workspaceId?: string) {
  const ownLeg = workspaceId ? sql` OR ${issueOwnAuthorWhereSql(sql, workspaceId)}` : sql``;
  return sql`(wi.origin IS NULL OR wi.origin = 'local'${ownLeg})`;
}

/**
 * JS counterpart of {@link isIssueLocallyClaimableWhereSql} for a fetched row: local (origin
 * null/'local') OR its author is one of OUR own-node keys (load via {@link loadOwnAuthorPubkeys}).
 * `ownKeys` empty ⇒ degrades to the origin-only check (fail-safe).
 */
export function isIssueLocallyClaimableWithOwn(
  origin: string | null | undefined,
  authorPubkey: string | null | undefined,
  ownKeys: ReadonlySet<string>,
): boolean {
  if (isIssueLocallyClaimable(origin)) return true;
  return !!authorPubkey && authorPubkey !== '' && ownKeys.has(authorPubkey);
}

/**
 * Load this workspace's OWN substrate-log author keys — the JS-gate counterpart of
 * {@link ownAuthorWhereSql}. Workspace-scoped (D-004). Empty set on any read failure
 * (fail-safe: no own-node fast-path rather than over-broad admission).
 *
 * work-item-status-full-unify: derives from the work_items BASE (all families) so it also
 * feeds the issue-family own-node leg ({@link isIssueLocallyClaimableWithOwn}).
 */
export async function loadOwnAuthorPubkeys(workspaceId: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!workspaceId) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ author_pubkey: string }[]>`
      SELECT DISTINCT author_pubkey
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND (origin = 'local' OR origin IS NULL)
         AND author_pubkey IS NOT NULL
         AND author_pubkey <> ''`;
    for (const r of rows) if (r.author_pubkey) out.add(r.author_pubkey);
  } catch {
    /* fail-safe — empty set ⇒ own-node fast-path simply doesn't fire */
  }
  return out;
}

/**
 * P-008 (Phase 2) — the PRODUCER side of the trust gate: resolve a federated
 * feature's `author_pubkey` to a github_user_id ONLY via a VERIFIED, non-revoked
 * device attestation in `hive_members` — never a self-claimed id. Returns NULL
 * when the pubkey has no such attestation (the caller stores NULL → the gate
 * conservatively refuses the trust fast-path). The trust DECISION stays at the
 * consumer (isAutoPickable / autoPickableWhereSql, ws-scoped per D-004); this
 * only establishes "who, provably, authored it".
 *
 * Security invariants (contributor-row-types.ts DeviceAttestationEntry +
 * revoked_pubkeys "a verifier MUST refuse any attestation whose pubkey is here"):
 *   - binding_status = 'verified'  (BINDING_STATUSES: verified|pending|unverified)
 *   - author_pubkey ∈ device_attestations (an attested binding exists)
 *   - author_pubkey ∉ revoked_pubkeys (the device wasn't revoked)
 *   - workspace-scoped (hive_members is owner/workspace-keyed); pot_home_slug
 *     narrows further when known. The COALESCE guards keep a member with a NULL
 *     revoked_pubkeys / device_attestations from being wrongly excluded/erroring.
 */
export async function resolveVerifiedAuthorGithubId(
  sql: OrgSql,
  opts: { workspaceId: string; authorPubkey: string | null | undefined; potHomeSlug?: string },
): Promise<number | null> {
  try {
    return await readVerifiedAuthorGithubId(sql, opts);
  } catch {
    // Best-effort + FAIL-SAFE: an unreadable/absent hive_members (e.g. a transient
    // error, or a projection running against a partial schema) yields NULL → the
    // trust fast-path simply doesn't fire (the gate conservatively refuses), and
    // the federated-ingest projection loop is never crashed by the optional stamp.
    return null;
  }
}

/**
 * {@link resolveVerifiedAuthorGithubId} without the fail-safe: a read error throws.
 * P-537: a batchable projection needs the error, because inside the merge's batch it
 * aborted the transaction and must be followed by `projectionStatementFailed()`.
 */
export async function readVerifiedAuthorGithubId(
  sql: OrgSql,
  opts: { workspaceId: string; authorPubkey: string | null | undefined; potHomeSlug?: string },
): Promise<number | null> {
  const pubkey = (opts.authorPubkey ?? '').trim();
  if (!pubkey || !opts.workspaceId) return null;
  const hiveFilter = opts.potHomeSlug ? sql`AND pot_home_slug = ${opts.potHomeSlug}` : sql``;
  const rows = await sql<{ github_user_id: string | number }[]>`
    SELECT github_user_id
      FROM harness_shared.pot_members
     WHERE workspace_id = ${opts.workspaceId}
       ${hiveFilter}
       AND binding_status = 'verified'
       AND NOT (${pubkey} = ANY(COALESCE(revoked_pubkeys, ARRAY[]::text[])))
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(device_attestations, '[]'::jsonb)) a
          WHERE a->>'device_pubkey' = ${pubkey}
       )
     LIMIT 1`;
  if (!rows[0]) return null;
  const raw = rows[0].github_user_id;
  const id = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(id) ? id : null;
}

/**
 * Load the owner's LOCAL trust list for a workspace as a Set<github_user_id> —
 * the JS-gate (isAutoPickable) counterpart of the SQL trust subquery. WORKSPACE-
 * SCOPED (D-004: the list is owner/workspace-keyed; a remote item must only be
 * trust-admitted against its OWN workspace's list, never cross-workspace). Empty
 * set on any read failure (fail-safe: no trust fast-path rather than over-broad).
 */
export async function loadTrustedGithubUserIds(workspaceId: string): Promise<Set<number>> {
  const out = new Set<number>();
  if (!workspaceId) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ trusted_github_user_id: string | number }[]>`
      SELECT trusted_github_user_id FROM harness_shared.user_trust_list
       WHERE workspace_id = ${workspaceId}`;
    for (const r of rows) {
      const raw = r.trusted_github_user_id;
      const id = typeof raw === 'string' ? Number(raw) : raw;
      if (Number.isFinite(id)) out.add(id);
    }
  } catch {
    /* fail-safe — empty set ⇒ trust fast-path simply doesn't fire */
  }
  return out;
}

/**
 * Per-id admission read for paths that don't already SELECT the item's provenance —
 * the replica lane reads `work_item_replicas`, not the consolidated feature row. Reads
 * origin + audit_verdict and applies {@link isAutoPickable}. A missing row returns
 * `false` (fail-safe: a vanished/foreign item never slips through here; the caller's
 * own not-found handling runs first for the legitimate-missing case).
 */
export async function isWorkItemAutoPickable(
  workItemId: string,
  opts: { harness: string; workspaceId?: string },
): Promise<boolean> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<
    {
      origin: string | null;
      audit_verdict: string | null;
      admission: string | null;
      duplicate_of: string | null;
      verified_author_github_user_id: number | string | null;
      author_pubkey: string | null;
    }[]
  >`
    SELECT origin, audit_verdict, admission, duplicate_of, verified_author_github_user_id, author_pubkey
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${opts.harness}
       AND workspace_id = ${ws}
       AND feature_id = ${workItemId}
     LIMIT 1`;
  if (!rows[0]) return false;
  if (!isAdmitted(rows[0].admission, rows[0].duplicate_of)) return false;
  // Local / auditor-admitted fast path (no trust-list read needed).
  if (isAutoPickable(rows[0].origin, rows[0].audit_verdict)) return true;
  // OWN-NODE fast-path: authored by a key this workspace knows as its own. Checked
  // in SQL against the SAME definition ownAuthorWhereSql uses, so this per-id path
  // can't drift from the claim/place chokepoints.
  const pubkey = rows[0].author_pubkey;
  if (pubkey) {
    const own = await sql`
      SELECT 1
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${ws}
         AND (origin = 'local' OR origin IS NULL)
         AND author_pubkey = ${pubkey}
       LIMIT 1`;
    if (own.length > 0) return true;
  }
  // TRUST fast-path: a remote+un-admitted item whose VERIFIED author is in this
  // workspace's local trust list (explicitly ws-scoped — D-004). NULL verified id
  // (unverified / revoked / local) never qualifies.
  const raw = rows[0].verified_author_github_user_id;
  const verifiedId = raw == null ? null : typeof raw === 'string' ? Number(raw) : raw;
  if (verifiedId == null || !Number.isFinite(verifiedId)) return false;
  const trusted = await sql`
    SELECT 1 FROM harness_shared.user_trust_list
     WHERE workspace_id = ${ws} AND trusted_github_user_id = ${verifiedId} LIMIT 1`;
  return trusted.length > 0;
}

/**
 * Per-id duplicate-screening read for consumers that hydrate the legacy WorkItem
 * projection (which intentionally does not grow a new selected column for every
 * lifecycle axis). IDs are workspace-unique across both physical families, so the
 * shared base table is the one exact read. Missing rows fail safe.
 */
export async function isWorkItemDuplicateAdmitted(
  workItemId: string,
  opts: { workspaceId?: string } = {},
): Promise<boolean> {
  if (!workItemId) return false;
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ admission: string | null; duplicate_of: string | null }[]>`
    SELECT admission, duplicate_of
      FROM harness_shared.work_items
     WHERE workspace_id = ${ws} AND feature_id = ${workItemId}
     LIMIT 1`;
  return rows[0] ? isAdmitted(rows[0].admission, rows[0].duplicate_of) : false;
}

/**
 * STOP-THE-LINE — the third, orthogonal admission axis (P-013 / D-012 of
 * gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * WHY IT LIVES HERE: same reason as the duplicate-screening axis above — this file is
 * "the SINGLE source of truth for is-this-claimable", and an admission rule defined next
 * to one consumer silently fails to reach the others (this module's header). A parallel
 * gate module would repeat that mistake.
 *
 * WHAT IT SAYS: while the release gate on a harness has been RED-STREAKING for longer
 * than {@link STOP_THE_LINE_RED_HOURS}, non-repair work must not be SELF-SELECTED on
 * that harness — the fleet converges on repair instead of piling new commits onto a
 * broken tree. "A days-red gate being everyone's problem becomes mechanical, not
 * aspirational" (the plan item's own words).
 *
 * THE SIGNAL is the OPEN `gate-red-streak:<harness>` condition item's AGE — P-014's
 * audited condition-singleton substrate (D-010): opened by `trackGateStall`
 * (harness/routines/release-actions.ts) at the same edge as the red-streak alarm,
 * settled by the condition bridge when the gate greens. So the throttle arms and lifts
 * with zero state of its own, and the condition item doubles as the KILL-SWITCH: a
 * stale-open item (bridge missed the green) is lifted by ANY agent settling it — no
 * flag flip, no deploy (D-012 records why there is deliberately no feature flag).
 * NOT gate_health: that lives in per-install routine metadata JSON, and its greenness
 * semantics already burned once (EI-20706962612084953).
 *
 * EXEMPT (the plan item: "repair lanes, infra fixes, and owner-directed work"):
 *   - `item_kind = 'bug'` — fixes ARE the line; never throttled (issue family only).
 *   - alarm-condition items — `condition_key` under an actionable/alarm prefix
 *     ({@link STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES}). Deliberately NOT every
 *     condition item: `plan-promotion:` / `spec-triad:` conditions are ordinary work
 *     inflow, which is exactly what stops (measured 2026-09-01: the live condition-key
 *     population is dominated by plan-promotion rows).
 *   - owner-directed work — a named BY-ID claim bypasses self-select floors by existing
 *     architecture (agent-tools/work_items/claim.ts: "floors gate self-select only; a
 *     named by-id claim is the deliberate operator override"). No code here; recorded
 *     so the mapping is explicit.
 *   NOT exempt: plan-promoted inflow (`bypass:plan-item` admission) — stopping routine
 *   plan work is the point.
 *
 * FAIL-SAFE DIRECTION: like the G2 legs, unknown ⇒ the floor PASSES (no open condition
 * row ⇒ no throttle). The trigger row is minted by exactly one writer under migration
 * 741's partial unique index, so "open and old" is a deliberate, serialized state —
 * never an inference from a metric.
 *
 * Row-EXTRINSIC, like `depsBlockedExclusionSql` — so it belongs to the CLAIM floors
 * (candidate subquery + feature claimFloorsWhereSql), NOT to issueAdmissibleWhereSql's
 * row-intrinsic advertise mirror (issues-engineer.ts documents that boundary:
 * "work_items:claimable remains the only full oracle").
 */
export const STOP_THE_LINE_RED_HOURS = 24;

/** The red-streak condition prefix — must match the trackGateStall producer's key. */
export const GATE_RED_STREAK_CONDITION_PREFIX = 'gate-red-streak:';

/**
 * Condition singletons that OWN live release-gate operations. They are ordinary
 * issue-family bugs so the stop-the-line repair exemption correctly keeps the
 * repair LANE flowing, but the singleton itself must never circulate through
 * opportunistic self-select: exactly one registered gate fixer claims it by id.
 *
 * Keep this list intentionally narrower than ACTIONABLE_CONDITION_PREFIXES.
 * Most actionable alarms are normal repair work; only these two prefixes (plus the
 * live-gate green-main-slo metrics below) carry the live gate-control-plane
 * exclusivity contract (release/gate-red-ownership).
 */
export const LIVE_GATE_OPS_CONDITION_PREFIXES = [GATE_RED_STREAK_CONDITION_PREFIX, 'green-stall:'] as const;

/**
 * Key prefix of the green-main-slo watchdog's alarm items. The full key is
 * `alarm:green-main-slo:` + encodeURIComponent(JSON.stringify([workspace, install,
 * metric, episode, subject])) — built by greenMainSloConditionKey in
 * release/green-main-slo-watchdog.ts, whose real output the tests pin against.
 */
export const GREEN_MAIN_SLO_CONDITION_PREFIX = 'alarm:green-main-slo:';

/**
 * Which green-main-slo breach metrics are LIVE_GATE_OPS. EI-27062367026577459: these
 * alarm rows were bridge-minted as ordinary bugs, so self-select handed them to generic
 * fleet members who each claimed, found the gate held by its live fixer, and released.
 * One row took 18 claims from 7 holders in 6h. An exhaustive Record so a new metric is
 * a compile-time decision, never a silent default.
 *  - time-since-green / time-since-verdict: the gate has no green or no verdict; greening
 *    and re-running it is the live fixer's job.
 *  - red-adding-admission / round-cycle-time / queue-idle: the subject is the frozen
 *    repair-queue candidate, so the remedy is repair-queue mutation.
 *  - per-sync-red-rate: the subject is a sync fleet whose commits add reds; that is
 *    ordinary repair work for the fleet, not the gate's control plane.
 *  - non-verdict-reason: the watchdog files these as reason items ASSIGNED to the live
 *    gate owner; the alarm row records why runs fail to conclude (GATE_SYSTEM_DEV).
 * The watchdog resolves each alarm itself on measured recovery, so a reserved row
 * never needs a self-selecting claimant to close.
 */
const GREEN_MAIN_SLO_METRIC_IS_LIVE_GATE_OPS: Readonly<Record<GreenMainSloBreachMetric, boolean>> = {
  'time-since-green': true,
  'time-since-verdict': true,
  'red-adding-admission': true,
  'round-cycle-time': true,
  'queue-idle': true,
  'per-sync-red-rate': false,
  'non-verdict-reason': false,
};

export const LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS: readonly GreenMainSloBreachMetric[] = (
  Object.keys(GREEN_MAIN_SLO_METRIC_IS_LIVE_GATE_OPS) as GreenMainSloBreachMetric[]
).filter((metric) => GREEN_MAIN_SLO_METRIC_IS_LIVE_GATE_OPS[metric]);

/** The metric's encoded slot inside a green-main-slo key: `,"<metric>",` (third array element). */
const greenMainSloMetricNeedle = (metric: string): string => encodeURIComponent(`,"${metric}",`);

/** Escape LIKE metacharacters for Postgres' default backslash escape. */
const likeLiteral = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The LIKE patterns the reservation floor excludes from self-select: every
 * LIVE_GATE_OPS singleton prefix, plus one pattern per live-gate green-main-slo metric.
 * The encoded key itself contains `%`, so each literal segment is escaped.
 */
export function liveGateOpsReservedPatterns(): string[] {
  return [
    ...LIVE_GATE_OPS_CONDITION_PREFIXES.map((prefix) => `${likeLiteral(prefix)}%`),
    ...LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS.map(
      (metric) => `${likeLiteral(GREEN_MAIN_SLO_CONDITION_PREFIX)}%${likeLiteral(greenMainSloMetricNeedle(metric))}%`,
    ),
  ];
}

/** JS form of {@link liveGateOpsSelfSelectExclusionSql}'s reservation (TRUE = reserved). */
export function isLiveGateOpsConditionKey(conditionKey: string | null | undefined): boolean {
  if (!conditionKey) return false;
  if (LIVE_GATE_OPS_CONDITION_PREFIXES.some((prefix) => conditionKey.startsWith(prefix))) return true;
  return conditionKey.startsWith(GREEN_MAIN_SLO_CONDITION_PREFIX) &&
    LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS.some((metric) => conditionKey.includes(greenMainSloMetricNeedle(metric)));
}

/**
 * TRUE means an issue row may survive the LIVE_GATE_OPS reservation floor.
 * This fragment is composed only into issue-family SELF-SELECT reads/writes;
 * the named claim-by-id path deliberately bypasses it, which is how the
 * registered live gate fixer acquires the singleton.
 */
export function liveGateOpsSelfSelectExclusionSql(sql: OrgSql) {
  return sql`(
    wi.condition_key IS NULL
    OR NOT (wi.condition_key LIKE ANY(${liveGateOpsReservedPatterns()}::text[]))
  )`;
}

/** Static per-id refusal text; unlike stop-the-line, no harness-specific value is needed. */
export function liveGateOpsSelfSelectExplanation(): string {
  return (
    'LIVE_GATE_OPS condition (gate-red-streak: or green-stall: singleton, or an ' +
    `alarm:green-main-slo: ${LIVE_GATE_OPS_GREEN_MAIN_SLO_METRICS.join('/')} alarm) — reserved to the ` +
    'one registered live gate fixer and excluded from opportunistic self-select. A leader/owner ' +
    'may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership.'
  );
}

/**
 * Condition-key prefixes whose items stay claimable while the line is stopped: the
 * alarm/repair catalog ({@link ACTIONABLE_CONDITION_PREFIXES}, the condition-bridge
 * opt-in set) plus `deploy-parity:`, which P-015 files DIRECTLY via
 * `work_items:create { conditionKey }` rather than through the bridge catalog
 * (apps/operator/lib/release/deploy-parity.ts) and is repair work by construction.
 */
export const STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES: readonly string[] = [
  ...ACTIONABLE_CONDITION_PREFIXES,
  'deploy-parity:',
];

/**
 * Which relation shape the floor is being composed into. A closed internal union —
 * never caller input — same safety argument as {@link admittedWhereSql}'s qualifier.
 *   'issue-wi'             — the issue claim/diagnose queries aliasing work_items as `wi`.
 *   'feature-consolidated' — claimFloorsWhereSql's unaliased harness_features_consolidated
 *                            context (correlated refs need the full relation name there,
 *                            matching that builder's own cooldown EXISTS).
 */
export type StopTheLineRowContext = 'issue-wi' | 'feature-consolidated';

/**
 * SQL floor: TRUE ⇒ the candidate row survives stop-the-line (claimable as far as this
 * axis is concerned). Compose like the sibling floors:
 *
 *   ...AND ${stopTheLineExclusionSql(sql, 'issue-wi')}
 *
 * The inner EXISTS probes the open red-streak condition row for the CANDIDATE ROW'S OWN
 * workspace+harness, so only the affected harness throttles; migration 741's partial
 * unique index on non-null condition keys makes the probe an index hit.
 *
 * The feature-consolidated form has no `condition_key` column on the view (verified
 * 2026-09-01 against information_schema) and its kinds are placement kinds, so it gets
 * no per-row exemption legs — while the line is stopped, feature placement self-select
 * on the harness pauses entirely.
 */
export function stopTheLineExclusionSql(sql: OrgSql, rowContext: StopTheLineRowContext) {
  const activeRedStreak = gateRedStreakOpenForSql(sql, rowContext, STOP_THE_LINE_RED_HOURS);
  if (rowContext === 'feature-consolidated') {
    return sql`(NOT ${activeRedStreak})`;
  }
  const exemptPrefixPatterns = STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES.map((p) => `${p}%`);
  return sql`(
    wi.item_kind = 'bug'
    OR (wi.condition_key IS NOT NULL AND wi.condition_key LIKE ANY(${exemptPrefixPatterns as string[]}::text[]))
    OR NOT ${activeRedStreak}
  )`;
}

/**
 * The stop-the-line refusal/diagnosis explanation — rendered wherever the `stopTheLine`
 * exclusion bucket surfaces, so a throttled queue reads as a VERDICT with a remedy,
 * never as a drained lane (the context-pressure-claim-gate lesson: a refusal must be a
 * verdict, not silence).
 */
export function stopTheLineExplanation(harness: string): string {
  return (
    `stop-the-line: the ${harness} release gate has been red for over ${STOP_THE_LINE_RED_HOURS}h ` +
    `(an open gate-red-streak:${harness} condition item older than the threshold), so non-repair ` +
    'work is not served for self-select on this harness. Repair work still flows: bugs and ' +
    'alarm-condition items are exempt, and a leader/owner can still dispatch any item BY ID. ' +
    'The throttle lifts on its own when the gate greens (the condition bridge settles the item). ' +
    'If the gate is ACTUALLY green and this persists, the condition item is stale — settling it ' +
    'lifts the throttle immediately.'
  );
}

/**
 * THE one "is this harness's gate red, and for how long" predicate, shared by every
 * rung that reacts to a long red (green-main-cycle-time-2026-10-08 D-032 ruling 1).
 * TRUE ⇒ the CANDIDATE ROW'S OWN workspace+harness has an OPEN `gate-red-streak:<harness>`
 * condition item created at least `minAgeHours` ago. Stop-the-line passes
 * {@link STOP_THE_LINE_RED_HOURS}; red-inflow control passes
 * {@link RED_INFLOW_REPAIR_FIRST_HOURS}. A second "is main red" reader would let the two
 * rungs disagree on the population, which is the drift this helper exists to prevent.
 */
export function gateRedStreakOpenForSql(sql: OrgSql, rowContext: StopTheLineRowContext, minAgeHours: number) {
  const q = rowContext === 'issue-wi' ? 'wi.' : 'harness_shared.harness_features_consolidated.';
  return sql`EXISTS (
    SELECT 1
      FROM harness_shared.work_items stl
     WHERE stl.workspace_id = ${sql.unsafe(`${q}workspace_id`)}
       AND stl.harness_slug = ${sql.unsafe(`${q}harness_slug`)}
       -- Use the candidate harness already equated above: the equivalent inner-row
       -- expression prevents a parameterized condition_key lookup and scans every
       -- condition in the harness once per candidate (EI-23204229251577253).
       AND stl.condition_key = ${GATE_RED_STREAK_CONDITION_PREFIX} || ${sql.unsafe(`${q}harness_slug`)}
       AND NOT (stl.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
       AND stl.created_ts <= (EXTRACT(EPOCH FROM now()) * 1000)::bigint - ${Math.round(minAgeHours * 3600 * 1000)}
  )`;
}

/**
 * The SAME population as {@link gateRedStreakOpenForSql}, read as a value for ONE named
 * harness: the creation time (epoch ms) of its open red-streak condition item, or null
 * when the gate is not red-streaking. Used where a caller must decide BEFORE composing a
 * query (red-inflow control skips its preclaim entirely on a green harness) and to tell
 * the agent how long main has been red.
 */
export async function readGateRedStreakSinceMs(
  sql: OrgSql,
  workspaceId: string,
  harness: string,
): Promise<number | null> {
  const rows = await sql<{ created_ts: string | number | null }[]>`
    SELECT min(stl.created_ts) AS created_ts
      FROM harness_shared.work_items stl
     WHERE stl.workspace_id = ${workspaceId}
       AND stl.harness_slug = ${harness}
       AND stl.condition_key = ${GATE_RED_STREAK_CONDITION_PREFIX + harness}
       AND NOT (stl.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))`;
  const raw = rows?.[0]?.created_ts;
  const ms = raw == null ? NaN : Number(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * RED-GATE INFLOW CONTROL — green-main-cycle-time-2026-10-08 P-017, design D-032.
 *
 * The rung BELOW stop-the-line. Past {@link RED_INFLOW_REPAIR_FIRST_HOURS} of red, a
 * stable share ({@link RED_INFLOW_REPAIR_SHARE_PCT}%) of drain-fleet members get REPAIR
 * items served before new backlog. It is a PREFERENCE, not a floor (D-032 ruling 2): a
 * selected member with no claimable repair item takes ordinary backlog, so nobody idles.
 * Stop-the-line's 24h floor stays the hard rung.
 *
 * Who: a caller of scheduler:get_next WITH a fleet slug (get_next is the self-select
 * drain path). Selection is a stable hash of the caller's ownerId, so the same member
 * stays selected tick after tick and roughly half of any fleet moves, without reading a
 * roster ({@link redInflowMemberSelected}).
 *
 * Kill-switch: FLAGS.RED_INFLOW_REPAIR_FIRST (default ON, reversible ordering).
 */
export const RED_INFLOW_REPAIR_FIRST_HOURS = 8;

/** Share of fleet members (by stable ownerId hash) that take repair items first. */
export const RED_INFLOW_REPAIR_SHARE_PCT = 50;

/**
 * The sync-batch delta check's attributed per-sync red items
 * (release/sync-batch-delta-check.ts `conditionKeyForRed`). Pinned against that producer by
 * red-inflow-repair-first.test.ts, so a renamed key fails a test instead of silently
 * dropping these items out of the repair set.
 */
export const SYNC_DELTA_RED_CONDITION_PREFIX = 'sync-delta-red:';

/**
 * Condition-key prefixes that count as REPAIR items for red-inflow control (D-032 ruling 3):
 * P-013's per-failing-leg items and the sync-batch delta check's per-sync reds. The
 * queue-level `frozen-repair-convergence:` item and the `gate-red-streak:` singleton are
 * deliberately absent: D-028 reserves those to long-lived owners.
 */
export const RED_INFLOW_REPAIR_CONDITION_PREFIXES: readonly string[] = [
  FROZEN_REPAIR_LEG_CONDITION_PREFIX,
  SYNC_DELTA_RED_CONDITION_PREFIX,
];

/**
 * Stable 0..99 bucket for an ownerId (32-bit FNV-1a, mod 100). Pure and dependency-free so
 * the same member lands in the same bucket on every host and every tick.
 */
export function redInflowShareBucket(ownerId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < ownerId.length; i += 1) {
    hash ^= ownerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/** TRUE ⇒ this member is in the repair-first share. */
export function redInflowMemberSelected(ownerId: string, sharePct: number = RED_INFLOW_REPAIR_SHARE_PCT): boolean {
  if (!ownerId) return false;
  return redInflowShareBucket(ownerId) < sharePct;
}

/**
 * ISSUE-FAMILY ONLY narrowing for the red-inflow repair preclaim: TRUE ⇒ the `wi` row is a
 * repair item AND its own harness has been red for at least
 * {@link RED_INFLOW_REPAIR_FIRST_HOURS}. It references `wi.condition_key`, a column the
 * feature relation (harness_features_consolidated) does not have (D-032 ruling 5,
 * measured against information_schema), so it must never be composed into a feature-tier
 * query; the function takes no row context for exactly that reason.
 */
export function redInflowRepairItemSql(sql: OrgSql) {
  const patterns = RED_INFLOW_REPAIR_CONDITION_PREFIXES.map((p) => `${p}%`);
  return sql`(
    wi.condition_key IS NOT NULL
    AND wi.condition_key LIKE ANY(${patterns as string[]}::text[])
    AND ${gateRedStreakOpenForSql(sql, 'issue-wi', RED_INFLOW_REPAIR_FIRST_HOURS)}
  )`;
}

/** What scheduler:get_next reports when the red-inflow preference shaped a claim. */
export interface RedInflowStamp {
  /** TRUE ⇒ a repair item was served ahead of backlog; FALSE ⇒ none was claimable, so backlog was served. */
  applied: boolean;
  /** How long the harness's gate has been red, in hours (one decimal). */
  redSinceHours: number;
  thresholdHours: number;
  sharePct: number;
  reason: string;
}

export function redInflowStamp(applied: boolean, redSinceMs: number, nowMs: number = Date.now()): RedInflowStamp {
  const redSinceHours = Math.round(((nowMs - redSinceMs) / 3_600_000) * 10) / 10;
  return {
    applied,
    redSinceHours,
    thresholdHours: RED_INFLOW_REPAIR_FIRST_HOURS,
    sharePct: RED_INFLOW_REPAIR_SHARE_PCT,
    reason: applied
      ? `Main has been red ${redSinceHours}h (over ${RED_INFLOW_REPAIR_FIRST_HOURS}h) and you are in the ` +
        `${RED_INFLOW_REPAIR_SHARE_PCT}% repair-first share of fleet members, so a repair item ` +
        '(a failing frozen-queue leg or a per-sync red) was served before new backlog.'
      : `Main has been red ${redSinceHours}h and you are in the repair-first share, but no repair item ` +
        'was claimable, so ordinary backlog was served.',
  };
}
