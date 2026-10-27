/** Passive result-recovery demand, reusing the result door's spillUri/spillPath and
 * returnedContextBytes instrumentation. No second spill alarm or automatic action.
 */
import { createHmac } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { SqlIntentScope } from '../bash-substitution/sql-intent-fingerprint';
import type { SqlCorpusCursor } from '../bash-substitution/sql-intent-corpus';
import { miningScopeId } from './privacy';
import { boundedStage } from './pipeline';
import type { SearchSource, SearchCorpusOptions } from './search-reformulation';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(object(v)[k])}`).join(',')}}`
    : JSON.stringify(v) ?? 'null';
const hash = (scope: SqlIntentScope, kind: string, values: unknown[]): string => createHmac('sha256', scope.key)
  .update(JSON.stringify(['result-recovery-v1', scope.workspaceId, scope.sourceBoundary, scope.epoch, kind, values])).digest('hex');

export interface RecoveryObservation {
  scopeToken: string; providerNamespaceToken: string; actorToken: string; sourceToken: string; operationToken: string | null;
  requestToken: string; tool: string; at: string;
  spillTokens: string[]; readToken: string | null; bounded: boolean;
  action: 'projection' | 'paging' | 'spill-read' | 'requery';
  outcome: 'success' | 'error' | 'refused' | 'UNKNOWN';
  /** Exact settled output is currently readable, independent of its semantic outcome. */
  resultAvailable: boolean;
  returnedBytes: number | null;
}

/** Trusted provider identity and the actual settled result are required for outcomes.
 * Arguments, actor adjacency, a spill's size, or transport `ok` alone prove none.
 */
export function observeResultRecovery(source: SearchSource & { metadata: unknown }, scope: SqlIntentScope): RecoveryObservation | null {
  miningScopeId(scope, source.harnessSlug);
  if (source.workspaceId !== scope.workspaceId || source.authorizationScope !== scope.sourceBoundary
    || !source.namespace || !source.actor || !Number.isFinite(Date.parse(source.at))) throw new Error('invalid_recovery_scope');
  if (!source.verifiedAgent || source.origin !== 'agent' || !source.sourceComplete) return null;
  const args = object(source.args), metadata = object(source.metadata);
  const canonical = source.identityAuthority !== 'unknown' && !!source.callId;
  const paired = canonical && source.result?.complete === true && source.result.callId === source.callId
    && source.result.provider === source.provider && source.result.namespace === source.namespace;
  let body = paired ? object(source.result!.body) : {};
  if (Array.isArray(body.content)) {
    try { body = object(JSON.parse(string(object(body.content.find(v => object(v).type === 'text')).text))); }
    catch { body = {}; }
  }
  const projection = object(body._projection), cursor = object(projection.cursor);
  const spillAddresses = [metadata.spillUri, metadata.spillPath, object(cursor.args).uri, object(cursor.args).file_path]
    .map(string).filter(Boolean);
  const bounded = spillAddresses.length > 0 || projection.truncated === true || body._partial === true
    || body.truncated === true || body.eof === false || body.next_cursor != null;
  const readAddress = source.tool === 'capability:read' ? string(args.uri) || string(args.file_path) : '';
  // A request family is a demand hint, not a source/result identity. It never
  // upgrades outcome confidence and cannot cross an actor or authorization lane.
  const base = { ...args };
  for (const key of ['projection', 'view', 'cursor', 'after', 'offset', 'page', 'byte_offset', 'byte_limit', 'limit']) delete base[key];
  const status = paired ? source.result!.status : 'unknown';
  const outcome = !paired ? 'UNKNOWN' : ['error', 'timeout'].includes(status) || body.ok === false || body.isError === true ? 'error'
    : ['refused', 'denied', 'quota-exceeded', 'role-not-allowed', 'invalid-input'].includes(status) ? 'refused'
      : status !== 'ok' || !Object.keys(body).length || bounded ? 'UNKNOWN' : 'success';
  return {
    scopeToken: hash(scope, 'scope', [source.harnessSlug]), actorToken: hash(scope, 'actor', [source.actor]),
    providerNamespaceToken: hash(scope, 'provider-namespace', [source.provider, source.namespace]),
    sourceToken: hash(scope, 'source', [source.copyRef]),
    operationToken: canonical ? hash(scope, 'operation', [source.harnessSlug, source.provider, source.namespace, source.callId]) : null,
    requestToken: hash(scope, 'request', [source.tool, stable(base)]), tool: source.tool, at: source.at,
    spillTokens: [...new Set(spillAddresses.map(a => hash(scope, 'address', [a])))].sort(),
    readToken: readAddress ? hash(scope, 'address', [readAddress]) : null, bounded,
    action: readAddress ? 'spill-read' : args.projection != null || args.view != null ? 'projection'
      : ['cursor', 'after', 'offset', 'page', 'byte_offset'].some(k => args[k] != null) ? 'paging' : 'requery',
    outcome, resultAvailable: paired, returnedBytes: number(metadata.returnedContextBytes),
  };
}

