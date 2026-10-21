/**
 * Connector source health alarm (WI-6554700010018612).
 *
 * A source the connector driver gives up on records that only in its own `data_sources` row:
 * `degraded` after repeated failures, `error` after an auth failure, `reconnect_required` after
 * a refused token refresh. The last two are never retried (`listDueConnectorSources` only picks
 * CONNECTOR_SYNC_STATUSES), so the routine's per-tick soft error stops mentioning them too.
 * Measured 2026-10-21: super@papercusp.com contacts and calendar sat `degraded` for ~10h
 * (16 failures) and a Linear source sat `reconnect_required` from 2026-10-12 (80 failures),
 * each found only by accident.
 *
 * Each `system:connector-sync` tick calls {@link runConnectorSourceHealthCheck} after the sync
 * pass. It raises one condition per unhealthy source through the severe-event rail, which
 * already de-duplicates a repeated summary into an empty-audience heartbeat. The alarm is
 * LEVEL-triggered (not one-shot): it re-signals at most every
 * {@link CONNECTOR_SOURCE_ALARM_REFRESH_MS} while the source stays unhealthy, so a source that
 * recovers outside a sync pass (reconnected, disabled, deleted) stops being signalled and the
 * condition-staleness reconciler closes its condition after its signal-absence window. A clean
 * sync pass that moves a source back to `connected` resolves the condition at once.
 *
 * Statuses that only the owner can clear (`error`, `reconnect_required`) are also routed to the
 * human, once per episode (the rail does not re-route a repeated summary).
 */
import type postgres from 'postgres';
import { CONNECTOR_UNHEALTHY_STATUSES } from './connector-runtime';
import type { SevereEventBroadcast } from '../severe-event-broadcast';

export const CONNECTOR_SOURCE_ALARM_PREFIX = 'alarm:connector-source:';

/**
 * How often a still-unhealthy source re-signals its condition. Must stay well under the
 * condition-staleness reconciler's signal-absence window (2h, condition-staleness-alarm.ts),
 * or a still-broken source would be auto-resolved as recovered.
 */
export const CONNECTOR_SOURCE_ALARM_REFRESH_MS = 30 * 60_000;

/** Statuses only the account owner can clear by reconnecting. */
export const CONNECTOR_RECONNECT_STATUSES: readonly string[] = ['error', 'reconnect_required'];

export interface UnhealthyConnectorSource {
  id: string;
  kind: string;
  status: string;
  providerAccountId: string | null;
  lastError: string | null;
  failureCount: number;
  lastSuccessAt: Date | string | null;
  nextAttemptAt: Date | string | null;
}

