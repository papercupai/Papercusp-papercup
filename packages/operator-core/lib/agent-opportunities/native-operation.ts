/** Passive native-operation adapter. Canonical activity is an index into authorized
 * evidence, never a command runner or a second telemetry store. */
import { createHmac } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { summariseActivity } from '@papercusp/activity-bridge';
import { atomizePipeline } from '../bash-substitution/atomize';
import type { SqlIntentScope } from '../bash-substitution/sql-intent-fingerprint';
import { isSensitiveValueKey, redactSensitiveText, redactStructuredSensitiveValue } from '../sensitive-text';
import { createCodexTimelineParser, createOmpTimelineParser } from '../session-timeline-parsers';
import { createAgentTimelineParser } from '../owner-sessions/timeline';
import { miningScopeId, sourcesCurrentlyReadable } from './privacy';
import { boundedStage } from './pipeline';
import type { SearchSource, SearchCorpusOptions } from './search-reformulation';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(object(v)[k])}`).join(',')}}`
    : JSON.stringify(v) ?? 'null';
export const NATIVE_PROVIDERS = ['claude', 'codex', 'omp'] as const;
export type NativeProvider = typeof NATIVE_PROVIDERS[number];
export type NativeKind = 'shell' | 'browser';
export type NativeCoverageStatus = 'measured' | 'unsupported' | 'missing' | 'truncated';
const providers = new Set<string>(NATIVE_PROVIDERS);
const shellTools = new Set(['bash', 'shell', 'run', 'exec', 'execute', 'exec_command', 'functions.exec_command', 'capability:bash', 'capability:terminal']);
const browserTools = new Set(['browser', 'browser_navigate', 'browser_click', 'browser_type', 'navigate', 'click', 'type', 'browser.navigate', 'browser.click', 'browser.type']);
const browserActions = new Set(['navigate', 'click', 'type', 'fill', 'select', 'press', 'hover', 'scroll', 'snapshot', 'screenshot', 'evaluate']);
const hash = (scope: SqlIntentScope, domain: string, values: unknown[]) => createHmac('sha256', scope.key)
  .update(JSON.stringify(['native-operation-v1', scope.workspaceId, scope.sourceBoundary, scope.epoch, domain, values])).digest('hex');
