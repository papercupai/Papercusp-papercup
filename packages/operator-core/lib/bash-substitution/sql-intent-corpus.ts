/** Passive SQL discovery corpus. The plain-read substitution census keeps its own semantics.
 * P-002: no SQL from the corpus is ever executed, and no plaintext query is returned.
 * Durable per-window replacement/GC belongs to the census host (P-004).
 */
import { createHmac } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_DISPATCHER_TOOLS } from '../tool-sequence-patterns';
import { fingerprintSqlIntent, type SqlIntentResult, type SqlIntentScope } from './sql-intent-fingerprint';
import { SQL_CORPUS_MAX_ROWS, SQL_CORPUS_TOOL } from './sql-corpus';

type Client = ReturnType<typeof getOrgPg>['sql'];
export type SqlDemandOrigin = 'agent' | 'polling' | 'wrapper' | 'system' | 'test' | 'fixture' | 'replay' | 'unknown';
export type SqlDemandStatus = 'ok' | 'error' | 'refused' | 'unknown';
export interface SqlDemandSource {
  workspaceId: string;
  harnessSlug: string;
  /** Canonical namespace, shared by verified copies; never the copy's storage location. */
  namespace: string;
  callId: string | null;
  resultCallId: string | null;
  /** Only a trusted adapter can establish provider IDs or the settled ledger row identity. */
  identityAuthority: 'ledger' | 'provider' | 'unknown';
  provider: string;
  actor: string | null;
  verifiedAgent: boolean;
  at: string;
  origin: SqlDemandOrigin;
  status: SqlDemandStatus;
  durationMs: number | null;
  sql: string | null;
  sourceComplete: boolean;
  copyRef: string;
}
export interface SqlDemandObservation {
  workspaceToken: string;
  harnessToken: string;
  boundaryToken: string;
  operationToken: string | null;
  actorToken: string | null;
  sourceToken: string;
  provider: string;
  day: string;
  origin: SqlDemandOrigin;
  status: SqlDemandStatus;
  durationMs: number | null;
  intent: SqlIntentResult;
}
const hash = (scope: SqlIntentScope, domain: string, values: unknown[]): string => createHmac('sha256', scope.key)
  .update(JSON.stringify(['sql-demand-v1', scope.workspaceId, scope.sourceBoundary, scope.epoch, domain, ...values]))
  .digest('hex');

/** Input is a source-authorized adapter record, not model-supplied outcome evidence.
 * Source/result IDs must agree. Actor/time adjacency and spawn grouping prove no outcome.
 */
export function observeSqlDemand(source: SqlDemandSource, scope: SqlIntentScope): SqlDemandObservation {
  if (source.workspaceId !== scope.workspaceId || !source.harnessSlug || !source.namespace
    || !scope.sourceBoundary || !scope.epoch || scope.key.byteLength < 32
    || !Number.isFinite(Date.parse(source.at))) throw new Error('invalid_sql_demand_scope');
  const paired = source.identityAuthority !== 'unknown' && !!source.callId
    && source.callId === source.resultCallId && source.sourceComplete;
  return {
    workspaceToken: hash(scope, 'workspace', []),
    harnessToken: hash(scope, 'harness', [source.harnessSlug]),
    boundaryToken: hash(scope, 'boundary', []),
    operationToken: source.identityAuthority !== 'unknown' && source.callId
      ? hash(scope, 'operation', [source.harnessSlug, source.namespace, source.callId]) : null,
    actorToken: source.verifiedAgent && source.actor ? hash(scope, 'actor', [source.actor]) : null,
    sourceToken: hash(scope, 'copy', [source.copyRef]),
    provider: ['ledger', 'claude', 'codex', 'omp'].includes(source.provider) ? source.provider : 'unknown',
    day: new Date(source.at).toISOString().slice(0, 10),
    origin: source.origin,
    status: paired ? source.status : 'unknown',
    durationMs: paired && source.durationMs !== null && Number.isFinite(source.durationMs) && source.durationMs >= 0
      ? source.durationMs : null,
    intent: fingerprintSqlIntent(source.sql ?? '', scope, source.sourceComplete ? 'complete' : 'unknown'),
  };
}

