/**
 * gate-liveness-sentinel-run — one tick of the out-of-operator red-gate liveness check
 * (green-main-cycle-time-2026-10-08 P-023, bar R-3).
 *
 * The decision is pure (`gate-liveness-sentinel.ts`). This module wires it to its inputs and
 * alarm channels through injected dependencies, so the whole tick is unit-testable. The real
 * caller is `scripts/gate-liveness-sentinel.mts`, run by the systemd user timer
 * `papercusp-gate-liveness-sentinel.timer`, never by the operator. It reads Postgres directly,
 * so it keeps working while the operator is down.
 *
 * Alarm channels, in order:
 *   1. a journald line on every tick (the unit's stdout);
 *   2. one durable `pipeline_events` row of kind `gate_liveness_alert` per breach episode,
 *      written idempotently, so a lost state file never duplicates it;
 *   3. an owner notification (`notifications:send_owner`, durable inbox plus push), retried
 *      every tick until delivered, then re-sent on the re-escalation cadence;
 *   4. while (3) cannot be delivered (the operator is the thing that is down), a desktop
 *      notification at most once per re-escalation interval.
 */
import type { Sql } from 'postgres';
import {
  GATE_LIVENESS_REESCALATE_MS,
  classifyGateRoundEnding,
  decideGateLiveness,
  shouldEscalate,
  type GateLivenessDecision,
  type GateLivenessEvent,
} from './gate-liveness-sentinel';

/** History read per tick: far beyond the 2h window, so crash-loop episode keys stay stable. */
export const GATE_LIVENESS_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
export const GATE_LIVENESS_ALERT_KIND = 'gate_liveness_alert';

export interface GateLivenessSnapshot {
  mainRed: boolean | null;
  events: GateLivenessEvent[];
}

/** Private, best-effort state. Losing it (a reboot clears XDG_RUNTIME_DIR) only re-alerts. */
export interface GateLivenessSentinelState {
  episodeKey: string | null;
  deliveredAtMs: number | null;
  alertedEpisodeKey: string | null;
  desktopNotifiedAtMs: number | null;
}

export interface GateLivenessNotification {
  dedupeKey: string;
  title: string;
  body: string;
}

export interface GateLivenessSentinelDeps {
  installSlug: string;
  nowMs(): number;
  readSnapshot(nowMs: number): Promise<GateLivenessSnapshot>;
  loadState(): Promise<GateLivenessSentinelState | null>;
  saveState(state: GateLivenessSentinelState): Promise<void>;
  /** Write the durable alert row. Must be idempotent per `decision.episodeKey`. */
  recordAlert(decision: GateLivenessDecision, nowMs: number): Promise<void>;
  /** Resolves true only when the owner notification was accepted. */
  notifyOwner(n: GateLivenessNotification): Promise<boolean>;
  /** Operator-independent fallback. Resolves true when shown. */
  notifyDesktop(n: GateLivenessNotification): Promise<boolean>;
  log(line: string): void;
}

export interface GateLivenessTickResult {
  decision: GateLivenessDecision | null;
  alertRecorded: boolean;
  ownerNotified: boolean;
  desktopNotified: boolean;
  /** Set when the ledger could not be read; the caller exits non-zero so systemd shows it. */
  readError: string | null;
}

const EMPTY_STATE: GateLivenessSentinelState = {
  episodeKey: null, deliveredAtMs: null, alertedEpisodeKey: null, desktopNotifiedAtMs: null,
};

/**
 * Read the gate's own ledger for one install. `main red` is the newest real verdict row
 * (`detail.green` boolean, not a crash) being red; no verdict on record at all is `null`.
 */
export async function readGateLivenessSnapshot(
  sql: Sql,
  opts: { workspaceId: string; installSlug: string; nowMs: number; lookbackMs?: number },
): Promise<GateLivenessSnapshot> {
  const since = new Date(opts.nowMs - (opts.lookbackMs ?? GATE_LIVENESS_LOOKBACK_MS));
  const rows = await sql<{ kind: string; status: string; detail: unknown; created_at: Date }[]>`
    SELECT kind, status, detail, created_at
      FROM harness_shared.pipeline_events
     WHERE workspace_id = ${opts.workspaceId}
       AND install_slug = ${opts.installSlug}
       AND kind IN ('green_checkpoint_fire', 'green_checkpoint')
       AND created_at >= ${since}
     ORDER BY created_at`;
  const verdict = await sql<{ green: boolean }[]>`
    SELECT (detail->>'green')::boolean AS green
      FROM harness_shared.pipeline_events
     WHERE workspace_id = ${opts.workspaceId}
       AND install_slug = ${opts.installSlug}
       AND kind = 'green_checkpoint'
       AND jsonb_typeof(detail->'green') = 'boolean'
       AND COALESCE(detail->>'crashed', 'false') <> 'true'
     ORDER BY created_at DESC
     LIMIT 1`;
  // Positive control. A gate that has run even once leaves a verdict row, so a ledger with no
  // verdict ever AND no activity in the lookback is almost certainly the WRONG database (a stale
  // embedded-PG discovery file resolves to an empty one) or the wrong install. Reading that as
  // `unknown` would keep the alarm silent forever, so it fails loudly instead.
  if (verdict.length === 0 && rows.length === 0) {
    throw new Error(
      `no green_checkpoint ledger rows at all for install ${opts.installSlug} in workspace ${opts.workspaceId}: ` +
      'wrong database or install (pin HARNESS_ADMIN_DATABASE_URL)',
    );
  }
  const events: GateLivenessEvent[] = rows.map((r) => r.kind === 'green_checkpoint_fire'
    ? { kind: 'fire', atMs: r.created_at.getTime() }
    : { kind: 'ending', atMs: r.created_at.getTime(), ending: classifyGateRoundEnding(r.detail, r.status) });
  return { mainRed: verdict.length ? !verdict[0].green : null, events };
}

