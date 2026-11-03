/**
 * source-dispatchability.ts — drop routed candidates the dispatch walk can
 * never open, BEFORE a menu is selected from them (WI-6554700010009982).
 *
 * D-002 removed the liveness gate from consult and acceptance-grader selection:
 * delivery forks or converts the expert's TRANSCRIPT, so a dead session is still
 * a usable expert. That premise holds only while the transcript exists. An
 * ended session can lose both its native file and its archive while its turns
 * stay in `session_turns`, so the relevance router keeps ranking it — and every
 * dispatch walk then refuses pre-launch with `source transcript unavailable
 * (not_archived)`.
 *
 * Measured 2026-10-13 (plan consult-backed-parking-2026-10-12): an acceptance
 * grading cascade seated three such sources (su-0b88f408, su-74f97ac7,
 * su-2d3f55a2; adv archived_at NULL, no session_archives row, no session home),
 * every walk refused, and the plan's ship waited on the 4h cascade expiry. The
 * same class hit a rubric-vetting consult (WI-10005360) and a bar critique
 * (EI-25701238994250080).
 *
 * The filter is the selection-time half of the walk's own preflight: it uses
 * the same source resolution (`resolveDispatchSource`) and the same per-backend
 * transcript location (`locateConsultTranscript`, via the read-only probe), so
 * it removes only candidates the walk would refuse for this reason anyway.
 *
 * Failure direction is FAIL-OPEN, deliberately the opposite of the walk: a
 * probe fault, an unresolvable source or an exhausted budget KEEPS the
 * candidate. The walk remains the authority at launch time; this filter only
 * stops a measured absence from occupying a menu seat.
 */
import type { RouteResult, RoutingCandidate } from './relevance-router';
import type { ResumeTarget } from '../agent-launch-core';
import type { ConsultTranscriptProbe } from './resume-transcript-preflight';

export interface SourceDispatchabilityObservation {
  ownerId: string;
  /** `false` = measured absence; `null` = unknown (kept); `true` = openable. */
  dispatchable: boolean | null;
  detail: string;
  /** Keep the exact resolved incarnation after its candidate leaves the pool.
   * The owner's latest session may be unrelated to the missing transcript. */
  source?: Pick<ResumeTarget, 'agent' | 'sessionId' | 'advSessionId' | 'ownerId'>;
}

export type SourceDispatchabilityProbe = (
  candidate: RoutingCandidate,
  workspaceId?: string,
) => Promise<SourceDispatchabilityObservation>;

export interface FilterDispatchableOptions {
  /** Parallel probes. Each is a PG resolve + a filesystem lookup + a stamp read. */
  concurrency?: number;
  /** Total wall-clock budget; candidates not probed in time are KEPT. */
  budgetMs?: number;
  /** Workspace used to apply the dispatch walk's persisted per-source launch cooldown. */
  workspaceId?: string;
}

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_BUDGET_MS = 8_000;

/**
 * Remove measured-undispatchable candidates from both pools without changing
 * scores, order or floors. Returns `route` unchanged when nothing is removed.
 */
export async function filterDispatchableRoute(
  route: RouteResult,
  probe: SourceDispatchabilityProbe,
  options: FilterDispatchableOptions = {},
): Promise<RouteResult> {
  // A degraded or test route can arrive without a snapshot; nothing to probe.
  const candidates = route.snapshot?.candidates ?? [];
  if (candidates.length === 0) return route;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const budgetMs = Math.max(0, options.budgetMs ?? DEFAULT_BUDGET_MS);

  const observed = new Map<string, SourceDispatchabilityObservation>();
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const candidate = candidates[next++]!;
      if (observed.has(candidate.ownerId)) continue;
      try {
        observed.set(candidate.ownerId, await probe(candidate, options.workspaceId));
      } catch (e) {
        observed.set(candidate.ownerId, {
          ownerId: candidate.ownerId,
          dispatchable: null,
          detail: `dispatchability probe failed: ${(e as Error)?.message ?? String(e)}`,
        });
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker)),
      budget,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Stop handing out new candidates once the budget is spent; in-flight
    // probes finish in the background and are ignored.
    next = candidates.length;
  }

  const removed = [...observed.values()].filter((row) => row.dispatchable === false);
  if (removed.length === 0) return route;
  const dead = new Set(removed.map((row) => row.ownerId));
  const keep = (candidate: RoutingCandidate) => !dead.has(candidate.ownerId);
  const qualified = route.qualified.filter(keep);
  return {
    ...route,
    qualified,
    verdict: route.verdict === 'routed' && qualified.length === 0 ? 'no_qualified_responder' : route.verdict,
    snapshot: {
      ...route.snapshot,
      candidates: candidates.filter(keep),
      undispatchableSources: removed,
    },
  };
}

