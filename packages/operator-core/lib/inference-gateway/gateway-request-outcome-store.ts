/**
 * Durable, privacy-bounded request outcome evidence for the inference gateway.
 *
 * The live gateway keeps a small process-local timeline for fast status reads. That
 * ring is intentionally disposable, but it cannot answer a long-tail incident
 * question after a restart. This store keeps only route dimensions, outcome
 * classes, timestamps and native correlation ids; request bodies, headers,
 * credentials and raw errors never enter the row.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { GatewayRequestTimeline } from './request-stage-telemetry';

/** Keep enough history for incident review while bounding both rows and index growth. */
export const GATEWAY_REQUEST_OUTCOME_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const GATEWAY_REQUEST_OUTCOME_DEFAULT_LIMIT = 200;
export const GATEWAY_REQUEST_OUTCOME_MAX_LIMIT = 1_000;

export interface GatewayRequestOutcomeRecord {
  requestId: string;
  gatewayProcessInstanceId: string;
  requestOrdinal: number;
  workspaceId: string;
  ownerId: string | null;
  provider: GatewayRequestTimeline['provider'];
  protocol: GatewayRequestTimeline['protocol'];
  transport: GatewayRequestTimeline['transport'];
  model: string | null;
  selectedAccountId: string | null;
  attemptAccountIds: Array<string | null>;
  /** Exact provider completion identity; absent on historical or unobserved completions. */
  providerResponseId?: string | null;
  outcomeClass: GatewayRequestTimeline['outcome'];
  finalStatus: number | null;
  requestTimestampMs: number;
  finalizedAtMs: number;
  attempts: number;
  failovers: number;
  nativeSessionId: string | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
  nativeWindowId: string | null;
  recordedAtMs: number;
  retentionExpiresAtMs: number;
}

export interface GatewayRequestOutcomeQuery {
  ownerId: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  nowMs?: number;
}

export interface GatewayRequestOutcomeReport {
  rows: GatewayRequestOutcomeRecord[];
  total: number;
  byOutcome: Record<GatewayRequestTimeline['outcome'], number>;
  firstRequestTimestampMs: number | null;
  lastFinalizedAtMs: number | null;
  truncated: boolean;
  retentionMs: number;
}

/** A provider-wide window over every caller, for capacity verdicts (WI-6554700010029776). */
export interface GatewayProviderOutcomeQuery {
  provider: GatewayRequestTimeline['provider'];
  fromMs: number;
  toMs?: number;
  nowMs?: number;
}

/**
 * Per-provider outcome counts over a window. `refused` is the gateway turning a
 * request away (`shed` + `upstream-429`); `served` is `ok`. `cancelled` is a
 * client abort, not a capacity signal, so it counts in `byOutcome` only.
 */
export interface GatewayProviderOutcomeSummary {
  provider: GatewayRequestTimeline['provider'];
  fromMs: number;
  toMs: number;
  byOutcome: Record<GatewayRequestTimeline['outcome'], number>;
  refused: number;
  served: number;
  /** Distinct callers (owner ids, null counted once) that had at least one refusal. */
  refusedOwners: number;
  /** The caller with the most refusals, or null when nothing was refused. */
  topRefusedOwner: { ownerId: string | null; refused: number } | null;
}

export interface GatewayRequestOutcomeStore {
  record(record: GatewayRequestOutcomeRecord): Promise<void>;
  report(query: GatewayRequestOutcomeQuery): Promise<GatewayRequestOutcomeReport>;
  providerSummary(query: GatewayProviderOutcomeQuery): Promise<GatewayProviderOutcomeSummary>;
}

const REFUSED_OUTCOMES: ReadonlySet<GatewayRequestTimeline['outcome']> = new Set(['shed', 'upstream-429']);