export interface RecoveryEpisode {
  id: string; scopeToken: string; actorToken: string; tool: string;
  rootOperation: string; sourceRefs: string[];
  recoveryCalls: Record<RecoveryObservation['action'], number>;
  extraCalls: number; returnedBytes: number | null;
  finalOutcome: RecoveryObservation['outcome']; finalOutcomeRef: string | null;
  /** Reprojection/requery is a bounded request-family hint, never exact spill evidence. */
  linkage: 'exact-spill' | 'request-family';
}

export function collapseRecoveryCopies<T extends RecoveryObservation>(observations: readonly T[]) {
  const identities = new Map<string, T[]>();
  for (const row of observations) {
    const key = JSON.stringify([row.scopeToken, row.operationToken ?? row.sourceToken]);
    const copies = identities.get(key) ?? []; copies.push(row); identities.set(key, copies);
  }
  const operations: T[] = [], gaps = new Set<string>();
  let collisions = 0, copiesCollapsed = 0;
  for (const copies of identities.values()) {
    const signatures = new Set(copies.map(({ sourceToken: _copy, ...row }) => stable(row)));
    if (signatures.size !== 1) { collisions++; gaps.add('conflicting-operation-copies'); continue; }
    copiesCollapsed += copies.length - 1;
    operations.push(copies[0]!);
  }
  operations.sort((a, b) => a.at.localeCompare(b.at) || a.sourceToken.localeCompare(b.sourceToken));
  return { operations, collisions, copiesCollapsed, evidenceGaps: [...gaps] };
}

export function groupResultRecovery(observations: readonly RecoveryObservation[], gapMs = 120_000): {
  episodes: RecoveryEpisode[]; operations: RecoveryObservation[]; collisions: number; copiesCollapsed: number;
  evidenceGaps: string[];
} {
  if (!Number.isFinite(gapMs) || gapMs < 1 || gapMs > 30 * 60_000) throw new Error('invalid_recovery_gap');
  const { operations, collisions, copiesCollapsed, evidenceGaps } = collapseRecoveryCopies(observations);
  const gaps = new Set(evidenceGaps);
  const roots: { row: RecoveryObservation; episode: RecoveryEpisode; lastAt: string }[] = [];
  for (const row of operations) {
    if (!row.operationToken) { gaps.add('unverified-operation-identity'); continue; }
    const eligible = roots.filter(root => root.row.scopeToken === row.scopeToken && root.row.actorToken === row.actorToken
      && root.row.providerNamespaceToken === row.providerNamespaceToken
      && Date.parse(row.at) - Date.parse(root.lastAt) <= gapMs);
    const exact = row.readToken ? eligible.filter(root => root.row.spillTokens.includes(row.readToken!)) : [];
    // A separate bounded call with its own spill is another original operation,
    // even at the same time/by the same actor. Only an explicit projection/page
    // or a later unbounded requery is a request-family recovery hint.
    const hints = !row.readToken && (!row.bounded || row.action !== 'requery')
      ? eligible.filter(root => root.row.requestToken === row.requestToken
        && Date.parse(row.at) > Date.parse(root.row.at) && root.episode.finalOutcome !== 'success') : [];
    const matches = exact.length ? exact : hints;
    if (matches.length === 1) {
      const root = matches[0]!, episode = root.episode;
      episode.recoveryCalls[row.action]++; episode.extraCalls++;
      episode.sourceRefs.push(row.sourceToken); root.lastAt = row.at;
      episode.returnedBytes = episode.returnedBytes === null || row.returnedBytes === null ? null
        : episode.returnedBytes + row.returnedBytes;
      episode.finalOutcome = row.outcome;
      episode.finalOutcomeRef = row.outcome === 'UNKNOWN' ? null : row.operationToken;
      if (!exact.length) { episode.linkage = 'request-family'; gaps.add('request-family-linkage-is-heuristic'); }
      continue; // every page/repeated read remains ONE logical recovery episode
    }
    if (matches.length > 1) { gaps.add('ambiguous-recovery-parent'); continue; }
    if (row.readToken) { gaps.add('unmatched-spill-read'); continue; }
    if (!row.bounded) continue;
    roots.push({ row, lastAt: row.at, episode: {
      id: row.operationToken, scopeToken: row.scopeToken, actorToken: row.actorToken, tool: row.tool,
      rootOperation: row.operationToken, sourceRefs: [row.sourceToken],
      recoveryCalls: { projection: 0, paging: 0, 'spill-read': 0, requery: 0 }, extraCalls: 0,
      returnedBytes: row.returnedBytes, finalOutcome: 'UNKNOWN', finalOutcomeRef: null, linkage: 'exact-spill',
    } });
  }
  if (roots.some(root => root.episode.finalOutcome === 'UNKNOWN')) gaps.add('unmeasured-final-outcome');
  return { episodes: roots.map(r => r.episode), operations, collisions, copiesCollapsed, evidenceGaps: [...gaps].sort() };
}

