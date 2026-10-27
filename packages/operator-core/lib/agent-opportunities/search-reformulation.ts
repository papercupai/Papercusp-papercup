/** Passive search opportunity adapter. Grouping demand never establishes an operation's outcome.
 * Raw inputs/results stay inside the authorized read; outputs contain keyed identities only.
 */
import { createHmac } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { redactSensitiveText } from '../sensitive-text';
import type { SqlIntentScope } from '../bash-substitution/sql-intent-fingerprint';
import type { SqlCorpusCursor } from '../bash-substitution/sql-intent-corpus';
import { miningScopeId } from './privacy';
import { boundedStage } from './pipeline';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';
export const SEARCH_TOOLS = ['tools:find', 'recipes:search', 'docs:search', 'plans:search', 'search:fulltext', 'search:semantic'] as const;
const searchTools = new Set<string>(SEARCH_TOOLS);
export type SearchOutcome = 'results' | 'no-results' | 'error' | 'refused' | 'UNKNOWN';
export interface SearchSource {
  workspaceId: string; harnessSlug: string; authorizationScope: string;
  provider: 'ledger' | 'claude' | 'codex' | 'omp'; namespace: string;
  actor: string; verifiedAgent: boolean; origin: 'agent' | 'system' | 'polling' | 'test' | 'unknown';
  at: string; copyRef: string; tool: string; args: unknown;
  /** Supplied by a trusted provider reader, never taken from arbitrary tool arguments. */
  callId: string | null; identityAuthority: 'ledger' | 'provider' | 'unknown';
  result: null | {
    callId: string | null; provider: SearchSource['provider']; namespace: string;
    status: string; complete: boolean; body: unknown;
  };
  sourceComplete: boolean;
}
export interface SearchObservation {
  scopeToken: string; actorToken: string; sourceToken: string; operationToken: string | null;
  requestToken: string; intentTokens: string[]; at: string; tool: string;
  kind: 'search' | 'sql-fallback' | 'shell-fallback'; provider: SearchSource['provider'];
  outcome: SearchOutcome; returned: number | null; truncated: boolean;
  /** Exact settled output is currently readable, even when its meaning is UNKNOWN. */
  resultAvailable: boolean;
  existingTools: string[];
}
const hash = (scope: SqlIntentScope, domain: string, values: unknown[]): string => createHmac('sha256', scope.key)
  .update(JSON.stringify(['search-opportunity-v1', scope.workspaceId, scope.sourceBoundary, scope.epoch, domain, values])).digest('hex');
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(object(value)[k])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';

