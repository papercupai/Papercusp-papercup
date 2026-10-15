/**
 * gate-liveness-sentinel — green-main-cycle-time-2026-10-08 P-023 (bar R-3).
 *
 * A red-gate alarm that a dead operator or a reboot cannot silence. The in-operator
 * `green-stall-watchdog` already detects a gate that stopped firing, but it runs INSIDE the
 * operator process, so it dies with the operator. That gap is measured: 55h with no gate runs
 * (2026-10-03..10-05, operator down) and ~22h of an activation-conflict crash loop
 * (WI-10005957) went unalarmed (audit rpt_c1597a17 rec 3).
 *
 * This module is the PURE decision. The out-of-operator caller is
 * `gate-liveness-sentinel-cli.ts`, run by the `papercusp-gate-liveness-sentinel` systemd user
 * timer. It reads Postgres directly and never goes through the operator, so the check survives
 * an operator outage. Its alarm channels are its own (journald, a durable pipeline_events row,
 * then an owner notification retried until delivered).
 *
 * Inputs come from `harness_shared.pipeline_events` for one install:
 *   - kind `green_checkpoint_fire`: the gate fired (a round was attempted).
 *   - kind `green_checkpoint`: a round ended. Its `detail` says how: a verdict (`green` is a
 *     boolean and `crashed` is not true), a crash (`crashed: true`), an activation conflict
 *     (`reason: 'conflict'`), a resource refusal (`reason: 'over-budget'` and similar), or
 *     some other non-verdict ending.
 *
 * States, evaluated only while main is red:
 *   - `no-runs`: nothing fired and nothing ended in the window. The scheduler or the operator
 *     is not running the gate.
 *   - `crash-loop`: rounds are ending, at least `crashLoopMinResults` of them in the window,
 *     and none produced a verdict. Runs start, but every one errors.
 *   - `healthy`: anything else, including fires with no ending yet (a round still running;
 *     the in-operator verdictless-death check owns a run that never ends).
 * A crash loop is never reported as `no-runs` or `healthy`: the two alarm states are disjoint
 * by construction (the window is either empty or holds rounds).
 */

/** P-023: no round start for this long while main is red is the breach. */
export const GATE_LIVENESS_NO_RUN_MS = 2 * 60 * 60 * 1_000;

/** Minimum non-verdict round endings inside the window before it counts as a crash loop. One
 *  crash is an incident; two consecutive endings without a verdict is a loop. */
export const GATE_LIVENESS_CRASH_LOOP_MIN_RESULTS = 2;

/** How often an unresolved breach re-sends its escalation. Dedup only — never a clear input. */
export const GATE_LIVENESS_REESCALATE_MS = 4 * 60 * 60 * 1_000;

/**
 * How one `green_checkpoint` row ended. `deferred` is NOT a failure: the tick found a round
 * already running, the run lock held, or nothing new to judge, so it deliberately did no work.
 * The gate writes one of these on most ticks while a suite runs or a repair is awaited, so
 * counting them as failed rounds reports a false crash loop through every normal wait.
 */
export type GateRoundEnding = 'verdict' | 'deferred' | 'crash' | 'conflict' | 'refused' | 'other';

/** Refusal reasons the gate writes in `detail.reason` when it declines to run a round. */
const REFUSAL_REASONS = new Set(['over-budget', 'disk-headroom', 'insufficient-disk', 'refused']);

/**
 * Row `status` values, as the gate writes them. These are the 13 statuses measured on
 * install `papercusp` over 2026-10-05..10-12. A status not listed falls back to `detail`,
 * and an unrecognised ending counts as `other`, a failure: an unknown new ending should
 * alarm, not stay silent.
 */
const DEFERRED_STATUSES = new Set([
  'skipped-joined-attempt', // a round is already running; this tick joined it
  'skipped-locked', // another checkpoint process owns the run lock
  'unchanged-since-verdict', // the candidate already has a verdict; waiting for a repair
  'repair-in-progress', // the frozen repair queue is waiting on its fixer
  'release-fixer-skipped-snapshot',
]);
const CRASH_STATUSES = new Set(['error']);
const CONFLICT_STATUSES = new Set(['skipped-qualification-conflict']);
const REFUSED_STATUSES = new Set([
  'skipped-memory-budget',
  'disk-headroom',
  'dependency-prewarm-missing',
  'skipped-runner-liveness-unknown',
]);

/** Classify one `green_checkpoint` row (its `detail`, plus its `status` when known). */
export function classifyGateRoundEnding(detail: unknown, status?: string | null): GateRoundEnding {
  const d = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};
  if (d.crashed === true) return 'crash';
  if (typeof d.green === 'boolean') return 'verdict';
  if (status) {
    if (DEFERRED_STATUSES.has(status)) return 'deferred';
    if (CRASH_STATUSES.has(status)) return 'crash';
    if (CONFLICT_STATUSES.has(status)) return 'conflict';
    if (REFUSED_STATUSES.has(status)) return 'refused';
  }
  const reason = typeof d.reason === 'string' ? d.reason : '';
  if (reason === 'conflict') return 'conflict';
  if (REFUSAL_REASONS.has(reason)) return 'refused';
  return 'other';
}

/** A failed round: anything that is neither a verdict nor a deliberate no-op. */
function isFailureEnding(ending: GateRoundEnding | undefined): boolean {
  return ending !== undefined && ending !== 'verdict' && ending !== 'deferred';
}

export interface GateLivenessEvent {
  kind: 'fire' | 'ending';
  atMs: number;
  /** Required when kind === 'ending'. */
  ending?: GateRoundEnding;
}