/** Exposure is ALL distinct original invocations of the operation in the authorized
 * page, including small results. Bytes are descriptive, never a waste verdict.
 */
export function rankResultRecovery(observations: readonly RecoveryObservation[]) {
  const grouped = groupResultRecovery(observations);
  const rows = new Map<string, { tool: string; scopeToken: string; exposure: number; episodes: RecoveryEpisode[] }>();
  const recoveries = new Set(grouped.episodes.flatMap(e => e.sourceRefs.slice(1)));
  for (const row of grouped.operations) {
    if (!row.operationToken || row.readToken || recoveries.has(row.sourceToken)) continue;
    const key = JSON.stringify([row.scopeToken, row.tool]);
    const value = rows.get(key) ?? { tool: row.tool, scopeToken: row.scopeToken, exposure: 0, episodes: [] };
    value.exposure++; rows.set(key, value);
  }
  for (const row of rows.values()) row.episodes = grouped.episodes.filter(e => e.scopeToken === row.scopeToken && e.tool === row.tool && e.extraCalls > 0);
  return {
    ...grouped,
    rankings: [...rows.values()].filter(row => row.episodes.length >= 2).map(row => ({
      ...row, recoveryEpisodes: row.episodes.length, extraCalls: row.episodes.reduce((n, e) => n + e.extraCalls, 0),
      finalOutcomeRefs: row.episodes.flatMap(e => e.finalOutcomeRef ? [e.finalOutcomeRef] : []),
      successEpisodes: row.episodes.filter(e => e.finalOutcome === 'success').length,
      burdenPerExposure: row.episodes.reduce((n, e) => n + e.extraCalls, 0) / row.exposure,
    })).sort((a, b) => b.burdenPerExposure - a.burdenPerExposure || a.tool.localeCompare(b.tool)),
  };
}

export type RecoveryCorpusOptions = Omit<SearchCorpusOptions, 'readOutput'> & { readOutput: SearchCorpusOptions['readOutput'] };
/** Existing migrated ledger, keyset cursor, fresh source ACL before args/metadata,
 * and caller-authorized exact output hydration; no new telemetry store or alarm.
 */