/** Conservative token normalization; a bounded burst is demand context, never causal proof. */
function intentWords(value: string, scope: SqlIntentScope): string[] {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'by', 'find', 'search', 'select', 'from', 'where']);
  return [...new Set(redactSensitiveText(value, scope.knownSecrets).toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !stop.has(w)).map(w => w.endsWith('s') && w.length > 3 ? w.slice(0, -1) : w))].sort();
}
function requestIntent(tool: string, args: ObjectValue): { kind: SearchObservation['kind']; query: string } | null {
  if (searchTools.has(tool)) return { kind: 'search', query: text(args.query) || text(args.q) };
  if (tool === 'dev:pg_query') return { kind: 'sql-fallback', query: text(args.sql) };
  if (['capability:bash', 'capability:terminal', 'exec_command'].includes(tool)) {
    const command = text(args.command) || text(args.cmd);
    // Recognize a bounded read-search form only. Never execute or interpret arbitrary shell syntax.
    if (/^(?:rg|grep|git\s+grep)\s/.test(command.trim()) && !/[;|&`\n]|\$\(/.test(command))
      return { kind: 'shell-fallback', query: command.replace(/^(?:rg|grep|git\s+grep)\s+/, '') };
  }
  return null;
}
/** Decode actual tool output shapes, including MCP text envelopes. No timing/actor guesses. */
export function searchResultFacts(tool: string, value: unknown): {
  returned: number | null; truncated: boolean; existingTools: string[];
} {
  let body = object(value);
  if (Array.isArray(body.content)) {
    const blocks = body.content.map(object).filter(b => b.type === 'text');
    try { body = object(JSON.parse(text(blocks[0]?.text))); } catch { return { returned: null, truncated: false, existingTools: [] }; }
  }
  const truncated = body.truncated === true || body.truncatedCandidates === true || body._partial === true
    || object(body._projection).truncated === true;
  const arrays = tool === 'recipes:search' ? [body.recipes, body.hits]
    : tool === 'search:fulltext' || tool === 'search:semantic' ? [body.results, body.hits] : [body.hits, body.results];
  const hits = arrays.find(Array.isArray) as unknown[] | undefined;
  // Count only actual visible records; dispatch status ok is not proof of a useful search.
  const returned = hits ? hits.length : null;
  const existingTools = tool === 'tools:find' && hits ? hits.map(h => text(object(h).tool))
    .filter(n => /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$/.test(n)).sort() : [];
  return { returned, truncated, existingTools };
}

export function observeSearchSource(source: SearchSource, scope: SqlIntentScope): SearchObservation | null {
  miningScopeId(scope, source.harnessSlug); // shared scope/key validation
  if (source.workspaceId !== scope.workspaceId || source.authorizationScope !== scope.sourceBoundary
    || !source.namespace || !source.actor || !Number.isFinite(Date.parse(source.at))) throw new Error('invalid_search_scope');
  if (!source.verifiedAgent || source.origin !== 'agent') return null;
  const args = object(source.args), intent = requestIntent(source.tool, args);
  if (!intent || !intent.query || !source.sourceComplete || intent.query.length > 64_000) return null;
  const scopeToken = hash(scope, 'scope', [source.harnessSlug]);
  const canonical = source.identityAuthority !== 'unknown' && !!source.callId;
  const paired = canonical && source.result?.callId === source.callId
    && source.result.namespace === source.namespace && source.result.provider === source.provider && source.result.complete;
  const facts = paired ? searchResultFacts(source.tool, source.result!.body)
    : { returned: null, truncated: false, existingTools: [] };
  const status = paired ? source.result!.status : 'unknown';
  const outcome: SearchOutcome = !paired || facts.truncated ? 'UNKNOWN'
    : ['error', 'timeout'].includes(status) ? 'error'
      : ['refused', 'quota-exceeded', 'role-not-allowed', 'denied', 'invalid-input'].includes(status) ? 'refused'
        : status !== 'ok' ? 'UNKNOWN'
          : intent.kind !== 'search' ? 'results'
            : facts.returned === null ? 'UNKNOWN' : facts.returned === 0 ? 'no-results' : 'results';
  return { scopeToken, actorToken: hash(scope, 'actor', [source.actor]), sourceToken: hash(scope, 'source', [source.copyRef]),
    operationToken: canonical ? hash(scope, 'operation', [source.harnessSlug, source.provider, source.namespace, source.callId]) : null,
    requestToken: hash(scope, 'request', [source.tool, redactSensitiveText(stable(args), scope.knownSecrets)]),
    intentTokens: intentWords(intent.query, scope).map(w => hash(scope, 'intent-word', [w])),
    at: new Date(source.at).toISOString(), tool: source.tool, kind: intent.kind, provider: source.provider,
    outcome, resultAvailable: !!paired, returned: outcome === 'UNKNOWN' ? null : facts.returned, truncated: facts.truncated,
    existingTools: outcome === 'results' ? facts.existingTools : [] };
}

export interface SearchChain {
  id: string; scopeToken: string; actorToken: string; operations: SearchObservation[];
  reformulations: number; fallbacks: number;
  recommendation: { kind: 'existing-tool' | 'improve-docs' | 'improve-filters' | 'review-search'; tools: string[] };
}
export function groupSearchReformulations(observations: readonly SearchObservation[], gapMs = 120_000): {
  chains: SearchChain[]; collisions: number; copiesCollapsed: number;
} {
  if (!Number.isFinite(gapMs) || gapMs < 1 || gapMs > 30 * 60_000) throw new Error('invalid_search_burst');
  const identities = new Map<string, SearchObservation[]>();
  for (const row of observations) {
    const key = JSON.stringify([row.scopeToken, row.operationToken ?? row.sourceToken]);
    const rows = identities.get(key) ?? []; rows.push(row); identities.set(key, rows);
  }
  let collisions = 0, copiesCollapsed = 0;
  const operations: SearchObservation[] = [];
  for (const copies of identities.values()) {
    const requests = new Map<string, SearchObservation[]>();
    for (const row of copies) {
      const key = JSON.stringify([row.requestToken, row.actorToken, row.at]);
      const rows = requests.get(key) ?? []; rows.push(row); requests.set(key, rows);
    }
    const collision = requests.size > 1;
    if (collision) collisions++;
    for (const rows of requests.values()) {
      copiesCollapsed += rows.length - 1;
      // Identical requests with conflicting result copies are ambiguous too.
      const signatures = new Set(rows.map(r => JSON.stringify([r.outcome, r.returned, r.truncated, r.existingTools])));
      const row = rows[0]!;
      operations.push(collision || signatures.size > 1
        ? { ...row, outcome: 'UNKNOWN', returned: null, existingTools: [] } : row);
    }
  }
  operations.sort((a, b) => a.at.localeCompare(b.at) || a.sourceToken.localeCompare(b.sourceToken));
  const chains: SearchChain[] = [];
  const lanes = new Map<string, SearchChain[]>();
  for (const row of operations) {
    const lane = JSON.stringify([row.scopeToken, row.actorToken]);
    const candidates = lanes.get(lane) ?? [];
    const related = (chain: SearchChain) => {
      const prior = chain.operations[chain.operations.length - 1]!;
      if (Date.parse(row.at) - Date.parse(prior.at) > gapMs) return false;
      const words = new Set(chain.operations.filter(r => r.kind === 'search').flatMap(r => r.intentTokens));
      const shared = row.intentTokens.filter(w => words.has(w)).length;
      return shared >= 1 && shared / Math.max(1, Math.min(words.size, row.intentTokens.length)) >= .5;
    };
    let chain = [...candidates].reverse().find(related);
    if (!chain) {
      if (row.kind !== 'search') continue; // a fallback alone is not a search opportunity
      chain = { id: row.sourceToken, scopeToken: row.scopeToken, actorToken: row.actorToken, operations: [],
        reformulations: 0, fallbacks: 0, recommendation: { kind: 'review-search', tools: [] } };
      candidates.push(chain); lanes.set(lane, candidates); chains.push(chain);
    }
    chain.operations.push(row);
    const searches = chain.operations.filter(r => r.kind === 'search');
    chain.reformulations = Math.max(0, new Set(searches.map(r => r.requestToken)).size - 1);
    chain.fallbacks = chain.operations.length - searches.length;
    const tools = [...new Set(searches.flatMap(r => r.existingTools))].sort();
    chain.recommendation = { kind: tools.length ? 'existing-tool'
      : searches.some(r => r.truncated) ? 'improve-filters'
        : searches.some(r => r.outcome === 'no-results') ? 'improve-docs' : 'review-search', tools };
  }
  return { chains, collisions, copiesCollapsed };
}

export interface SearchCorpusOptions {
  workspaceId: string; harnessSlug: string; scope: SqlIntentScope; since: string; until: string;
  after?: SqlCorpusCursor; limit?: number; client?: ReturnType<typeof getOrgPg>['sql'];
  /** Current ACL checked before raw arguments or output references are selected. */
  authorize: (input: { workspaceId: string; harnessSlug: string; sourceBoundary: string }) => Promise<boolean>;
  /** Return the source's verified authorization boundary. Missing measurements exclude it. */
  authorizeSource: (id: string) => Promise<{ sourceBoundary: string } | null>;
  /** An authorized source reader hydrates the exact stored output, never a nearby operation. */
  readOutput: (input: { id: string; outputRef: string | null; tool: string; metadata: unknown }) => Promise<Omit<NonNullable<SearchSource['result']>, 'status'> | null>;
}
/** Stable bounded ledger page. Unavailable output is UNKNOWN, never inferred from ok status.
 * This reader supports the ledger provider; transcript adapters must supply verified IDs via
 * observeSearchSource. Coverage explicitly names those unmeasured provider surfaces.
 */
export async function fetchSearchReformulations(opts: SearchCorpusOptions): Promise<{
  observations: SearchObservation[]; next: SqlCorpusCursor | null;
  coverage: { scanned: number; denied: number; incomplete: number; status: 'unknown' | 'truncated'; providers: string[]; unmeasuredProviders: string[] };
}> {
  miningScopeId(opts.scope, opts.harnessSlug);
  const since = Date.parse(opts.since), until = Date.parse(opts.until);
  if (opts.workspaceId !== opts.scope.workspaceId || !Number.isFinite(since) || !Number.isFinite(until)
    || until <= since || until - since > 30 * 86400_000
    || (opts.after && (!Number.isFinite(Date.parse(opts.after.at)) || !/^\d+$/.test(opts.after.id)))) throw new Error('invalid_search_window');
  if (!await opts.authorize({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, sourceBoundary: opts.scope.sourceBoundary }))
    throw new Error('search_source_denied');
  const sql = opts.client ?? getOrgPg().sql;
  const limit = opts.limit === undefined ? 250 : Number.isFinite(opts.limit) ? Math.max(1, Math.min(2000, Math.floor(opts.limit))) : 250;
  const after = opts.after ? sql`AND (invoked_at,id) > (${opts.after.at}::timestamptz,${opts.after.id}::bigint)` : sql``;
  // Fetch only source identities before per-source authorization; no raw args/results cross ACLs.
  const rows = await sql<{ id: string; at: string }[]>`SELECT id::text,
    to_char(invoked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM harness_shared.tool_invocations WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
      AND invoked_at >= ${opts.since}::timestamptz AND invoked_at < ${opts.until}::timestamptz
      AND tool_name=ANY(${[...SEARCH_TOOLS, 'dev:pg_query', 'capability:bash', 'capability:terminal']}::text[])
      ${after} ORDER BY invoked_at,tool_invocations.id LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit), observations: SearchObservation[] = [];
  const permissions = new Map<string, { sourceBoundary: string }>();
  // Bound concurrency while avoiding one database round-trip per source record.
  for (let start = 0; start < page.length; start += 16) {
    await Promise.all(page.slice(start, start + 16).map(async row => {
      try {
        const permission = await boundedStage(() => opts.authorizeSource(row.id), 1000);
        if (permission?.sourceBoundary === opts.scope.sourceBoundary) permissions.set(row.id, permission);
      } catch { /* An unavailable ACL is denied, never a cached grant. */ }
    }));
  }
  const records = permissions.size ? await sql<{ id: string; tool_name: string; args_json: unknown; metadata_json: unknown; output_ref: string | null;
      status: string; actor: string; agent: boolean; call_origin: string; call_origin_source: string; role: string }[]>`
      SELECT id::text,tool_name,args_json,metadata_json,output_ref,status,coord_owner_id AS actor,
        harness_shared.is_agent_coord_owner_id(coord_owner_id,role) AS agent,call_origin,call_origin_source,role
      FROM harness_shared.tool_invocations WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
        AND id=ANY(${[...permissions.keys()]}::bigint[])` : [];
  const byId = new Map(records.map(record => [record.id, record]));
  let incomplete = permissions.size - records.length;
  const hydrate = async (row: { id: string; at: string }) => {
    const record = byId.get(row.id), permission = permissions.get(row.id);
    if (!permission) return;
    if (!record) return;
    let output: Awaited<ReturnType<SearchCorpusOptions['readOutput']>> = null;
    try { output = await boundedStage(() => opts.readOutput({ id: row.id, outputRef: record.output_ref,
      tool: record.tool_name, metadata: record.metadata_json }), 1000); }
    catch { /* A missing source result retains demand with UNKNOWN outcome. */ }
    const nested = object(object(record.metadata_json).nestedDispatch).codeMode === true;
    const observation = observeSearchSource({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
      authorizationScope: permission.sourceBoundary, provider: 'ledger', namespace: 'operator-dispatch',
      actor: record.actor, verifiedAgent: record.agent, origin: !nested && record.call_origin === 'agent' && record.call_origin_source === 'declared'
        && !['test', 'fixture', 'replay'].includes(record.role) ? 'agent' : 'system', at: row.at, copyRef: `tool-invocation:${row.id}`,
      tool: record.tool_name, args: record.args_json, callId: `invocation:${row.id}`, identityAuthority: 'ledger',
      sourceComplete: object(record.args_json)._truncated !== true,
      result: output ? { ...output, status: record.status } : null }, opts.scope);
    if (observation) {
      observations.push(observation);
      if (!observation.operationToken || !observation.resultAvailable || observation.truncated) incomplete++;
    } else if (record.agent && record.call_origin === 'agent' && record.call_origin_source === 'declared'
      && !nested && !['test', 'fixture', 'replay'].includes(record.role)
      && object(record.args_json)._truncated === true) incomplete++;
  };
  for (let start = 0; start < page.length; start += 16) {
    await Promise.all(page.slice(start, start + 16).map(hydrate));
  }
  observations.sort((a, b) => a.at.localeCompare(b.at) || a.sourceToken.localeCompare(b.sourceToken));
  return { observations, next: rows.length > limit ? page[page.length - 1]! : null,
    coverage: { scanned: page.length, denied: page.length - permissions.size, incomplete, status: rows.length > limit || opts.after ? 'truncated' : 'unknown',
      providers: ['ledger'], unmeasuredProviders: ['claude', 'codex', 'omp'] } };
}