function clean(value: unknown, scope: SqlIntentScope): unknown {
  // Structured credential keys are dropped BEFORE serialization/hashing; opaque
  // secrets must be removed from decoded strings: JSON escaping changes quotes,
  // newlines and backslashes, so scrubbing serialized JSON can miss a credential.
  const scrub = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      let redacted = redactSensitiveText(entry, scope.knownSecrets);
      for (const secret of scope.knownSecrets ?? []) if (secret) redacted = redacted.split(secret).join('[redacted]');
      return redacted;
    }
    if (Array.isArray(entry)) return entry.map(scrub);
    if (entry !== null && typeof entry === 'object') return Object.fromEntries(
      Object.entries(entry).map(([key, child]) => [key, scrub(child)]),
    );
    return entry;
  };
  return scrub(redactStructuredSensitiveValue(value ?? null));
}
function scrubCommand(command: string): string {
  // Shared key classification, with shell's key=value and --key value syntax.
  // Retain the flag/key while dropping the credential irrespective of length.
  const keys = /\b([A-Za-z_][\w-]*)(=|\s+)/g;
  let match: RegExpExecArray | null, output = '', copied = 0;
  while ((match = keys.exec(command))) {
    if (!isSensitiveValueKey(match[1]!)) continue;
    const end = match.index + match[0].length;
    const value = /^("[^"]*"|'[^']*'|[^\s;&|]+)/.exec(command.slice(end));
    if (!value) continue;
    output += command.slice(copied, end) + '[redacted]';
    copied = end + value[0].length; keys.lastIndex = copied;
  }
  return output + command.slice(copied);
}
function scrubBrowser(args: Obj): Obj {
  const result = { ...args };
  if (isSensitiveValueKey(text(args.selector)) || isSensitiveValueKey(text(args.element))) {
    for (const key of ['text', 'value']) if (key in result) result[key] = '[redacted]';
  }
  if (typeof args.url === 'string') {
    try {
      const url = new URL(args.url);
      if (url.username || url.password) { url.username = '[redacted]'; url.password = ''; }
      for (const key of url.searchParams.keys()) if (isSensitiveValueKey(key)) url.searchParams.set(key, '[redacted]');
      result.url = url.toString();
    } catch { /* Unsupported URL syntax still receives shared string scrubbing. */ }
  }
  return result;
}
function semantics(tool: string, input: unknown, scope: SqlIntentScope): { kind: NativeKind; value: unknown } | null {
  const args = object(clean(input, scope)), name = tool.toLowerCase();
  if (shellTools.has(name)) {
    const command = scrubCommand(text(args.command) || text(args.cmd));
    if (!command || command.length > 64_000) return null;
    const atoms = atomizePipeline(command);
    if (!atoms.length) return null;
    // Preserve raw arguments, flags, runners and operators. Normalized atom heads
    // alone erase elevation/environment semantics and cannot identify demand.
    return { kind: 'shell', value: { command, atoms: atoms.map(a => [a.raw, a.sepBefore]), cwd: args.cwd ?? args.workdir ?? null } };
  }
  if (!browserTools.has(name)) return null;
  const action = text(args.action) || name.split(/[._]/).at(-1)!;
  if (!browserActions.has(action)) return null;
  // Full scrubbed payload preserves selector/url/text/options distinctions. It is
  // retained only as a scoped keyed fingerprint, never in a candidate summary.
  return { kind: 'browser', value: { action, args: scrubBrowser(args) } };
}
export interface NativeObservation {
  scopeToken: string; actorToken: string; provider: NativeProvider; namespaceToken: string;
  sourceToken: string; operationToken: string | null; fingerprint: string | null;
  kind: NativeKind | null; at: string; outcome: 'success' | 'error' | 'refused' | 'UNKNOWN';
  resultAvailable: boolean;
  evidenceGaps: string[];
}
function resultBody(value: unknown): Obj {
  const body = object(value);
  if (Array.isArray(body.content)) {
    try { return object(JSON.parse(body.content.map(b => text(object(b).text)).join('\n'))); } catch { return {}; }
  }
  return Object.keys(object(body.structuredContent)).length ? object(body.structuredContent) : body;
}
export function observeNativeOperation(source: SearchSource, scope: SqlIntentScope): NativeObservation | null {
  miningScopeId(scope, source.harnessSlug);
  if (source.workspaceId !== scope.workspaceId || source.authorizationScope !== scope.sourceBoundary
    || !source.namespace || !source.actor || !Number.isFinite(Date.parse(source.at))) throw new Error('invalid_native_scope');
  if (!source.verifiedAgent || source.origin !== 'agent' || !providers.has(source.provider)) return null;
  const semantic = source.sourceComplete ? semantics(source.tool, source.args, scope) : null;
  const canonical = source.identityAuthority === 'provider' && !!source.callId;
  const paired = canonical && source.result?.complete === true && source.result.callId === source.callId
    && source.result.provider === source.provider && source.result.namespace === source.namespace;
  const body = paired ? resultBody(source.result!.body) : {};
  const bounded = body.truncated === true || body._partial === true || object(body._projection).truncated === true
    || body.session_id != null && body.exit_code == null;
  const status = paired ? source.result!.status : 'unknown';
  const exit = body.exit_code ?? body.exitCode;
  const outcome: NativeObservation['outcome'] = !paired || bounded || !semantic ? 'UNKNOWN'
    : ['refused', 'denied', 'invalid-input'].includes(status) ? 'refused'
      : ['error', 'timeout'].includes(status) || body.ok === false || body.isError === true || body.success === false
        || typeof exit === 'number' && exit !== 0 ? 'error'
        : status === 'ok' && (semantic.kind === 'shell' ? exit === 0 : body.success === true || body.ok === true) ? 'success' : 'UNKNOWN';
  return {
    scopeToken: miningScopeId(scope, source.harnessSlug), actorToken: hash(scope, 'actor', [source.actor]),
    provider: source.provider as NativeProvider, namespaceToken: hash(scope, 'namespace', [source.provider, source.namespace]),
    sourceToken: hash(scope, 'source', [source.copyRef]),
    operationToken: canonical ? hash(scope, 'operation', [source.harnessSlug, source.provider, source.namespace, source.callId]) : null,
    fingerprint: semantic ? hash(scope, 'semantics', [source.harnessSlug, semantic.kind, stable(semantic.value)]) : null,
    kind: semantic?.kind ?? null, at: source.at, outcome, resultAvailable: !!paired,
    evidenceGaps: [...(!source.sourceComplete ? ['truncated-source'] : !semantic ? ['unsupported-operation'] : []),
      ...(!canonical ? ['unverified-operation-identity'] : []), ...(outcome === 'UNKNOWN' ? ['unmeasured-outcome'] : [])],
  };
}

/** Same-ID copies contribute once; conflicting requests or settled results are
 * excluded. Similar text with distinct IDs always remains separate demand. */
