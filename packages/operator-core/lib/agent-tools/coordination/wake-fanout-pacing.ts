/** Bulk wake admission uses the existing PG governor cells and event delivery queue.
 * Reservation debt paces producers; a second bucket bounds catch-up after an outage.
 * Neither bucket relies on an operator process, timer, or in-memory queue surviving. */
import { refilledTokens } from '@papercusp/structured-concurrency';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { activeWorkspaceId } from '../../workspace-registry';

export const WAKE_FANOUT_BURST = 5;
export const WAKE_FANOUT_INTERVAL_MS = 6_000;
export const WAKE_FANOUT_PACING_FIELD = '__papercuspWakeFanout';
export const WAKE_FANOUT_RESERVATION_SCOPE = 'wake-fanout:reservation';
export const WAKE_FANOUT_EXECUTION_SCOPE = 'wake-fanout:execution';

export interface WakeFanoutPacing {
  workspaceId: string;
  notBeforeMs: number;
}

/** Negative tokens represent already-reserved future capacity, never dropped wakes. */
export function reserveWakeTimes(tokens: number, count: number, nowMs: number): { times: number[]; tokens: number } {
  const times = Array.from({ length: count }, (_, i) => nowMs + Math.ceil(Math.max(0, i + 1 - tokens) * WAKE_FANOUT_INTERVAL_MS));
  return { times, tokens: tokens - count };
}

export function withWakeFanoutPacing(payload: unknown, pacing: WakeFanoutPacing): Record<string, unknown> {
  const record = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : payload == null ? {} : { value: payload };
  return { ...record, [WAKE_FANOUT_PACING_FIELD]: pacing };
}

export function readWakeFanoutPacing(payload: unknown): WakeFanoutPacing | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>)[WAKE_FANOUT_PACING_FIELD];
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  return typeof p.workspaceId === 'string' && p.workspaceId.length > 0 &&
    typeof p.notBeforeMs === 'number' && Number.isFinite(p.notBeforeMs)
    ? { workspaceId: p.workspaceId, notBeforeMs: p.notBeforeMs } : null;
}

/** The same row lock serializes every producer/pump on every host in one workspace. */
async function useWakeBucket<T>(workspaceId: string, scope: string, decide: (tokens: number, nowMs: number) => { tokens: number; result: T }): Promise<T> {
  return boundedOrgTxn(async (sql) => {
    await sql`
      INSERT INTO harness_shared.fleet_governor
        (workspace_id, kind, scope_key, capacity, refill_per_sec, tokens, updated_at)
      VALUES (${workspaceId}, 'bucket', ${scope}, ${WAKE_FANOUT_BURST}, ${1_000 / WAKE_FANOUT_INTERVAL_MS}, ${WAKE_FANOUT_BURST}, clock_timestamp())
      ON CONFLICT (workspace_id, kind, scope_key) DO NOTHING
    `;
    const [row] = await sql<{ tokens: number; updated_at: Date; now_ms: number }[]>`
      SELECT tokens, updated_at, extract(epoch FROM clock_timestamp()) * 1000 AS now_ms
        FROM harness_shared.fleet_governor
       WHERE workspace_id = ${workspaceId} AND kind = 'bucket' AND scope_key = ${scope}
       FOR UPDATE
    `;
    const nowMs = Number(row.now_ms);
    const tokens = refilledTokens({ capacity: WAKE_FANOUT_BURST, refillPerSec: 1_000 / WAKE_FANOUT_INTERVAL_MS,
      tokens: Number(row.tokens), updatedAtMs: new Date(row.updated_at).getTime() }, nowMs);
    const decision = decide(tokens, nowMs);
    await sql`
      UPDATE harness_shared.fleet_governor SET tokens = ${decision.tokens}, updated_at = ${new Date(nowMs).toISOString()}::timestamptz
       WHERE workspace_id = ${workspaceId} AND kind = 'bucket' AND scope_key = ${scope}
    `;
    return decision.result;
  });
}

export async function reserveWakeFanout(count: number, workspaceId = activeWorkspaceId()): Promise<WakeFanoutPacing[]> {
  if (count === 0) return [];
  return useWakeBucket(workspaceId, WAKE_FANOUT_RESERVATION_SCOPE, (tokens, nowMs) => {
    const reservation = reserveWakeTimes(tokens, count, nowMs);
    return { tokens: reservation.tokens, result: reservation.times.map((notBeforeMs) => ({ workspaceId, notBeforeMs })) };
  });
}

/** Consume at execution time as well: overdue rows must never drain as a restart herd.
 * Return a delay without consuming capacity when the bucket is empty. */
export async function admitWakeFanout(pacing: WakeFanoutPacing): Promise<number> {
  return useWakeBucket(pacing.workspaceId, WAKE_FANOUT_EXECUTION_SCOPE, (tokens) => tokens >= 1
    ? { tokens: tokens - 1, result: 0 }
    : { tokens, result: Math.ceil((1 - tokens) * WAKE_FANOUT_INTERVAL_MS) });
}