/**
 * Production probe: resolve the source exactly as the dispatch walk does, then
 * ask the read-only transcript probe whether that source can be opened.
 */
export async function probeConsultSourceDispatchable(
  candidate: RoutingCandidate,
  workspaceId?: string,
  probes: SourceDispatchabilityProbes = {},
): Promise<SourceDispatchabilityObservation> {
  if (workspaceId) {
    try {
      const nowMs = Date.now();
      const cooldown = await (probes.readCooldown ?? readSourceCooldown)(workspaceId, candidate.ownerId, nowMs);
      if (cooldown) {
        return {
          ownerId: candidate.ownerId,
          dispatchable: false,
          detail: `source launch cooldown until ${cooldown.until}: ${cooldown.lastFailure}`,
        };
      }
    } catch {
      // Cooldown is a selection hint, not a new outage mode. On a read fault,
      // keep the existing transcript probe as the authoritative fail-open path.
    }
  }
  const [{ resolveDispatchSource }, { resolveResumeTarget }, { probeConsultResumeTranscript }] = await Promise.all([
    import('./consult-dispatch'),
    import('../agent-launch-core'),
    import('./resume-transcript-preflight'),
  ]);
  const source = await resolveDispatchSource(
    { sourceOwnerId: candidate.ownerId, evidence: candidate.evidence },
    { resolveResumeTarget },
  );
  // An unresolvable source is refused by the walk too, but that refusal has
  // causes this change did not measure (ownership drift, a transient PG
  // fault). Keep it; only the measured transcript absence is removed here.
  if ('refusal' in source) {
    return { ownerId: candidate.ownerId, dispatchable: null, detail: source.refusal };
  }
  const probe = await (probes.probeTranscript ?? probeConsultResumeTranscript)(source.target);
  return {
    ownerId: candidate.ownerId,
    dispatchable: probe.dispatchable,
    detail: probe.detail,
    source: {
      agent: source.target.agent,
      sessionId: source.target.sessionId,
      advSessionId: source.target.advSessionId,
      ownerId: source.target.ownerId,
    },
  };
}

export interface SourceCooldownEvidence {
  failures: number;
  until: string;
  lastFailure: string;
}

export interface SourceDispatchabilityProbes {
  probeTranscript?: (target: ResumeTarget) => Promise<ConsultTranscriptProbe>;
  readCooldown?: (
    workspaceId: string,
    sourceOwnerId: string,
    nowMs: number,
  ) => Promise<SourceCooldownEvidence | null>;
}

async function readSourceCooldown(
  workspaceId: string,
  sourceOwnerId: string,
  nowMs: number,
): Promise<SourceCooldownEvidence | null> {
  const [{ getOrgPg }, { SOURCE_FAILURE_LOOKBACK_MS, readSourceDispatchRecords, sourceCooldownFrom }] =
    await Promise.all([import('@papercusp/db-org'), import('./consult-dispatch')]);
  const records = await readSourceDispatchRecords(
    getOrgPg().sql,
    workspaceId,
    sourceOwnerId,
    new Date(nowMs - SOURCE_FAILURE_LOOKBACK_MS).toISOString(),
  );
  return sourceCooldownFrom(records, nowMs);
}