export function groupNativeOperations(observations: readonly NativeObservation[]) {
  const groups = new Map<string, NativeObservation[]>(), gaps = new Set<string>();
  for (const row of observations) {
    row.evidenceGaps.forEach(g => gaps.add(g));
    if (!row.operationToken || !row.fingerprint || !row.kind) continue;
    const key = JSON.stringify([row.scopeToken, row.operationToken]);
    const copies = groups.get(key) ?? []; copies.push(row); groups.set(key, copies);
  }
  let collisions = 0, copiesCollapsed = 0;
  const operations: (NativeObservation & { sourceRefs: string[] })[] = [];
  for (const copies of groups.values()) {
    const identities = new Set(copies.map(r => stable([r.fingerprint, r.actorToken])));
    const outcomes = new Set(copies.filter(r => r.outcome !== 'UNKNOWN').map(r => r.outcome));
    if (identities.size !== 1 || outcomes.size > 1) { collisions++; gaps.add('conflicting-operation-copies'); continue; }
    copiesCollapsed += copies.length - 1;
    const preferred = copies.find(r => r.outcome !== 'UNKNOWN') ?? copies[0]!;
    operations.push({ ...preferred, sourceRefs: [...new Set(copies.map(r => r.sourceToken))].sort() });
  }
  const chains = new Map<string, { id: string; kind: NativeKind; scopeToken: string; logicalDemand: number; sourceRefs: string[]; operationRefs: string[]; successCount: number; unknownCount: number; summary: string }>();
  for (const row of operations) {
    const key = stable([row.scopeToken, row.kind, row.fingerprint]);
    const chain = chains.get(key) ?? { id: row.fingerprint!, kind: row.kind!, scopeToken: row.scopeToken,
      logicalDemand: 0, sourceRefs: [], operationRefs: [], successCount: 0, unknownCount: 0,
      summary: `Recurring native ${row.kind} operation` };
    chain.logicalDemand++; chain.sourceRefs.push(...row.sourceRefs); chain.operationRefs.push(row.operationToken!);
    chain.successCount += Number(row.outcome === 'success'); chain.unknownCount += Number(row.outcome === 'UNKNOWN');
    chains.set(key, chain);
  }
  return { operations, chains: [...chains.values()].filter(c => c.logicalDemand >= 2).map(c => ({ ...c, sourceRefs: [...new Set(c.sourceRefs)].sort() })),
    collisions, copiesCollapsed, evidenceGaps: [...gaps].sort() };
}
/** A derived artifact uses the intersection of every contributing source's CURRENT
 * authority. No permission cache or raw example is copied into the artifact. */
export async function readableNativeChains(observations: readonly NativeObservation[], authorize: (sourceToken: string) => Promise<boolean>) {
  const grouped = groupNativeOperations(observations);
  const chains = [];
  for (const chain of grouped.chains) if (await sourcesCurrentlyReadable(chain.sourceRefs, authorize)) chains.push(chain);
  return chains;
}

export type NativeTranscriptContext = Pick<SearchSource, 'workspaceId' | 'harnessSlug' | 'authorizationScope' | 'actor' | 'verifiedAgent' | 'origin'>
  & { provider: NativeProvider; sessionId: string; complete: boolean };
/** Feed only a bounded, currently authorized canonical transcript snapshot. Uses
 * the maintained provider parsers; the OMP wire carries result IDs on message. */
export function nativeTranscriptSources(lines: readonly string[], context: NativeTranscriptContext): SearchSource[] {
  if (!context.sessionId || lines.length > 4000 || lines.some(l => l.length > 256_000)) throw new Error('invalid_native_transcript');
  const reader = createNativeTranscriptReader(context);
  lines.forEach(line => reader.push(line));
  return reader.sources();
}

/** Stateful provider parsing across IO chunks. Only one bounded record is fed at
 * a time; request/result pairing and source line identities span those chunks. */