export interface SqlDemandCoverage {
  status: 'complete' | 'unknown' | 'truncated';
  scannedRows: number;
  cap: number;
  retention: 'complete' | 'gap' | 'unknown';
  providers: string[];
}
export interface SqlDailyDemand {
  workspaceToken: string;
  harnessToken: string;
  boundaryToken: string;
  day: string;
  fingerprint: string;
  version: string;
  origin: SqlDemandOrigin;
  status: SqlDemandStatus;
  logicalCalls: number;
  distinctAgents: number;
  agentTokens: string[];
  sourceTokens: string[];
  duration: { measured: number; totalMs: number; p50Ms: number | null; p95Ms: number | null };
}
export interface SqlDemandAggregate {
  daily: SqlDailyDemand[];
  coverage: SqlDemandCoverage;
  logicalCalls: number;
  copiesCollapsed: number;
  unknownIdentityRows: number;
  unknownParseOperations: number;
  collisions: number;
  activeDays: string[];
  distinctAgents: number;
}

/** Replace a scoped window with this result; never add overlapping window totals.
 * Same canonical operation = one demand, however many transcript/activity/ledger copies.
 * Same text with different canonical IDs = independent demand.
 */
export function aggregateSqlDemand(observations: readonly SqlDemandObservation[], coverage: SqlDemandCoverage): SqlDemandAggregate {
  const operations = new Map<string, SqlDemandObservation[]>();
  let unknownIdentityRows = 0, copiesCollapsed = 0, unknownParseOperations = 0, collisions = 0;
  for (const row of observations) {
    if (!row.operationToken) { unknownIdentityRows++; continue; }
    const key = JSON.stringify([row.workspaceToken, row.harnessToken, row.boundaryToken, row.operationToken]);
    const copies = operations.get(key) ?? [];
    copies.push(row); operations.set(key, copies);
  }
  const groups = new Map<string, { row: SqlDailyDemand; agents: Set<string>; sources: Set<string>; durations: number[] }>();
  const allAgents = new Set<string>(), days = new Set<string>();
  let logicalCalls = 0;
  for (const copies of operations.values()) {
    copiesCollapsed += copies.length - 1;
    // Wrappers are retained as provenance, but their outcome/SQL is not an inner call result.
    const substantive = copies.filter(r => r.origin !== 'wrapper');
    if (!substantive.length) continue;
    const chosen = substantive[0]!;
    const signature = (r: SqlDemandObservation) => JSON.stringify([r.day, r.actorToken, r.origin,
      r.intent.status === 'supported' ? r.intent.fingerprint : null]);
    const conflict = substantive.some(r => signature(r) !== signature(chosen));
    if (conflict) collisions++;
    const statuses = new Set(substantive.map(r => r.status));
    const status = !conflict && statuses.size === 1 ? chosen.status : 'unknown';
    if (conflict || chosen.intent.status !== 'supported') { unknownParseOperations++; continue; }
    const origin = chosen.origin;
    const key = JSON.stringify([chosen.workspaceToken, chosen.harnessToken, chosen.boundaryToken,
      chosen.day, chosen.intent.fingerprint, origin, status]);
    let group = groups.get(key);
    if (!group) {
      group = { row: { workspaceToken: chosen.workspaceToken, harnessToken: chosen.harnessToken,
        boundaryToken: chosen.boundaryToken, day: chosen.day, fingerprint: chosen.intent.fingerprint,
        version: chosen.intent.version, origin, status, logicalCalls: 0, distinctAgents: 0,
        agentTokens: [], sourceTokens: [], duration: { measured: 0, totalMs: 0, p50Ms: null, p95Ms: null } },
        agents: new Set(), sources: new Set(), durations: [] };
      groups.set(key, group);
    }
    group.row.logicalCalls++;
    if (chosen.actorToken) group.agents.add(chosen.actorToken);
    for (const copy of copies) group.sources.add(copy.sourceToken);
    // Duplicate durations are observations of one operation, not extra dispatch cost.
    const durations = [...new Set(substantive.flatMap(r => r.durationMs === null ? [] : [r.durationMs]))];
    if (status !== 'unknown' && durations.length === 1) group.durations.push(durations[0]!);
    if (origin === 'agent' && chosen.actorToken) {
      logicalCalls++;
      if (status === 'ok') { allAgents.add(chosen.actorToken); days.add(chosen.day); }
    }
  }
  const daily = [...groups.values()].map(({ row, agents, sources, durations }) => {
    durations.sort((a, b) => a - b);
    const percentile = (p: number) => durations.length ? durations[Math.ceil(durations.length * p) - 1]! : null;
    return { ...row, distinctAgents: agents.size, agentTokens: [...agents].sort(), sourceTokens: [...sources].sort(),
      duration: { measured: durations.length, totalMs: durations.reduce((a, b) => a + b, 0), p50Ms: percentile(.5), p95Ms: percentile(.95) } };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { daily, coverage, logicalCalls, copiesCollapsed, unknownIdentityRows, unknownParseOperations, collisions,
    activeDays: [...days].sort(), distinctAgents: allAgents.size };
}

export interface SqlCorpusCursor { at: string; id: string }
export interface SqlIntentCorpusOptions {
  workspaceId: string;
  harnessSlug: string;
  scope: SqlIntentScope;
  since: string;
  until: string;
  after?: SqlCorpusCursor;
  limit?: number;
  /** Stop between parser calls without advancing past unprocessed source rows. */
  deadline?: number;
  clock?: () => number;
  /** Trusted adapter/test seam. Production reads the native detector when absent. */
  retainedFrom?: string;
  /** Current source authorization checked before touching raw invocation args. */
  authorize: (scope: { workspaceId: string; harnessSlug: string; sourceBoundary: string }) => Promise<boolean>;
  client?: Client;
}
interface LedgerRow {
  id: string; at: string; actor: string | null; agent: boolean; tool_name: string;
  status: string; duration_ms: number | null; query: string | null; role: string;
  call_origin: string | null; call_origin_source: string | null; transport: string | null;
  truncated: boolean; indirect: boolean;
}
const partitionStatus = (status: string): SqlDemandStatus => status === 'ok' ? 'ok'
  : ['error', 'timeout'].includes(status) ? 'error'
    : ['quota-exceeded', 'role-not-allowed', 'refused', 'invalid-input', 'denied'].includes(status) ? 'refused' : 'unknown';

/** Live source receipt: no policy, oldest-row or prune-completion inference.
 * SQL comparisons preserve microseconds at an invalidated window edge.
 */
export async function readSqlIntentRetention(opts: Pick<SqlIntentCorpusOptions,
  'workspaceId' | 'harnessSlug' | 'since' | 'until' | 'client'>): Promise<SqlDemandCoverage['retention']> {
  const sql = opts.client ?? getOrgPg().sql;
  const [detector] = await sql<{ ready: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_attribute
      WHERE attrelid=to_regclass('harness_shared.sql_intent_progress') AND attname='retained_from'
        AND NOT attisdropped)
      AND (SELECT count(*)=3 FROM pg_trigger
        WHERE tgrelid=to_regclass('harness_shared.tool_invocations') AND tgenabled='A' AND NOT tgisinternal
          AND (tgname,tgtype,tgfoid) IN (
            ('sql_intent_retention_delete',8,to_regprocedure('harness_shared.sql_intent_retention_changed()')),
            ('sql_intent_retention_update',16,to_regprocedure('harness_shared.sql_intent_retention_rewritten()')),
            ('sql_intent_retention_truncate',32,to_regprocedure('harness_shared.sql_intent_retention_truncated()'))))
      AS ready`;
  if (!detector?.ready) return 'unknown';
  const [row] = await sql<{ retention: SqlDemandCoverage['retention'] }[]>`
    SELECT CASE WHEN min(retained_from) IS NULL OR ${opts.until}::timestamptz > clock_timestamp()
      THEN 'unknown' WHEN min(retained_from) <= ${opts.since}::timestamptz THEN 'complete'
      ELSE 'gap' END AS retention
    FROM harness_shared.sql_intent_progress
    WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}`;
  return row?.retention ?? 'unknown';
}

/** Bounded stable page. Caller persists/replays an overlap and replaces aggregates by
 * operationToken; a page boundary never asserts whole-window completeness.
 */
export async function fetchSqlIntentCorpus(opts: SqlIntentCorpusOptions): Promise<{
  observations: SqlDemandObservation[]; coverage: SqlDemandCoverage; next: SqlCorpusCursor | null;
  last: SqlCorpusCursor | null;
  sources: Array<{ token: string; id: string }>;
}> {
  const since = Date.parse(opts.since), until = Date.parse(opts.until);
  if (opts.scope.workspaceId !== opts.workspaceId || !opts.harnessSlug || !Number.isFinite(since)
    || !Number.isFinite(until) || until <= since || until - since > 30 * 86400_000
    || (opts.after && (!Number.isFinite(Date.parse(opts.after.at)) || !/^\d+$/.test(opts.after.id))))
    throw new Error('invalid_sql_corpus_window');
  if (!await opts.authorize({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
    sourceBoundary: opts.scope.sourceBoundary })) throw new Error('sql_corpus_source_denied');
  const sql = opts.client ?? getOrgPg().sql;
  const limit = Number.isFinite(opts.limit) ? Math.min(SQL_CORPUS_MAX_ROWS, Math.max(1, Math.floor(opts.limit!))) : SQL_CORPUS_MAX_ROWS;
  const after = opts.after ? sql`AND (invoked_at, id) > (${opts.after.at}::timestamptz, ${opts.after.id}::bigint)` : sql``;
  const rows = await sql<LedgerRow[]>`
    SELECT id::text, to_char(invoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      coord_owner_id AS actor, harness_shared.is_agent_coord_owner_id(coord_owner_id, role) AS agent,
      tool_name, status, duration_ms, transport, call_origin, call_origin_source, role,
      CASE WHEN tool_name = ${SQL_CORPUS_TOOL} THEN args_json->>'sql' ELSE args_json->'args'->>'sql' END AS query,
      COALESCE(args_json->>'_truncated', 'false') = 'true' AS truncated,
      COALESCE(metadata_json->'nestedDispatch'->>'codeMode', 'false') = 'true' AS indirect
    FROM harness_shared.tool_invocations
    WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harnessSlug}
      AND invoked_at >= ${opts.since}::timestamptz AND invoked_at < ${opts.until}::timestamptz
      AND (tool_name = ${SQL_CORPUS_TOOL}
        OR (tool_name = ANY(${[...DEFAULT_DISPATCHER_TOOLS]}::text[]) AND args_json->>'name' = ${SQL_CORPUS_TOOL}))
      ${after}
    ORDER BY invoked_at, tool_invocations.id LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const observations: SqlDemandObservation[] = [];
  const sources: Array<{ token: string; id: string }> = [];
  let processed = 0;
  for (const row of page) {
    if (opts.deadline !== undefined && (opts.clock ?? Date.now)() >= opts.deadline) break;
    const wrapper = row.tool_name !== SQL_CORPUS_TOOL;
    const origin: SqlDemandOrigin = wrapper ? 'wrapper' : ['test', 'fixture', 'replay'].includes(row.role) ? row.role as SqlDemandOrigin
      : !row.agent ? 'system'
      : row.call_origin === 'hook' ? 'polling'
        : row.call_origin === 'agent' && row.call_origin_source === 'declared' && !row.indirect ? 'agent'
          : row.call_origin === 'system' || row.indirect ? 'system' : 'unknown';
    // A request may run MULTIPLE same-text SQL calls. Its trace/spawn groups a
    // sequence, never an operation. Only the settled ledger row PK pairs outcome.
    // Pure wrappers contribute no SQL demand and need no fabricated inner ID.
    const callId = wrapper ? null : `invocation:${row.id}`;
    const observation = observeSqlDemand({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
      namespace: 'operator-dispatch', callId, resultCallId: wrapper ? null : callId,
      identityAuthority: callId ? 'ledger' : 'unknown', provider: 'ledger', actor: row.actor,
      verifiedAgent: row.agent, at: row.at, origin, status: partitionStatus(row.status),
      durationMs: row.duration_ms, sql: row.query, sourceComplete: !row.truncated,
      copyRef: `tool-invocation:${row.id}` }, opts.scope);
    observations.push(observation);
    sources.push({ token: observation.sourceToken, id: row.id });
    processed++;
  }
  const capped = rows.length > limit || processed < page.length;
  const last = processed ? { at: page[processed - 1]!.at, id: page[processed - 1]!.id } : null;
  const retained = opts.retainedFrom ? Date.parse(opts.retainedFrom) : NaN;
  const retention = opts.retainedFrom === undefined ? await readSqlIntentRetention(opts)
    : Number.isFinite(retained) ? retained <= since ? 'complete' : 'gap' : 'unknown';
  return { observations, coverage: { status: capped || opts.after ? 'truncated' : retention === 'complete' ? 'complete' : 'unknown',
    scannedRows: processed, cap: limit, retention, providers: ['ledger'] },
    next: capped ? last ?? opts.after ?? null : null, last, sources };
}