/** Fold (outcome, owner, count) triples into a provider summary. Shared by both stores. */
export function summarizeProviderOutcomeCounts(
  provider: GatewayRequestTimeline['provider'],
  window: { fromMs: number; toMs: number },
  rows: Iterable<{ outcome: GatewayRequestTimeline['outcome']; ownerId: string | null; count: number }>,
): GatewayProviderOutcomeSummary {
  const byOutcome = emptyCounts();
  const refusedByOwner = new Map<string | null, number>();
  for (const row of rows) {
    if (!(row.outcome in byOutcome) || !Number.isFinite(row.count) || row.count <= 0) continue;
    byOutcome[row.outcome] += row.count;
    if (REFUSED_OUTCOMES.has(row.outcome)) {
      refusedByOwner.set(row.ownerId, (refusedByOwner.get(row.ownerId) ?? 0) + row.count);
    }
  }
  let topRefusedOwner: GatewayProviderOutcomeSummary['topRefusedOwner'] = null;
  for (const [ownerId, refused] of refusedByOwner) {
    if (!topRefusedOwner || refused > topRefusedOwner.refused) topRefusedOwner = { ownerId, refused };
  }
  return {
    provider,
    fromMs: window.fromMs,
    toMs: window.toMs,
    byOutcome,
    refused: byOutcome.shed + byOutcome['upstream-429'],
    served: byOutcome.ok,
    refusedOwners: refusedByOwner.size,
    topRefusedOwner,
  };
}

const OUTCOMES: readonly GatewayRequestTimeline['outcome'][] = [
  'ok', 'client-error', 'upstream-429', 'upstream-error', 'shed', 'cancelled', 'gateway-error', 'unclassified',
];

function emptyCounts(): Record<GatewayRequestTimeline['outcome'], number> {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<GatewayRequestTimeline['outcome'], number>;
}

function safeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return GATEWAY_REQUEST_OUTCOME_DEFAULT_LIMIT;
  return Math.max(1, Math.min(GATEWAY_REQUEST_OUTCOME_MAX_LIMIT, Math.floor(value!)));
}