export function createNativeTranscriptReader(context: NativeTranscriptContext) {
  if (!context.sessionId) throw new Error('invalid_native_transcript');
  const parser = context.provider === 'codex' ? createCodexTimelineParser()
    : context.provider === 'omp' ? createOmpTimelineParser() : createAgentTimelineParser();
  const calls: SearchSource[] = [], results = new Map<string, NonNullable<SearchSource['result']>[]>();
  let index = 0, retainedBytes = 0;
  return { push(line: string) {
    if (line.length > 256_000) throw new Error('invalid_native_transcript');
    const lineIndex = index++;
    let wire: Obj;
    try { wire = object(JSON.parse(line)); } catch { return; }
    const message = object(wire.message);
    const entries = parser.parseLine(line);
    if (entries.some(entry => entry.kind === 'tool_use' || entry.kind === 'tool_result')) {
      retainedBytes += Buffer.byteLength(line);
      if (retainedBytes > 32 * 1024 * 1024) throw new Error('invalid_native_transcript');
    }
    for (const entry of entries) {
      const id = entry.toolId || (entry.kind === 'tool_result' ? text(message.toolCallId) : '');
      if (entry.kind === 'tool_use' && calls.length >= 2000) throw new Error('invalid_native_transcript');
      if (entry.kind === 'tool_use') calls.push({ ...context, namespace: context.sessionId,
        at: entry.ts ?? '', copyRef: `transcript:${context.provider}:${context.sessionId}:${lineIndex}`,
        tool: entry.toolName ?? '', args: entry.toolInput, callId: id || null, identityAuthority: id ? 'provider' : 'unknown',
        result: null, sourceComplete: context.complete });
      if (entry.kind === 'tool_result' && id) {
        let body: unknown = {};
        try { body = JSON.parse(entry.text ?? ''); } catch { /* Text alone cannot prove settled outcome. */ }
        const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
        const failed = message.isError === true || blocks.some(b => b.tool_use_id === id && b.is_error === true);
        const list = results.get(id) ?? [];
        list.push({ callId: id, provider: context.provider, namespace: context.sessionId,
          complete: context.complete, status: failed ? 'error' : 'ok', body }); results.set(id, list);
      }
    }
  }, retainedBytes: () => retainedBytes, sources(): SearchSource[] {
    return calls.map(call => {
      const matches = results.get(call.callId ?? '') ?? [];
      // Replayed identical results are fine; incompatible same-ID results are not.
      return { ...call, result: matches.length && new Set(matches.map(stable)).size === 1 ? matches[0]! : null };
    });
  } };
}