export type RecoverySource = SearchSource & { metadata: unknown; durationMs?: number | null };
export async function fetchOperationObservations<T extends { at: string; sourceToken: string; operationToken: string | null; resultAvailable: boolean }>(
  opts: RecoveryCorpusOptions, observe: (source: RecoverySource, scope: SqlIntentScope) => T | null,
): Promise<{
  observations: T[]; next: SqlCorpusCursor | null;
  coverage: { scanned: number; denied: number; incomplete: number; status: 'unknown' | 'truncated'; unmeasuredProviders: string[] };
}> {
  miningScopeId(opts.scope, opts.harnessSlug);
  const since = Date.parse(opts.since), until = Date.parse(opts.until);
  if (opts.workspaceId !== opts.scope.workspaceId || !Number.isFinite(since) || !Number.isFinite(until)
    || until <= since || until - since > 30 * 86400_000
    || (opts.after && (!Number.isFinite(Date.parse(opts.after.at)) || !/^\d+$/.test(opts.after.id)))) throw new Error('invalid_recovery_window');
  if (!await opts.authorize({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, sourceBoundary: opts.scope.sourceBoundary }))
    throw new Error('recovery_source_denied');
  const sql = opts.client ?? getOrgPg().sql;
  const limit = opts.limit === undefined ? 250 : Number.isFinite(opts.limit) ? Math.max(1, Math.min(2000, Math.floor(opts.limit))) : 250;
  const after = opts.after ? sql`AND (invoked_at,id) > (${opts.after.at}::timestamptz,${opts.after.id}::bigint)` : sql``;
  const rows = await sql<{ id: string; at: string }[]>`SELECT id::text,
    to_char(invoked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM harness_shared.tool_invocations WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
      AND invoked_at >= ${opts.since}::timestamptz AND invoked_at < ${opts.until}::timestamptz
      ${after} ORDER BY invoked_at,tool_invocations.id LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit), allowed: string[] = [];
  for (let start = 0; start < page.length; start += 16) await Promise.all(page.slice(start, start + 16).map(async row => {
    try {
      const acl = await boundedStage(() => opts.authorizeSource(row.id), 1000);
      if (acl?.sourceBoundary === opts.scope.sourceBoundary) allowed.push(row.id);
    } catch { /* Current ACL unavailable: fail closed before raw arguments. */ }
  }));
  const records = allowed.length ? await sql<{ id: string; tool_name: string; args_json: unknown; metadata_json: unknown;
    output_ref: string | null; status: string; actor: string; agent: boolean; call_origin: string; call_origin_source: string; role: string; duration_ms: number | null }[]>`
    SELECT id::text,tool_name,args_json,metadata_json,output_ref,status,duration_ms,coord_owner_id AS actor,
      harness_shared.is_agent_coord_owner_id(coord_owner_id,role) AS agent,call_origin,call_origin_source,role
    FROM harness_shared.tool_invocations WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
      AND id=ANY(${allowed}::bigint[])` : [];
  const byId = new Map(records.map(row => [row.id, row])), observations: T[] = [];
  let incomplete = allowed.length - records.length;
  for (let start = 0; start < page.length; start += 16) await Promise.all(page.slice(start, start + 16).map(async row => {
    const record = byId.get(row.id);
    if (!record) return;
    let output: Awaited<ReturnType<RecoveryCorpusOptions['readOutput']>> = null;
    try { output = await boundedStage(() => opts.readOutput({ id: row.id, outputRef: record.output_ref,
      tool: record.tool_name, metadata: record.metadata_json }), 1000); } catch { /* Missing output stays UNKNOWN. */ }
    const observation = observe({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
      authorizationScope: opts.scope.sourceBoundary, provider: 'ledger', namespace: 'operator-dispatch',
      actor: record.actor, verifiedAgent: record.agent, origin: record.call_origin === 'agent' && record.call_origin_source === 'declared'
        && object(object(record.metadata_json).nestedDispatch).codeMode !== true && !['test', 'fixture', 'replay'].includes(record.role) ? 'agent' : 'system',
      at: row.at, copyRef: `tool-invocation:${row.id}`, tool: record.tool_name, args: record.args_json,
      metadata: record.metadata_json, durationMs: record.duration_ms, callId: `invocation:${row.id}`, identityAuthority: 'ledger',
      sourceComplete: object(record.args_json)._truncated !== true, result: output ? { ...output, status: record.status } : null }, opts.scope);
    if (observation) {
      observations.push(observation);
      if (!observation.operationToken || !observation.resultAvailable) incomplete++;
    } else if (record.agent && record.call_origin === 'agent' && record.call_origin_source === 'declared'
      && object(object(record.metadata_json).nestedDispatch).codeMode !== true
      && !['test', 'fixture', 'replay'].includes(record.role) && object(record.args_json)._truncated === true) incomplete++;
  }));
  observations.sort((a, b) => a.at.localeCompare(b.at) || a.sourceToken.localeCompare(b.sourceToken));
  return { observations, next: rows.length > limit ? page[page.length - 1]! : null,
    coverage: { scanned: page.length, denied: page.length - allowed.length, incomplete, status: rows.length > limit || opts.after ? 'truncated' : 'unknown',
      unmeasuredProviders: ['claude', 'codex', 'omp'] } };
}

export function fetchResultRecovery(opts: RecoveryCorpusOptions) {
  return fetchOperationObservations(opts, observeResultRecovery);
}
