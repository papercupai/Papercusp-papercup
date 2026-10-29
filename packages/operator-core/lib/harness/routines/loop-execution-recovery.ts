/** Expected execution recovery shares the existing routine, wake and
 * transition stores. No new scheduler or watchdog owns this state. */
import type { Sql } from 'postgres';
import { resetFireErrors as defaultResetFireErrors } from '../../autoloop';
import { findLiveHostAsync, type PsuPtyHost } from '../../events/await/psu-pty-discovery';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { fetchGatewayOwnerExecution } from '../../inference-gateway/observability';
import { recordLoopTransition } from './loop-transition-log';

export interface ExecutionRecoveryState {
  status: 'unknown' | 'running' | 'recovering' | 'blocked';
  reason: string;
  attempts: number;
  probes: number;
  nextProbeAt: number;
  observedAt: number;
  generation: string | null;
  lastAttemptAt: number | null;
  /** The current host-bound native turn began after this exact loop fire. */
  verifiedSuccessorFireAt?: number;
}

export interface ExecutionRecoveryInput {
  ownerId: string;
  active: boolean;
  parked: boolean;
  firedAt: number;
  nowMs: number;
  host: PsuPtyHost;
  inference: { active: number | null; observedAt: number | null };
  prior?: ExecutionRecoveryState | null;
}

const OBSERVATION_MAX_AGE_MS = 15_000;
const PROBE_INTERVAL_MS = 30_000;
const MAX_UNKNOWN_PROBES = 3;
const MAX_RECOVERY_ATTEMPTS = 5;

/** WI-6554700010012442 — a SPENT budget: the unknown-state probes or the recovery attempts ran
 * out. Recovery can do nothing more for this loop, so its `block` hands the loop to the
 * ordinary actors (reconciler signal ladder, stalled-loops guard) instead of holding it.
 * A transient `blocked` (inbox-wake-repair-failed) keeps `probes: 0` and its paced retry. */
function isSpentBlock(s: ExecutionRecoveryState | null | undefined): boolean {
  return s?.status === 'blocked'
    && (s.reason === 'native-start-retry-exhausted' || Number(s.probes) >= MAX_UNKNOWN_PROBES);
}

/** Pure decision. Positive operation evidence wins over any silence clock. */
export function decideLoopExecutionRecovery(i: ExecutionRecoveryInput): {
  action: 'protect' | 'settle' | 'observe' | 'recover' | 'block';
  state: ExecutionRecoveryState;
} {
  const e = i.host.execution;
  const generation = e ? `${i.host.pid}:${e.childGeneration}:${e.childPid}` : null;
  const prior = i.prior;
  const state: ExecutionRecoveryState = {
    status: 'unknown', reason: 'native-observation-unavailable',
    attempts: prior?.attempts ?? 0, probes: prior?.probes ?? 0,
    nextProbeAt: i.nowMs + PROBE_INTERVAL_MS, observedAt: i.nowMs,
    generation, lastAttemptAt: prior?.lastAttemptAt ?? null,
  };
  const eMatchesCurrentHost = !!e && e.ownerId === i.ownerId && e.hostPid === i.host.pid
    && e.childPid === i.host.ptyPid && Number.isInteger(e.childGeneration) && Number(e.childGeneration) > 0
    && Number.isFinite(e.receivedAtMs) && Number(e.receivedAtMs) >= i.host.startedAt
    && e.observedAt <= i.nowMs && i.nowMs - e.observedAt <= OBSERVATION_MAX_AGE_MS;
  // `firedAt` is the millisecond projection of a microsecond timestamptz. Equality is
  // ambiguous and may precede the actual fire by <1ms, so only a strictly later native
  // turn start can clear this fire's failure streak.
  const verifiedSuccessorFireAt = eMatchesCurrentHost && e?.turnStartedAt != null
    && e.turnStartedAt > i.firedAt ? i.firedAt : undefined;
  const protect = (reason: string, status: ExecutionRecoveryState['status'] = 'blocked') => ({ action: 'protect' as const,
    state: { ...state, reason, status,
      ...(verifiedSuccessorFireAt == null ? {} : { verifiedSuccessorFireAt }) } });
  if (!i.active) return protect('deliberate-stop');
  if (!i.parked) return protect('intentional-cadence');
  if (i.host.quotaBlocked) return protect('provider-hold');
  if (e?.ownerInputPending) return protect('owner-input');
  if (e?.ownerStopRequested) return protect('owner-stop');
  const inferenceFresh = i.inference.observedAt != null && i.inference.observedAt <= i.nowMs
    && i.nowMs - i.inference.observedAt <= OBSERVATION_MAX_AGE_MS;
  if (inferenceFresh && Number(i.inference.active) > 0) return protect('active-inference', 'running');
  const fresh = eMatchesCurrentHost;
  if (fresh && (e.phase === 'running' || e.pendingTools > 0)) return protect('native-operation', 'running');
  if (fresh && e.phase === 'settled' && Number(e.lastProgressAt) >= i.firedAt) {
    return { action: 'settle', state: { ...state, status: 'running', reason: 'native-turn-settled', attempts: 0, probes: 0 } };
  }
  // The next routine fire still traverses the existing goal, permission,
  // budget and await gates. This decision only repairs its durable schedule.
  if (fresh && e.phase === 'failed' && Number(e.lastProgressAt) >= i.firedAt
    && inferenceFresh && i.inference.active === 0) {
    if (i.nowMs - Number(e.lastProgressAt) < PROBE_INTERVAL_MS) return protect('failure-settle-grace', 'unknown');
    if (prior && i.nowMs < prior.nextProbeAt) {
      // WI-6554700010012442: a spent budget stays handed off during its backoff, too.
      return isSpentBlock(prior) ? { action: 'block', state: prior } : {
        action: 'protect', state: { ...state, status: prior.status,
          reason: 'recovery-backoff', nextProbeAt: prior.nextProbeAt },
      };
    }
    if (state.attempts >= MAX_RECOVERY_ATTEMPTS) {
      return { action: 'block', state: { ...state, status: 'blocked', reason: 'native-start-retry-exhausted', nextProbeAt: i.nowMs + 300_000 } };
    }
    // The native observer already classifies capacity failures and parses their
    // retry hints. Anchor that hold to the failure, not each recovery sweep, and
    // retain the existing backoff when it is longer. A later routine fire still
    // traverses the ordinary AUTO, owner-input and execution guards.
    const retryAfterMs = e.failure?.retryAfterMs;
    const providerRetryAt = e.failure?.retryable && typeof retryAfterMs === 'number'
      && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      && Number.isFinite(e.failure.atMs) && e.failure.atMs >= i.firedAt && e.failure.atMs <= i.nowMs
      ? e.failure.atMs + retryAfterMs : 0;
    return { action: 'recover', state: { ...state, status: 'recovering', reason: 'native-turn-failed',
      attempts: state.attempts + 1, probes: 0, lastAttemptAt: i.nowMs,
      nextProbeAt: Math.max(providerRetryAt, i.nowMs + Math.min(300_000, PROBE_INTERVAL_MS * 2 ** state.attempts)) } };
  }
  // WI-6554700010012442: inside a spent block's backoff the answer is still 'block' (hand off).
  // Returning 'observe' here held the loop for every 5-minute window between re-blocks.
  if (prior && i.nowMs < prior.nextProbeAt) return { action: isSpentBlock(prior) ? 'block' : 'observe', state: prior };
  state.probes++;
  state.reason = !fresh ? 'native-observation-unavailable' : !inferenceFresh || i.inference.active == null
    ? 'inference-observation-unavailable' : 'native-start-unverified';
  if (state.probes >= MAX_UNKNOWN_PROBES) {
    state.status = 'blocked';
    state.nextProbeAt = i.nowMs + 300_000;
    return { action: 'block', state };
  }
  return { action: 'observe', state };
}