export interface NativeCoverage { provider: NativeProvider; kind: NativeKind; source: 'activity' | 'transcript'; status: NativeCoverageStatus }
export type NativeCorpusOptions = Omit<SearchCorpusOptions, 'readOutput'> & {
  /** Authorized canonical reader, called only after the activity source ACL. The
   * caller must also check every transcript source's current authority. */
  readTranscript?: (identity: { id: string; provider: NativeProvider; sessionId: string; actor: string; callId: string | null }) => Promise<{
    sources: SearchSource[]; status: NativeCoverageStatus;
  } | null>;
};
export async function fetchNativeOperations(opts: NativeCorpusOptions) {
  miningScopeId(opts.scope, opts.harnessSlug);
  const since = Date.parse(opts.since), until = Date.parse(opts.until);
  if (opts.workspaceId !== opts.scope.workspaceId || !Number.isFinite(since) || !Number.isFinite(until)
    || until <= since || until - since > 30 * 86400_000
    || opts.after && (!Number.isFinite(Date.parse(opts.after.at)) || !/^\d+$/.test(opts.after.id))) throw new Error('invalid_native_window');
  if (!await boundedStage(() => opts.authorize({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
    sourceBoundary: opts.scope.sourceBoundary }), 1000)) throw new Error('native_source_denied');
  const sql = opts.client ?? getOrgPg().sql;
  const limit = opts.limit === undefined || !Number.isFinite(opts.limit) ? 250 : Math.max(1, Math.min(2000, Math.floor(opts.limit)));
  const after = opts.after ? sql`AND (created_at,id) > (${opts.after.at}::timestamptz,${opts.after.id}::bigint)` : sql``;
  const rows = await sql<{ id: string; at: string }[]>`SELECT id::text,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM harness_shared.agent_activity WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}
    AND kind='tool' AND created_at >= ${opts.since}::timestamptz AND created_at < ${opts.until}::timestamptz
    ${after} ORDER BY created_at,agent_activity.id LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit), allowed: string[] = [];
  for (let i = 0; i < page.length; i += 16) await Promise.all(page.slice(i, i + 16).map(async row => {
    try { if ((await boundedStage(() => opts.authorizeSource(row.id), 1000))?.sourceBoundary === opts.scope.sourceBoundary) allowed.push(row.id); }
    catch { /* Fail closed before selecting private detail. */ }
  }));
  const records = allowed.length ? await sql<{ id: string; owner_id: string; agent: string; session_id: string;
    tool_use_id: string | null; tool_name: string; detail: unknown; verified: boolean }[]>`
    SELECT id::text,owner_id,agent,session_id,tool_use_id,tool_name,detail,
    harness_shared.is_agent_coord_owner_id(owner_id) AS verified FROM harness_shared.agent_activity
    WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug} AND id=ANY(${allowed}::bigint[])` : [];
  const byId = new Map(records.map(r => [r.id, r])), observations: NativeObservation[] = [];
  let incomplete = allowed.length - records.length;
  const coverage: NativeCoverage[] = NATIVE_PROVIDERS.flatMap(provider => (['shell', 'browser'] as const).flatMap(kind =>
    (['activity', 'transcript'] as const).map(source => ({ provider, kind, source, status: 'missing' as NativeCoverageStatus }))));
  const mark = (provider: NativeProvider, source: NativeCoverage['source'], kind: NativeKind | null, status: NativeCoverageStatus) => {
    for (const cell of coverage) if (cell.provider === provider && cell.source === source && (!kind || cell.kind === kind)) {
      if (status === 'truncated' || cell.status !== 'truncated' && (status === 'measured' || cell.status !== 'measured')) cell.status = status;
    }
  };
  for (const row of page) {
    const record = byId.get(row.id);
    if (!record?.verified || !providers.has(record.agent) || !record.session_id) continue;
    const provider = record.agent as NativeProvider;
    const detail = object(record.detail);
    // The canonical bridge collapses whitespace for its shell summaries even
    // below the string cap. Quoted spaces/newline operators cannot be recovered
    // from that detail; require faithful transcript input for these tool names.
    // Probe the maintained normalizer instead of duplicating its evolving list.
    const bridgeCollapsesShell = summariseActivity({ toolName: record.tool_name,
      toolInput: { command: 'first\nsecond' } }).detail?.command === 'first second';
    const complete = !bridgeCollapsesShell && !Object.values(detail).some(v => typeof v === 'string' && (v.endsWith('…') || v === '[object]' || /^\[\d+ items\]$/.test(v)));
    const source: SearchSource = { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, authorizationScope: opts.scope.sourceBoundary,
      actor: record.owner_id, verifiedAgent: record.verified, origin: 'agent', provider, namespace: record.session_id,
      at: row.at, copyRef: `agent-activity:${row.id}`, tool: record.tool_name, args: detail,
      callId: record.tool_use_id, identityAuthority: record.tool_use_id ? 'provider' : 'unknown', sourceComplete: complete, result: null };
    const observed = observeNativeOperation(source, opts.scope);
    const kindHint: NativeKind | null = shellTools.has(record.tool_name.toLowerCase()) ? 'shell'
      : browserTools.has(record.tool_name.toLowerCase()) ? 'browser' : null;
    if (observed) { observations.push(observed); mark(provider, 'activity', observed.kind ?? kindHint, !complete ? 'truncated' : observed.kind ? 'measured' : 'unsupported'); }
    let completeCopy = !!observed && observed.evidenceGaps.length === 0;
    if (!opts.readTranscript) { if (kindHint && !completeCopy) incomplete++; continue; }
    try {
      const hydrated = await boundedStage(() => opts.readTranscript!({ id: row.id, provider, sessionId: record.session_id,
        actor: record.owner_id, callId: record.tool_use_id }), 1000);
      if (!hydrated) { if (kindHint && !completeCopy) incomplete++; continue; }
      // Reader metadata cannot override identity, authority boundary or request ID.
      for (const transcript of hydrated.sources) {
        if (transcript.workspaceId !== opts.workspaceId || transcript.harnessSlug !== opts.harnessSlug
          || transcript.authorizationScope !== opts.scope.sourceBoundary || transcript.provider !== provider
          || transcript.namespace !== record.session_id || transcript.actor !== record.owner_id
          || !record.tool_use_id || transcript.callId !== record.tool_use_id) continue;
        const value = observeNativeOperation(transcript, opts.scope);
        if (value) { observations.push(value);
          completeCopy ||= hydrated.status === 'measured' && value.evidenceGaps.length === 0;
          mark(provider, 'transcript', value.kind,
          hydrated.status === 'measured' && !transcript.sourceComplete ? 'truncated' : hydrated.status); }
      }
      if (!hydrated.sources.length) mark(provider, 'transcript', observed?.kind ?? kindHint, hydrated.status);
    } catch { /* Source/result unavailable: UNKNOWN; source recording is independent. */ }
    if (kindHint && !completeCopy) incomplete++;
  }
  // Pagination limits the window, not the physical completeness of a provider
  // record. Keep those distinct so a fully drained census can compose pages.
  return { observations, next: rows.length > limit ? page.at(-1)! : null,
    coverage: { scanned: page.length, denied: page.length - allowed.length, incomplete,
      pageLimited: rows.length > limit || !!opts.after, matrix: coverage, complete: false as const } };
}