/** The durable alert row, written at most once per (install, episode). */
export async function recordGateLivenessAlert(
  sql: Sql,
  opts: { workspaceId: string; installSlug: string; decision: GateLivenessDecision },
): Promise<void> {
  const { decision } = opts;
  if (!decision.episodeKey) return;
  const detail = {
    episodeKey: decision.episodeKey,
    state: decision.state,
    reason: decision.reason,
    lastActivityAt: decision.lastActivityAtMs === null ? null : new Date(decision.lastActivityAtMs).toISOString(),
    windowCounts: decision.windowCounts,
    source: 'gate-liveness-sentinel',
  };
  await sql`
    INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, detail)
    SELECT ${opts.workspaceId}, ${opts.installSlug}, ${GATE_LIVENESS_ALERT_KIND}, ${decision.state}, ${sql.json(detail)}
     WHERE NOT EXISTS (
       SELECT 1 FROM harness_shared.pipeline_events
        WHERE workspace_id = ${opts.workspaceId} AND install_slug = ${opts.installSlug}
          AND kind = ${GATE_LIVENESS_ALERT_KIND} AND detail->>'episodeKey' = ${decision.episodeKey})`;
}

function notificationFor(installSlug: string, decision: GateLivenessDecision, nowMs: number): GateLivenessNotification {
  // The bucket makes a retry inside one re-escalation interval dedupe server-side, while a
  // later re-escalation (or one after a lost state file) gets a fresh key and notifies again.
  const bucket = Math.floor(nowMs / GATE_LIVENESS_REESCALATE_MS);
  return {
    dedupeKey: `gate-liveness:${installSlug}:${decision.episodeKey}:${bucket}`,
    title: decision.state === 'no-runs'
      ? `Gate stalled: main is red and no gate round has started (${installSlug})`
      : `Gate crash loop: main is red and every gate round fails (${installSlug})`,
    body: `${decision.reason}.\n\nRaised by the out-of-operator gate liveness sentinel ` +
      `(systemd user timer papercusp-gate-liveness-sentinel). Durable record: pipeline_events kind ` +
      `${GATE_LIVENESS_ALERT_KIND}, episode ${decision.episodeKey}.`,
  };
}

export async function runGateLivenessSentinelTick(deps: GateLivenessSentinelDeps): Promise<GateLivenessTickResult> {
  const nowMs = deps.nowMs();
  const result: GateLivenessTickResult = {
    decision: null, alertRecorded: false, ownerNotified: false, desktopNotified: false, readError: null,
  };
  let snapshot: GateLivenessSnapshot;
  try {
    snapshot = await deps.readSnapshot(nowMs);
  } catch (err) {
    result.readError = err instanceof Error ? err.message : String(err);
    deps.log(`gate-liveness install=${deps.installSlug} state=unreadable error=${JSON.stringify(result.readError)}`);
    return result;
  }
  const decision = decideGateLiveness({ nowMs, mainRed: snapshot.mainRed, events: snapshot.events });
  result.decision = decision;
  deps.log(`gate-liveness install=${deps.installSlug} state=${decision.state} alert=${decision.alert} ` +
    `episode=${decision.episodeKey ?? '-'} reason=${JSON.stringify(decision.reason)}`);

  const state: GateLivenessSentinelState = { ...EMPTY_STATE, ...((await deps.loadState().catch(() => null)) ?? {}) };

  if (!decision.alert) {
    // `unknown` proves nothing either way, so it keeps the episode; a real healthy or green
    // reading closes it.
    if (decision.state !== 'unknown' && (state.episodeKey || state.alertedEpisodeKey)) {
      deps.log(`gate-liveness install=${deps.installSlug} recovered episode=${state.episodeKey ?? state.alertedEpisodeKey}`);
      await deps.saveState({ ...EMPTY_STATE });
    }
    return result;
  }

  if (state.alertedEpisodeKey !== decision.episodeKey) {
    try {
      await deps.recordAlert(decision, nowMs);
      state.alertedEpisodeKey = decision.episodeKey;
      result.alertRecorded = true;
    } catch (err) {
      deps.log(`gate-liveness install=${deps.installSlug} alert-row-failed error=${JSON.stringify(String(err))}`);
    }
  }

  const last = state.episodeKey === decision.episodeKey ? { episodeKey: state.episodeKey, deliveredAtMs: state.deliveredAtMs } : null;
  if (shouldEscalate(decision, last, nowMs)) {
    const n = notificationFor(deps.installSlug, decision, nowMs);
    const delivered = await deps.notifyOwner(n).catch(() => false);
    result.ownerNotified = delivered;
    if (state.episodeKey !== decision.episodeKey) state.desktopNotifiedAtMs = null;
    state.episodeKey = decision.episodeKey;
    state.deliveredAtMs = delivered ? nowMs : null;
    if (!delivered) {
      deps.log(`gate-liveness install=${deps.installSlug} owner-notify-undelivered episode=${decision.episodeKey} (retrying next tick)`);
      const due = state.desktopNotifiedAtMs === null || nowMs - state.desktopNotifiedAtMs >= GATE_LIVENESS_REESCALATE_MS;
      if (due && (await deps.notifyDesktop(n).catch(() => false))) {
        state.desktopNotifiedAtMs = nowMs;
        result.desktopNotified = true;
      }
    }
  }
  await deps.saveState(state);
  return result;
}