function safeWindow(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/** Convert the completed in-memory timeline into the durable row contract. */
export function gatewayRequestOutcomeRecord(
  gatewayProcessInstanceId: string,
  timeline: GatewayRequestTimeline,
  workspaceId = activeWorkspaceId(),
): GatewayRequestOutcomeRecord {
  const recordedAtMs = Math.max(0, timeline.finalizedAt);
  const attemptAccountIds = timeline.attemptAccountIds ?? [];
  const selectedAccountId = timeline.providerIdentity?.accountId ??
    (attemptAccountIds.length > 0 ? attemptAccountIds.at(-1) ?? null : timeline.cache.servingAccountId ?? null);
  return {
    requestId: `${gatewayProcessInstanceId}:${timeline.requestId}`,
    gatewayProcessInstanceId,
    requestOrdinal: timeline.requestId,
    workspaceId,
    ownerId: timeline.ownerId,
    provider: timeline.provider,
    protocol: timeline.protocol,
    transport: timeline.transport,
    model: timeline.model,
    selectedAccountId,
    attemptAccountIds: [...attemptAccountIds],
    providerResponseId: timeline.providerIdentity?.responseId ?? null,
    outcomeClass: timeline.outcome,
    finalStatus: timeline.finalStatus,
    requestTimestampMs: timeline.startedAt,
    finalizedAtMs: timeline.finalizedAt,
    attempts: timeline.attempts,
    failovers: timeline.failovers,
    nativeSessionId: timeline.nativeCorrelation.sessionId,
    nativeThreadId: timeline.nativeCorrelation.threadId,
    nativeTurnId: timeline.nativeCorrelation.turnId,
    nativeWindowId: timeline.nativeCorrelation.windowId,
    recordedAtMs,
    retentionExpiresAtMs: recordedAtMs + GATEWAY_REQUEST_OUTCOME_RETENTION_MS,
  };
}

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

type GatewayRequestOutcomeRow = Omit<GatewayRequestOutcomeRecord, 'workspaceId' | 'ownerId' | 'attemptAccountIds'> & {
  workspace_id: string;
  owner_id: string | null;
  request_id: string;
  gateway_process_instance_id: string;
  request_ordinal: number | string;
  selected_account_id: string | null;
  attempt_account_ids: unknown;
  provider_response_id: string | null;
  outcome_class: GatewayRequestOutcomeRecord['outcomeClass'];
  final_status: number | string | null;
  request_timestamp_ms: number | string;
  finalized_at_ms: number | string;
  native_session_id: string | null;
  native_thread_id: string | null;
  native_turn_id: string | null;
  native_window_id: string | null;
  recorded_at_ms: number | string;
  retention_expires_at_ms: number | string;
};

function fromRow(row: GatewayRequestOutcomeRow): GatewayRequestOutcomeRecord {
  return {
    requestId: row.request_id,
    gatewayProcessInstanceId: row.gateway_process_instance_id,
    requestOrdinal: Number(row.request_ordinal),
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    provider: row.provider,
    protocol: row.protocol,
    transport: row.transport,
    model: row.model,
    selectedAccountId: row.selected_account_id,
    attemptAccountIds: Array.isArray(row.attempt_account_ids)
      ? row.attempt_account_ids.map((accountId): string | null => typeof accountId === 'string' ? accountId : null)
      : [],
    providerResponseId: row.provider_response_id,
    outcomeClass: row.outcome_class,
    finalStatus: row.final_status == null ? null : Number(row.final_status),
    requestTimestampMs: Number(row.request_timestamp_ms),
    finalizedAtMs: Number(row.finalized_at_ms),
    attempts: Number(row.attempts),
    failovers: Number(row.failovers),
    nativeSessionId: row.native_session_id,
    nativeThreadId: row.native_thread_id,
    nativeTurnId: row.native_turn_id,
    nativeWindowId: row.native_window_id,
    recordedAtMs: Number(row.recorded_at_ms),
    retentionExpiresAtMs: Number(row.retention_expires_at_ms),
  };
}

class PgGatewayRequestOutcomeStore implements GatewayRequestOutcomeStore {
  constructor(private readonly injectedSql?: Sql) {}

  async record(record: GatewayRequestOutcomeRecord): Promise<void> {
    const sql = sqlOf(this.injectedSql);
    await sql`
      INSERT INTO harness_shared.gateway_request_outcomes
        (request_id, workspace_id, gateway_process_instance_id, request_ordinal, owner_id,
         provider, protocol, transport, model, selected_account_id, outcome_class, final_status,
         request_timestamp_ms, finalized_at_ms, attempts, failovers,
         native_session_id, native_thread_id, native_turn_id, native_window_id,
         recorded_at_ms, retention_expires_at_ms, provider_response_id, attempt_account_ids)
      VALUES
        (${record.requestId}, ${record.workspaceId}, ${record.gatewayProcessInstanceId}, ${record.requestOrdinal},
         ${record.ownerId}, ${record.provider}, ${record.protocol}, ${record.transport}, ${record.model},
         ${record.selectedAccountId}, ${record.outcomeClass}, ${record.finalStatus}, ${record.requestTimestampMs},
         ${record.finalizedAtMs}, ${record.attempts}, ${record.failovers}, ${record.nativeSessionId},
         ${record.nativeThreadId}, ${record.nativeTurnId}, ${record.nativeWindowId}, ${record.recordedAtMs},
         ${record.retentionExpiresAtMs}, ${record.providerResponseId ?? null},
         ${sql.json(record.attemptAccountIds)})
      ON CONFLICT (gateway_process_instance_id, request_ordinal) DO NOTHING
    `;
    // Pruning is row-bounded by the indexed retention key and happens only on a write.
    await sql`
      DELETE FROM harness_shared.gateway_request_outcomes
       WHERE workspace_id = ${record.workspaceId} AND retention_expires_at_ms <= ${record.recordedAtMs}
    `;
  }

  async report(query: GatewayRequestOutcomeQuery): Promise<GatewayRequestOutcomeReport> {
    const sql = sqlOf(this.injectedSql);
    const nowMs = safeWindow(query.nowMs, Date.now());
    const fromMs = safeWindow(query.fromMs, nowMs - GATEWAY_REQUEST_OUTCOME_RETENTION_MS);
    const toMs = safeWindow(query.toMs, nowMs + 1);
    const limit = safeLimit(query.limit);
    const where = sql`workspace_id = ${activeWorkspaceId()}
         AND owner_id = ${query.ownerId}
         AND retention_expires_at_ms > ${nowMs}
         AND request_timestamp_ms >= ${fromMs}
         AND request_timestamp_ms < ${toMs}`;
    const countRows = await sql<Array<{ total: number | string }>>`
      SELECT count(*) AS total FROM harness_shared.gateway_request_outcomes WHERE ${where}
    `;
    const total = Number(countRows[0]?.total ?? 0);
    const rows = await sql<GatewayRequestOutcomeRow[]>`
      SELECT request_id, workspace_id, gateway_process_instance_id, request_ordinal, owner_id,
             provider, protocol, transport, model, selected_account_id, outcome_class, final_status,
             request_timestamp_ms, finalized_at_ms, attempts, failovers,
             native_session_id, native_thread_id, native_turn_id, native_window_id,
             recorded_at_ms, retention_expires_at_ms, provider_response_id, attempt_account_ids
        FROM harness_shared.gateway_request_outcomes
       WHERE ${where}
       ORDER BY request_timestamp_ms ASC, request_ordinal ASC
       LIMIT ${limit}
    `;
    const converted = rows.map(fromRow);
    const byOutcome = emptyCounts();
    for (const row of converted) byOutcome[row.outcomeClass]++;
    return {
      rows: converted,
      total,
      byOutcome,
      firstRequestTimestampMs: converted[0]?.requestTimestampMs ?? null,
      lastFinalizedAtMs: converted.at(-1)?.finalizedAtMs ?? null,
      truncated: total > converted.length,
      retentionMs: GATEWAY_REQUEST_OUTCOME_RETENTION_MS,
    };
  }

  async providerSummary(query: GatewayProviderOutcomeQuery): Promise<GatewayProviderOutcomeSummary> {
    const sql = sqlOf(this.injectedSql);
    const nowMs = safeWindow(query.nowMs, Date.now());
    const fromMs = safeWindow(query.fromMs, nowMs);
    const toMs = safeWindow(query.toMs, nowMs + 1);
    // Aggregated in SQL: a busy provider writes thousands of rows per window, and only
    // (outcome, owner) counts are needed. Bounded by the window, never by a row LIMIT,
    // so the counts are a census of the window rather than a floor.
    const rows = await sql<Array<{ outcome_class: GatewayRequestTimeline['outcome']; owner_id: string | null; n: number | string }>>`
      SELECT outcome_class, owner_id, count(*) AS n
        FROM harness_shared.gateway_request_outcomes
       WHERE workspace_id = ${activeWorkspaceId()}
         AND provider = ${query.provider}
         AND retention_expires_at_ms > ${nowMs}
         AND request_timestamp_ms >= ${fromMs}
         AND request_timestamp_ms < ${toMs}
       GROUP BY outcome_class, owner_id
    `;
    return summarizeProviderOutcomeCounts(query.provider, { fromMs, toMs },
      rows.map((r) => ({ outcome: r.outcome_class, ownerId: r.owner_id, count: Number(r.n) })));
  }
}

/** Construct the PostgreSQL adapter; the optional client is a test seam for real-PG integration coverage. */
export function createPostgresGatewayRequestOutcomeStore(sql?: Sql): GatewayRequestOutcomeStore {
  return new PgGatewayRequestOutcomeStore(sql);
}

/** In-memory implementation for focused unit tests and hermetic gateway fixtures. */
export class InMemoryGatewayRequestOutcomeStore implements GatewayRequestOutcomeStore {
  constructor(public rows: GatewayRequestOutcomeRecord[] = []) {}
  async record(record: GatewayRequestOutcomeRecord): Promise<void> {
    if (!this.rows.some((row) => row.gatewayProcessInstanceId === record.gatewayProcessInstanceId && row.requestOrdinal === record.requestOrdinal)) {
      this.rows.push({ ...record, attemptAccountIds: [...record.attemptAccountIds] });
    }
    // Preserve the public array identity. Tests and callers can seed a store with a
    // shared row buffer to model a process restart; replacing the array here leaves
    // that durable-looking buffer stuck at its first write and makes later readers
    // miss rows. Prune in place instead.
    const retained = this.rows.filter((row) => row.retentionExpiresAtMs > record.recordedAtMs);
    this.rows.splice(0, this.rows.length, ...retained);
  }
  async report(query: GatewayRequestOutcomeQuery): Promise<GatewayRequestOutcomeReport> {
    const nowMs = safeWindow(query.nowMs, Date.now());
    const fromMs = safeWindow(query.fromMs, nowMs - GATEWAY_REQUEST_OUTCOME_RETENTION_MS);
    const toMs = safeWindow(query.toMs, nowMs + 1);
    const limit = safeLimit(query.limit);
    const matching = this.rows
      .filter((row) => row.workspaceId === activeWorkspaceId() && row.ownerId === query.ownerId &&
        row.retentionExpiresAtMs > nowMs && row.requestTimestampMs >= fromMs && row.requestTimestampMs < toMs)
      .sort((a, b) => a.requestTimestampMs - b.requestTimestampMs || a.requestOrdinal - b.requestOrdinal);
    const selected = matching
      .slice(0, limit)
      .map((row) => ({ ...row, attemptAccountIds: [...row.attemptAccountIds] }));
    const byOutcome = emptyCounts();
    for (const row of selected) byOutcome[row.outcomeClass]++;
    return {
      rows: selected,
      total: matching.length,
      byOutcome,
      firstRequestTimestampMs: selected[0]?.requestTimestampMs ?? null,
      lastFinalizedAtMs: selected.at(-1)?.finalizedAtMs ?? null,
      truncated: matching.length > selected.length,
      retentionMs: GATEWAY_REQUEST_OUTCOME_RETENTION_MS,
    };
  }
  async providerSummary(query: GatewayProviderOutcomeQuery): Promise<GatewayProviderOutcomeSummary> {
    const nowMs = safeWindow(query.nowMs, Date.now());
    const fromMs = safeWindow(query.fromMs, nowMs);
    const toMs = safeWindow(query.toMs, nowMs + 1);
    const workspaceId = activeWorkspaceId();
    return summarizeProviderOutcomeCounts(query.provider, { fromMs, toMs }, this.rows
      .filter((row) => row.workspaceId === workspaceId && row.provider === query.provider &&
        row.retentionExpiresAtMs > nowMs && row.requestTimestampMs >= fromMs && row.requestTimestampMs < toMs)
      .map((row) => ({ outcome: row.outcomeClass, ownerId: row.ownerId, count: 1 })));
  }
}

let store: GatewayRequestOutcomeStore = createPostgresGatewayRequestOutcomeStore();

export function configureGatewayRequestOutcomeStore(next: GatewayRequestOutcomeStore): void { store = next; }
export function resetGatewayRequestOutcomeStore(): void { store = createPostgresGatewayRequestOutcomeStore(); }
export function recordGatewayRequestOutcome(record: GatewayRequestOutcomeRecord): Promise<void> { return store.record(record); }
export function reportGatewayRequestOutcomes(query: GatewayRequestOutcomeQuery): Promise<GatewayRequestOutcomeReport> { return store.report(query); }
/** Provider-wide refusal/served census over a window — the capacity verdict's gateway term. */
export function summarizeGatewayProviderOutcomes(query: GatewayProviderOutcomeQuery): Promise<GatewayProviderOutcomeSummary> { return store.providerSummary(query); }