export interface ExecutionRecoveryDeps {
  now?: () => number;
  findHost?: (owner: string) => Promise<PsuPtyHost | null>;
  inference?: typeof fetchGatewayOwnerExecution;
  arm?: typeof armInboxWake;
  resetFireErrors?: typeof defaultResetFireErrors;
}

/** Both the reconciler and stalled guard use this same row-locked decision.
 * Active/parked/owner/fire predicates fence a concurrent stop, re-arm or fire.
 * A failed prerequisite retains its reason and next probe in routine metadata. */
export async function recoverExpectedLoopExecution(input: {
  sql: Sql; routineId: string; ownerId: string; nowMs: number; dryRun?: boolean;
  /** Permit only the fenced error-streak reset while suppressing wake repair and routine writes. */
  resetVerifiedSuccessorStreak?: boolean;
}, deps: ExecutionRecoveryDeps = {}): Promise<{ handled: boolean; state?: ExecutionRecoveryState; rearmed?: boolean }> {
  const getHost = deps.findHost ?? findLiveHostAsync;
  const host = await getHost(input.ownerId);
  // Exited sessions continue through the existing captured-handle resume path.
  // A parked child also uses that path; its transcript belongs to a predecessor.
  if (!host || host.parked) return { handled: false };
  // Bridged hosts keep their loaded code across child carry-respawns. Hosts
  // launched before the execution observer never publish this property; an
  // unknown-state probe cannot make them acquire that capability. Preserve
  // the existing bounded, fire-fenced reconciler instead of intercepting it
  // forever. A supported host that publishes an unavailable observation still
  // takes the fail-closed decision below; absence never certifies idle or done.
  if (!Object.prototype.hasOwnProperty.call(host, 'execution')) return { handled: false };
  const inference = await (deps.inference ?? fetchGatewayOwnerExecution)(input.ownerId);
  return input.sql.begin(async tx => {
    const rows = await tx<Array<{
      active: boolean; parked: boolean; target_owner_id: string; fired_ms: string | null; fired_at: string;
      metadata: Record<string, unknown>; install_slug: string; workspace_id: string; name: string;
    }>>`SELECT active, next_fire_at = 'infinity'::timestamptz AS parked, target_owner_id,
       (extract(epoch FROM last_fired_at) * 1000)::bigint::text AS fired_ms,
       last_fired_at::text AS fired_at,
       metadata, install_slug, workspace_id, name
       FROM harness_shared.routines WHERE id = ${input.routineId} FOR UPDATE`;
    const row = rows[0];
    if (!row || !row.active || !row.parked || row.target_owner_id !== input.ownerId || row.fired_ms == null) {
      return { handled: false };
    }
    const current = await getHost(input.ownerId);
    if (!current || current.pid !== host.pid || current.parked) return { handled: true };
    const prior = row.metadata?.executionRecovery as ExecutionRecoveryState | undefined;
    // The HTTP read and row-lock wait happened after the sweep's clock. Sample
    // again at the decision boundary so their fresh observations are not future.
    const nowMs = Math.max(input.nowMs, (deps.now ?? Date.now)());
    const decision = decideLoopExecutionRecovery({ ownerId: input.ownerId, active: row.active,
      parked: row.parked, firedAt: Number(row.fired_ms), nowMs, host: current, inference, prior });
    if (decision.action === 'settle' || decision.action === 'protect') {
      if (
        (!input.dryRun || input.resetVerifiedSuccessorStreak === true) &&
        decision.state.verifiedSuccessorFireAt === Number(row.fired_ms)
      ) {
        await (deps.resetFireErrors ?? defaultResetFireErrors)(row.install_slug, row.name, {
          workspaceId: row.workspace_id,
          expectedLastFiredAt: row.fired_at,
        });
      }
      if (!input.dryRun && (prior?.status !== decision.state.status || prior?.reason !== decision.state.reason
        || prior?.generation !== decision.state.generation || prior?.attempts !== decision.state.attempts
        || prior?.verifiedSuccessorFireAt !== decision.state.verifiedSuccessorFireAt)) {
        await tx`UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${tx.json({ executionRecovery: { ...decision.state } })}
          WHERE id = ${input.routineId} AND active = TRUE AND next_fire_at = 'infinity'::timestamptz`;
      }
      return { handled: decision.action === 'protect', state: decision.state };
    }
    // WI-6554700010012442 — a spent budget is a HAND-OFF, not a hold. Returning handled:true here
    // made both callers `continue` past every other actor, so a supported host whose native
    // observation stayed unavailable kept its loop parked forever: the reconciler never re-armed
    // it and the stalled-loops guard never reached its fire-starved re-arm. The blocked state is
    // still recorded, so the reason stays visible on the routine row.
    if (decision.action === 'block') {
      if (!input.dryRun && (prior?.status !== decision.state.status || prior?.reason !== decision.state.reason
        || prior?.probes !== decision.state.probes || prior?.attempts !== decision.state.attempts
        || prior?.nextProbeAt !== decision.state.nextProbeAt)) {
        await tx`UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${tx.json({ executionRecovery: { ...decision.state } })}
          WHERE id = ${input.routineId} AND active = TRUE AND next_fire_at = 'infinity'::timestamptz`;
      }
      return { handled: false, state: decision.state };
    }
    if (input.dryRun) return { handled: true, state: decision.state, rearmed: decision.action === 'recover' };
    let rearmed = false;
    if (decision.action === 'recover') {
      const decisionGeneration = current.execution?.childGeneration;
      const decisionReceivedAt = current.execution?.receivedAtMs;
      try {
        await (deps.arm ?? armInboxWake)({ ownerId: input.ownerId,
          note: `expected-activity recovery for ${input.routineId}`, workspaceId: row.workspace_id });
        // Revalidate after the external await repair before committing a wake.
        const latest = await getHost(input.ownerId);
        if (!latest || latest.pid !== current.pid || latest.execution?.childGeneration !== decisionGeneration
          || latest.execution?.receivedAtMs !== decisionReceivedAt
          || latest.execution?.phase !== 'failed' || latest.execution?.ownerInputPending || latest.execution?.ownerStopRequested
          || Number(latest.execution?.pendingTools) > 0) return { handled: true };
        rearmed = true;
      } catch {
        decision.state.status = 'blocked';
        decision.state.reason = 'inbox-wake-repair-failed';
      }
    }
    await tx`UPDATE harness_shared.routines
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${tx.json({ executionRecovery: { ...decision.state } })},
          next_fire_at = CASE WHEN ${rearmed} THEN ${new Date(decision.state.nextProbeAt).toISOString()}::timestamptz
            ELSE next_fire_at END, updated_at = now()
      WHERE id = ${input.routineId} AND active = TRUE AND target_owner_id = ${input.ownerId}
        AND next_fire_at = 'infinity'::timestamptz
        AND last_fired_at = ${row.fired_at}::timestamptz`;
    if (rearmed) void recordLoopTransition(input.sql, { workspaceId: row.workspace_id,
      installSlug: row.install_slug, routineId: input.routineId, routineName: row.name,
      targetOwnerId: input.ownerId, event: 'rearmed', actor: 'loop-execution-recovery',
      newNextFireAt: new Date(decision.state.nextProbeAt).toISOString(), detail: { ...decision.state } });
    return { handled: true, state: decision.state, rearmed };
  });
}