export interface GateLivenessInput {
  nowMs: number;
  /** true = main is red, false = main is green, null = the main state could not be read. */
  mainRed: boolean | null;
  events: readonly GateLivenessEvent[];
  noRunMs?: number;
  crashLoopMinResults?: number;
}

export type GateLivenessState = 'main-green' | 'healthy' | 'no-runs' | 'crash-loop' | 'unknown';

export interface GateLivenessDecision {
  state: GateLivenessState;
  /** Record the breach (journald + durable row). */
  alert: boolean;
  /** Notify the owner (retried by the caller until delivered). */
  escalate: boolean;
  reason: string;
  /** Newest fire or ending of any kind, or null when none was supplied. */
  lastActivityAtMs: number | null;
  /** `nonVerdictEndings` counts FAILED rounds only; deliberate no-op ticks are `deferred`. */
  windowCounts: { fires: number; verdicts: number; nonVerdictEndings: number; deferred: number };
  /** Stable per breach episode, so a caller alerts once per episode. Null when not breached. */
  episodeKey: string | null;
}

export function decideGateLiveness(input: GateLivenessInput): GateLivenessDecision {
  const noRunMs = input.noRunMs ?? GATE_LIVENESS_NO_RUN_MS;
  const minResults = input.crashLoopMinResults ?? GATE_LIVENESS_CRASH_LOOP_MIN_RESULTS;
  const valid = input.events.filter(
    (e) => Number.isFinite(e.atMs) && (e.kind === 'fire' || (e.kind === 'ending' && e.ending !== undefined)),
  );
  const lastActivityAtMs = valid.length ? Math.max(...valid.map((e) => e.atMs)) : null;
  const windowStart = input.nowMs - noRunMs;
  const inWindow = valid.filter((e) => e.atMs >= windowStart && e.atMs <= input.nowMs);
  const endings = inWindow.filter((e) => e.kind === 'ending');
  const failures = endings.filter((e) => isFailureEnding(e.ending));
  const windowCounts = {
    fires: inWindow.filter((e) => e.kind === 'fire').length,
    verdicts: endings.filter((e) => e.ending === 'verdict').length,
    nonVerdictEndings: failures.length,
    deferred: endings.filter((e) => e.ending === 'deferred').length,
  };
  const quiet = (state: GateLivenessState, reason: string): GateLivenessDecision => ({
    state, alert: false, escalate: false, reason, lastActivityAtMs, windowCounts, episodeKey: null,
  });
  const hours = Math.round((noRunMs / 3_600_000) * 10) / 10;

  if (input.mainRed === false) return quiet('main-green', 'main is green; the liveness invariant applies only while main is red');
  if (input.mainRed === null) return quiet('unknown', 'main red/green state could not be read; nothing was checked');

  if (inWindow.length === 0) {
    const since = lastActivityAtMs === null ? 'no gate activity on record' : `last gate activity ${new Date(lastActivityAtMs).toISOString()}`;
    return {
      state: 'no-runs', alert: true, escalate: true,
      reason: `main is red and no gate round has started for ${hours}h (${since})`,
      lastActivityAtMs, windowCounts,
      episodeKey: `no-runs:${lastActivityAtMs ?? 'never'}`,
    };
  }

  // A crash loop needs failed rounds. Deferred ticks (a round already running, nothing new to
  // judge) neither count toward it nor break it.
  if (failures.length >= minResults && windowCounts.verdicts === 0) {
    // Episode start = the first non-verdict ending after the newest verdict among ALL supplied
    // events (not only the window), so the key stays stable while old endings slide out of the
    // window. Callers should supply a lookback well beyond the window (the CLI reads 24h).
    const lastVerdictAtMs = Math.max(
      -Infinity,
      ...valid.filter((e) => e.kind === 'ending' && e.ending === 'verdict' && e.atMs <= input.nowMs).map((e) => e.atMs),
    );
    const episodeStartAtMs = Math.min(
      ...valid.filter((e) => e.kind === 'ending' && isFailureEnding(e.ending) && e.atMs > lastVerdictAtMs && e.atMs <= input.nowMs).map((e) => e.atMs),
    );
    const kinds = [...new Set(failures.map((e) => e.ending))].sort().join(', ');
    return {
      state: 'crash-loop', alert: true, escalate: true,
      reason: `main is red and gate rounds keep starting but none produced a verdict in ${hours}h (${failures.length} failed rounds: ${kinds})`,
      lastActivityAtMs, windowCounts,
      episodeKey: `crash-loop:${episodeStartAtMs}`,
    };
  }

  return quiet('healthy', `gate activity in the last ${hours}h: ${windowCounts.fires} fire(s), ${windowCounts.verdicts} verdict(s), ${windowCounts.nonVerdictEndings} failed round(s), ${windowCounts.deferred} deferred tick(s)`);
}

/** Whether a caller should (re)send the escalation for this decision, given its private state. */
export function shouldEscalate(
  decision: Pick<GateLivenessDecision, 'escalate' | 'episodeKey'>,
  last: { episodeKey: string | null; deliveredAtMs: number | null } | null,
  nowMs: number,
  reescalateMs: number = GATE_LIVENESS_REESCALATE_MS,
): boolean {
  if (!decision.escalate || decision.episodeKey === null) return false;
  if (!last || last.episodeKey !== decision.episodeKey) return true;
  // Same episode: retry until delivered, then re-send on the re-escalation cadence.
  if (last.deliveredAtMs === null) return true;
  return nowMs - last.deliveredAtMs >= reescalateMs;
}