export function connectorSourceAlarmKey(sourceId: string): string {
  return `${CONNECTOR_SOURCE_ALARM_PREFIX}${sourceId}`;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

/**
 * The condition broadcast for one unhealthy source. The summary names only the source and its
 * status, so it stays identical while nothing material changes (the rail turns an identical
 * summary into a heartbeat) and changes when the status does (a new message).
 */
export function connectorSourceAlarm(source: UnhealthyConnectorSource): SevereEventBroadcast {
  const account = source.providerAccountId ?? 'an unnamed account';
  const reconnect = CONNECTOR_RECONNECT_STATUSES.includes(source.status);
  const lastSuccess = isoOrNull(source.lastSuccessAt);
  const nextAttempt = isoOrNull(source.nextAttemptAt);
  const body = [
    `Data source ${source.id} (${source.kind}, ${account}) has status '${source.status}'.`,
    `Last error: ${source.lastError ?? 'none recorded'}`,
    `Consecutive failures: ${source.failureCount}. Last successful sync: ${lastSuccess ?? 'never'}. ` +
      `Next attempt: ${nextAttempt ?? 'none scheduled'}.`,
    reconnect
      ? 'The connector does not retry this status. It clears when the account owner reconnects the account on its Integrations card.'
      : 'It clears on the next clean sync pass; fix the cause named in the last error.',
  ].join('\n');
  return {
    conditionKey: connectorSourceAlarmKey(source.id),
    summary: `Connector source ${source.kind} for ${account} is ${source.status}`,
    body,
    ...(reconnect
      ? { route: { ownerSelector: 'human', reason: 'Only the account owner can reconnect this data source.' } }
      : {}),
  };
}

/**
 * True when `latest` (the newest condition envelope naming `conditionKey`) is an open alarm with
 * the same summary written within `refreshMs` of `nowMs`, so this tick has nothing to add.
 */
export function isFreshOpenAlarm(
  latest: Record<string, unknown> | null,
  conditionKey: string,
  summary: string,
  nowMs: number,
  refreshMs: number = CONNECTOR_SOURCE_ALARM_REFRESH_MS,
): boolean {
  if (!latest) return false;
  if (typeof latest['resolves_condition'] === 'string' || Array.isArray(latest['resolves_conditions'])) return false;
  if (latest['condition_key'] !== conditionKey || latest['summary'] !== summary) return false;
  const ts = latest['ts'];
  const tsMs = typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(tsMs) && nowMs - tsMs < refreshMs;
}

export async function listUnhealthyConnectorSources(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<UnhealthyConnectorSource[]> {
  return sql<UnhealthyConnectorSource[]>`
    SELECT id::text AS id,
           kind,
           status,
           provider_account_id AS "providerAccountId",
           last_error AS "lastError",
           sync_failure_count AS "failureCount",
           sync_last_success_at AS "lastSuccessAt",
           sync_next_attempt_at AS "nextAttemptAt"
      FROM harness_shared.data_sources
     WHERE workspace_id = ${workspaceId}
       AND status = ANY(${sql.array([...CONNECTOR_UNHEALTHY_STATUSES])}::text[])
     ORDER BY kind, id`;
}

export interface ConnectorSourceHealthDeps {
  listUnhealthy?: (sql: postgres.Sql, workspaceId: string) => Promise<UnhealthyConnectorSource[]>;
  readLatest?: (conditionKey: string) => Promise<Record<string, unknown> | null>;
  broadcast?: (event: SevereEventBroadcast) => Promise<boolean>;
  resolve?: (conditionKey: string, source: string) => Promise<boolean>;
  now?: () => number;
}

export interface ConnectorSourceHealthResult {
  /** Sources in an unhealthy status this tick. */
  unhealthy: number;
  /** Conditions written this tick (a first alarm, a changed status, or a refresh). */
  signalled: number;
  /** Conditions resolved because a clean pass brought their source back. */
  resolved: number;
  /** Per-source failures; one never stops the others. */
  errors: string[];
}

const EMITTER = 'connector-source-health';

/**
 * One health sweep for `workspaceId`: signal every unhealthy source whose condition is not
 * already fresh, and resolve the condition of every source in `recovered` (sources a clean
 * pass this tick moved back to `connected`).
 */
export async function runConnectorSourceHealthCheck(
  sql: postgres.Sql,
  opts: { workspaceId: string; recovered?: readonly string[] },
  deps: ConnectorSourceHealthDeps = {},
): Promise<ConnectorSourceHealthResult> {
  const now = deps.now ?? Date.now;
  const readLatest = deps.readLatest ?? (async (key: string) =>
    (await import('../agent-tools/coordination/tools/conditions')).readLatestConditionEnvelope(key));
  const broadcast = deps.broadcast ?? (async (event: SevereEventBroadcast) =>
    (await import('../severe-event-broadcast')).broadcastSevereEvent(event));
  const resolve = deps.resolve ?? (async (key: string, source: string) =>
    (await import('../alarm-attention')).resolveAlarm(key, source));

  const result: ConnectorSourceHealthResult = { unhealthy: 0, signalled: 0, resolved: 0, errors: [] };
  const unhealthy = await (deps.listUnhealthy ?? listUnhealthyConnectorSources)(sql, opts.workspaceId);
  result.unhealthy = unhealthy.length;
  for (const source of unhealthy) {
    const event = connectorSourceAlarm(source);
    try {
      // A failed read falls through to the broadcast: a duplicate costs less than a lost alarm.
      const latest = await readLatest(event.conditionKey!).catch(() => null);
      if (isFreshOpenAlarm(latest, event.conditionKey!, event.summary, now())) continue;
      if (await broadcast(event)) result.signalled += 1;
      else result.errors.push(`${source.id}: alarm broadcast failed`);
    } catch (cause) {
      result.errors.push(`${source.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  for (const sourceId of opts.recovered ?? []) {
    try {
      if (await resolve(connectorSourceAlarmKey(sourceId), EMITTER)) result.resolved += 1;
    } catch (cause) {
      result.errors.push(`${sourceId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return result;
}
