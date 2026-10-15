/**
 * Wake pickup sweep — P-006 slice 2 of parked-agent-census-resumption-and-root-cause-2026-10-09
 * (WI-10008157, decision D-004).
 *
 * The pump books every turn-capable delivery `turn_proof='awaiting'` with a pickup deadline
 * unless the executor already holds the host's own turn-start attestation. This sweep, run on
 * every await-sweeper tick before the pump drains, resolves those rows from REAL-TIME evidence
 * only (never the transcript store: its ingest lag p50 434s / p90 1241s would read live pickups
 * as missed):
 *
 *   1. `observed` — the subscriber made a turn-only MCP call after delivery (store SQL).
 *   2. For rows whose window closed: the psu host's own `execution.turnStartedAt` after
 *      delivery also counts as `observed`; otherwise the row becomes `not-picked-up`.
 *   3. A not-picked-up delivery on a turn-starting channel whose host reports a condition
 *      P-004/P-005 recover (auth/quota blocked, unbound successor) gets ONE re-queue.
 *      Inbox rows are reported only — never re-woken en masse (D-002).
 *   4. Each affected subscriber gets one `wake:not-picked-up:<subscriberId>` emit per tick.
 */
import { buildKey } from './catalog';
import {
  findLiveHostAsync,
  readHostEventTailAsync,
} from './psu-pty-discovery';
import {
  listExpiredPickups,
  observeAwaitingTurnProofs,
  settleExpiredPickup,
  type ExpiredPickupRow,
  type SettleExpiredPickupResult,
} from './store';
import { judgeExpiredPickup, pickupHostView, type PickupHostView, type PickupRecoverable } from './turn-proof';

/** The emitter the sweep reports through (engine.ts passes `emitAwaitedEvent`). */
export type PickupEmit = (opts: { key: string; payload: unknown; summary: string; source: string }) => Promise<unknown>;

export interface PickupSweepDeps {
  emit: PickupEmit;
  observe?: (limit: number) => Promise<number>;
  listExpired?: (limit: number) => Promise<ExpiredPickupRow[]>;
  settle?: (input: Parameters<typeof settleExpiredPickup>[0]) => Promise<SettleExpiredPickupResult>;
  readHost?: (subscriberId: string) => Promise<PickupHostView | null>;
  log?: (line: string) => void;
}

export interface PickupSweepStats {
  /** Rows resolved by turn-only MCP calls after delivery. */
  observed: number;
  /** Expired rows resolved by the host's own turn-start observation. */
  observedByHost: number;
  notPickedUp: number;
  escalated: number;
  /** `wake:not-picked-up:<subscriberId>` emits (one per affected subscriber). */
  emitted: number;
}

export const PICKUP_SWEEP_SOURCE = 'pickup-sweep';
const DEFAULT_OBSERVE_LIMIT = 500;
const DEFAULT_EXPIRED_LIMIT = 200;

/** The psu host's view for the judge: discovery record plus its lifecycle tail, judged once (D-007). */
export async function readPickupHostView(subscriberId: string): Promise<PickupHostView | null> {
  const host = await findLiveHostAsync(subscriberId);
  if (!host) return null;
  // Best-effort: an unreadable tail is "no tail reading", never a recoverable verdict.
  const tail = await readHostEventTailAsync(subscriberId).catch(() => []);
  return pickupHostView(host, tail, Date.now());
}

interface SubscriberReport {
  deliveryIds: number[];
  channels: string[];
  escalated: Array<{ deliveryId: number; requeuedDeliveryId: number; recoverable: PickupRecoverable | null }>;
  reasons: string[];
}

export async function runPickupSweep(
  deps: PickupSweepDeps,
  opts: { observeLimit?: number; expiredLimit?: number } = {},
): Promise<PickupSweepStats> {
  const observe = deps.observe ?? observeAwaitingTurnProofs;
  const listExpired = deps.listExpired ?? listExpiredPickups;
  const settle = deps.settle ?? settleExpiredPickup;
  const readHost = deps.readHost ?? readPickupHostView;
  const log = deps.log ?? (() => {});

  const stats: PickupSweepStats = { observed: 0, observedByHost: 0, notPickedUp: 0, escalated: 0, emitted: 0 };

  // Turn-only MCP evidence first: it also clears expired rows whose turn started late, so the
  // expired pass below only sees deliveries with no tool-call evidence at all.
  stats.observed = await observe(opts.observeLimit ?? DEFAULT_OBSERVE_LIMIT);

  const expired = await listExpired(opts.expiredLimit ?? DEFAULT_EXPIRED_LIMIT);
  if (expired.length === 0) return stats;

  const hosts = new Map<string, PickupHostView | null>();
  const reports = new Map<string, SubscriberReport>();
  for (const row of expired) {
    let host = hosts.get(row.subscriberId);
    if (host === undefined) {
      try {
        host = await readHost(row.subscriberId);
      } catch (e) {
        log(`pickup sweep: host read failed for ${row.subscriberId}: ${e instanceof Error ? e.message : e}`);
        host = null;
      }
      hosts.set(row.subscriberId, host);
    }

    const verdict = judgeExpiredPickup(row, host);
    if (verdict.proof === 'observed') {
      const res = await settle({ id: row.id, proof: 'observed', turnStartedAtMs: verdict.turnStartedAtMs });
      if (res.settled) stats.observedByHost++;
      continue;
    }

    const res = await settle({ id: row.id, proof: 'not-picked-up', escalate: verdict.escalate });
    if (!res.settled) continue; // a concurrent observe/ack won the row
    stats.notPickedUp++;
    const report = reports.get(row.subscriberId) ?? { deliveryIds: [], channels: [], escalated: [], reasons: [] };
    report.deliveryIds.push(row.id);
    if (row.channel && !report.channels.includes(row.channel)) report.channels.push(row.channel);
    if (!report.reasons.includes(verdict.reason)) report.reasons.push(verdict.reason);
    if (res.requeuedDeliveryId != null) {
      stats.escalated++;
      report.escalated.push({
        deliveryId: row.id,
        requeuedDeliveryId: res.requeuedDeliveryId,
        recoverable: verdict.recoverable,
      });
    }
    reports.set(row.subscriberId, report);
  }

  for (const [subscriberId, report] of reports) {
    const n = report.deliveryIds.length;
    try {
      await deps.emit({
        key: buildKey('wake-not-picked-up', { subscriberId }),
        payload: { subscriberId, ...report },
        summary:
          `${n} wake deliver${n === 1 ? 'y' : 'ies'} to ${subscriberId} started no turn within the pickup window` +
          (report.escalated.length > 0 ? `; ${report.escalated.length} re-queued for host recovery` : ''),
        source: PICKUP_SWEEP_SOURCE,
      });
      stats.emitted++;
    } catch (e) {
      log(`pickup sweep: emit failed for ${subscriberId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return stats;
}
