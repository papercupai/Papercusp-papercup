/** Five-family pass on the existing SQL census cadence; only minimized diagnostics are persisted. */
import { createHmac, randomUUID } from 'node:crypto';
import { monitoredCensusRunId, monitoredRuntimeId } from '../harness/routines/fire-provenance';
import { getOrgPg } from '@papercusp/db-org';
import { getBuildInfo } from '../build-info';
import type { SqlMiningOptions, SqlMiningResult } from '../bash-substitution/sql-tool-candidates';
import type { SqlCorpusCursor, SqlDemandAggregate, SqlDemandObservation } from '../bash-substitution/sql-intent-corpus';
import type { SqlIntentScope } from '../bash-substitution/sql-intent-fingerprint';
import { rankSqlToolCandidates } from '../sql-tool-candidate-score';
import { AGGREGATE_LIFETIME_DAYS, miningScopeId, sourcesCurrentlyReadable } from './privacy';
import { boundedStage, miningFailureReason, MONITORED_FAMILIES, type MonitoredFamily } from './pipeline';
import { productionOpportunityReaders } from './source-readers';
import { fetchSearchReformulations, groupSearchReformulations } from './search-reformulation';
import { fetchResultRecovery, rankResultRecovery } from './result-recovery';
import { fetchWorkaroundFunnels, rankWorkarounds } from './workaround-funnel';
import { fetchNativeOperations, groupNativeOperations, NATIVE_PROVIDERS, type NativeCoverage } from './native-operation';

export interface FamilyMeasurement {
  family: MonitoredFamily; coverage: 'measured' | 'missing' | 'unsupported' | 'truncated' | 'UNKNOWN';
  scanned: number; qualifying: number; diagnostics: Record<string, unknown>;
}
/** No examples, actor IDs, paths, request text or transcript locations in 120-day rows.
 * These are internal evidence pointers, not an independent grant to read a source.
 */
interface CandidateEvidence {
  id: string; sourceRefs: string[]; operationRefs: string[];
  metrics: Record<string, number>; reviewEligible: boolean;
}
const nativeProvidersMeasured = (matrix?: readonly { provider: string; kind: string; source: string; status: string }[]) => NATIVE_PROVIDERS.every(provider =>
  (['shell', 'browser'] as const).every(kind => matrix?.some(c =>
    c.provider === provider && c.kind === kind && c.source === 'transcript' && c.status === 'measured')));
const candidateMetricKeys: Record<MonitoredFamily, readonly string[]> = {
  sql: ['successful', 'error', 'refused', 'unknown', 'verifiedAgents', 'activeDays'],
  'search-reformulation': ['logicalDemand', 'reformulations', 'fallbacks'],
  'result-recovery': ['exposure', 'recoveryEpisodes', 'extraCalls', 'successful'],
  'workaround-funnel': ['successfulEpisodes', 'extraCalls', 'elapsedMs'],
  'native-operation': ['logicalDemand', 'successful', 'unknown'],
};
export interface MonitoredCandidateReadOptions extends SqlMiningOptions {
  runId: string; family: MonitoredFamily; candidateId: string;
  /** Resolve the keyed copy against CURRENT canonical source existence and authority.
   * A token is a pointer, never a grant. Missing/unresolvable copies must return false.
   * The resolver must also authorize transcript copies, not just their activity index.
   */
  authorizeSource?: (sourceToken: string, family: MonitoredFamily) => Promise<boolean>;
  /** Batch equivalent for production reconstruction; called afresh on both ACL passes. */
  authorizeCandidate?: (candidate: CandidateEvidence, context: {
    sourceRevisions?: unknown; window?: unknown;
  }) => Promise<boolean>;
}
/** Internal evidence lookup for review preparation. Never release family diagnostics,
 * scanned/denied counts or an unfiltered candidate list. No authorization is cached.
 * A production route must supply its canonical source resolver before exposing this.
 */
export async function readMonitoredCandidate(opts: MonitoredCandidateReadOptions): Promise<CandidateEvidence | null> {
  if (opts.workspaceId !== opts.scope.workspaceId || !MONITORED_FAMILIES.includes(opts.family)
    || !/^[a-f0-9]{64}$/.test(opts.candidateId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(opts.runId)) return null;
  const sql = opts.client ?? getOrgPg().sql, scopeId = miningScopeId(opts.scope, opts.harnessSlug);
  const scopeAllowed = () => opts.authorize({ workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug, sourceBoundary: opts.scope.sourceBoundary });
  const budget = positive(opts.timeBudgetMs, 5000, 30_000);
  try {
    return await boundedStage(async () => {
      if (!await scopeAllowed()) return null;
      const load = () => sql<{ diagnostics: { candidates?: CandidateEvidence[]; sourceRevisions?: unknown; window?: unknown } }[]>`
        SELECT f.diagnostics FROM harness_shared.sql_intent_family_runs f
        JOIN harness_shared.sql_intent_runs r USING (workspace_id,run_id)
        WHERE r.workspace_id=${opts.workspaceId} AND r.scope_id=${scopeId} AND r.harness_slug=${opts.harnessSlug}
          AND r.run_id=${opts.runId}::uuid AND f.family=${opts.family} AND r.finished_at IS NOT NULL
          AND r.started_at > ${new Date((opts.now ?? Date.now()) - AGGREGATE_LIFETIME_DAYS * 86400_000).toISOString()}::timestamptz`;
      const [row] = await load();
      if (!row || !Array.isArray(row.diagnostics.candidates)) return null;
      const matches = row.diagnostics.candidates.filter(c => c.id === opts.candidateId);
      if (matches.length !== 1) return null;
      const candidate = matches[0]!;
      if (!Array.isArray(candidate.sourceRefs) || !candidate.sourceRefs.length
        || !Array.isArray(candidate.operationRefs)
        || [...candidate.sourceRefs, ...candidate.operationRefs].some(t => typeof t !== 'string' || !/^[a-f0-9]{64}$/.test(t))
        || !candidate.metrics || typeof candidate.metrics !== 'object' || Array.isArray(candidate.metrics)
        || Object.values(candidate.metrics).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        || typeof candidate.reviewEligible !== 'boolean'
        || candidateMetricKeys[opts.family].some(key => typeof candidate.metrics[key] !== 'number')) return null;
      const allowed = () => opts.authorizeCandidate
        ? opts.authorizeCandidate(candidate, row.diagnostics)
        : opts.authorizeSource
          ? sourcesCurrentlyReadable(candidate.sourceRefs, token => opts.authorizeSource!(token, opts.family))
          : Promise.resolve(false);
      if (!await allowed()) return null;
      // DB and ACL lookups await IO. A later family replacement must not release
      // an older packet; revoke/delete during hydration denies the whole aggregate.
      const [current] = await load();
      if (!current || JSON.stringify(current.diagnostics) !== JSON.stringify(row.diagnostics)
        || !await allowed() || !await scopeAllowed()) return null;
      // Allowlist again on read so old/corrupt rows cannot smuggle private fields.
      return { id: candidate.id, sourceRefs: [...candidate.sourceRefs], operationRefs: [...candidate.operationRefs],
        metrics: Object.fromEntries(candidateMetricKeys[opts.family].map(key => [key, candidate.metrics[key]!])),
        reviewEligible: candidate.reviewEligible };
    }, budget);
  } catch { return null; }
}
/** Hash only the adapters' minimized observations, never raw source fields or secrets.
 * Conflicting copies of a token cannot acquire a stable revision by last-write-wins.
 */
function observationRevisions(scope: SqlIntentScope, rows: readonly { sourceToken: string }[]) {
  const revisions: Record<string, string> = {}, conflicts = new Set<string>();
  for (const row of rows) {
    const revision = createHmac('sha256', scope.key).update(JSON.stringify([
      'monitored-source-revision-v1', scope.workspaceId, scope.sourceBoundary, scope.epoch, row,
    ])).digest('hex');
    if (revisions[row.sourceToken] && revisions[row.sourceToken] !== revision) conflicts.add(row.sourceToken);
    revisions[row.sourceToken] = revision;
  }
  for (const token of conflicts) delete revisions[token];
  return revisions;
}

/** Production activity evidence uses the same canonical readers as the census.
 * Reconstruct the bounded original window on EACH authorization pass, including
 * transcript copies. No token-to-source grant or source content is cached/stored.
 * SQL keeps its existing readSqlCandidates/history revision rail.
 */
export async function readProductionMonitoredCandidate(
  opts: Omit<MonitoredCandidateReadOptions, 'authorizeSource' | 'authorizeCandidate' | 'family'> & {
    family: Exclude<MonitoredFamily, 'sql'>;
  }, deps: Parameters<typeof productionOpportunityReaders>[1] = {},
): Promise<CandidateEvidence | null> {
  const readers = productionOpportunityReaders({ ...opts, sourceBoundary: opts.scope.sourceBoundary }, deps);
  const deadline = Date.now() + positive(opts.timeBudgetMs, 5000, 30_000);
  let cancelled = false;
  try {
    return await readMonitoredCandidate({ ...opts, authorizeCandidate: async (candidate, context) => {
      if (cancelled || Date.now() >= deadline) return false;
      const window = context.window as { since?: string; until?: string } | null;
      const revisions = context.sourceRevisions as Record<string, unknown> | null;
      if (!window || typeof window.since !== 'string' || typeof window.until !== 'string'
        || !Number.isFinite(Date.parse(window.since)) || !Number.isFinite(Date.parse(window.until))
        || Date.parse(window.until) - Date.parse(window.since) !== 7 * 86400_000
        || !revisions || typeof revisions !== 'object' || Array.isArray(revisions)
        || candidate.sourceRefs.some(token => typeof revisions[token] !== 'string' || !/^[a-f0-9]{64}$/.test(revisions[token] as string))) return false;
      if (candidate.reviewEligible && await readers.readContinuity({ family: opts.family,
        since: window.since, until: window.until }) !== 'complete') return false;
      const common = { ...opts, since: window.since, until: window.until,
        authorizeSource: readers.authorizeLedgerSource, readOutput: readers.readOutput };
      const pageSize = positive(opts.rowBudget, 250, 2000), rowCap = positive(opts.windowRowBudget, 20_000, 100_000);
      const drain = <T, C extends { scanned: number; denied: number }>(fetch: (page: { after?: SqlCorpusCursor; limit: number }) =>
        Promise<{ observations: T[]; next: SqlCorpusCursor | null; coverage: C }>) =>
        drainWindow(fetch, pageSize, rowCap, deadline, () => cancelled);
      const page = opts.family === 'search-reformulation'
        ? await drain(p => fetchSearchReformulations({ ...common, ...p }))
        : opts.family === 'result-recovery' ? await drain(p => fetchResultRecovery({ ...common, ...p }))
          : opts.family === 'workaround-funnel' ? await drain(p => fetchWorkaroundFunnels({ ...common, ...p }))
            : opts.family === 'native-operation' ? await drain(p => fetchNativeOperations({ ...common, ...p,
              authorizeSource: readers.authorizeActivitySource, readTranscript: readers.readTranscript })) : null;
      if (!page || page.next || page.coverage.denied) return false;
      if (candidate.reviewEligible && (page.coverage.incomplete !== 0 || opts.family === 'native-operation'
        && !nativeProvidersMeasured('matrix' in page.coverage ? page.coverage.matrix : undefined))) return false;
      const current = observationRevisions(opts.scope, page.observations);
      return candidate.sourceRefs.every(token => current[token] !== undefined && current[token] === revisions[token]);
    } });
  } finally { cancelled = true; }
}
function identityIndex(rows: readonly { sourceToken: string; operationToken: string | null }[]) {
  const bySource = new Map<string, Set<string>>(), byOperation = new Map<string, Set<string>>();
  for (const row of rows) if (row.operationToken) {
    const operations = bySource.get(row.sourceToken) ?? new Set<string>();
    operations.add(row.operationToken); bySource.set(row.sourceToken, operations);
    const sources = byOperation.get(row.operationToken) ?? new Set<string>();
    sources.add(row.sourceToken); byOperation.set(row.operationToken, sources);
  }
  return (refs: string[]) => {
    const sources = new Set(refs), operations = new Set(refs.flatMap(r => [...bySource.get(r) ?? []]));
    // Include every contributing copy: deduplication cannot discard its authority.
    for (const op of operations) for (const source of byOperation.get(op) ?? []) sources.add(source);
    return { sourceRefs: [...sources].sort(), operationRefs: [...operations].sort() };
  };
}
const runtimeId = monitoredRuntimeId;
const positive = (value: number | undefined, fallback: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value!))) : fallback;

/** Drain one fixed window before grouping: page boundaries are not episode boundaries.
 * Exhausting the ledger window does not establish retention or provider completeness.
 * Check cancellation between pages so a timed-out family cannot keep scanning in the background.
 */
async function drainWindow<T, C extends { scanned: number; denied: number; incomplete?: number }>(
  fetch: (page: { after?: SqlCorpusCursor; limit: number }) => Promise<{
    observations: T[]; next: SqlCorpusCursor | null; coverage: C;
  }>, pageSize: number, rowCap: number, deadline: number, cancelled: () => boolean,
) {
  const observations: T[] = [], visited = new Set<string>();
  let after: SqlCorpusCursor | undefined, scanned = 0, denied = 0, incomplete = 0, pages = 0;
  let lastCoverage: C;
  // Native cells carry the conservative strongest observed status across pages;
  // a later empty page must not erase evidence or a truncation from an earlier page.
  const matrix = new Map<string, { provider: string; kind: string; source: string; status: string }>();
  const severity: Record<string, number> = { missing: 0, unsupported: 1, measured: 2, truncated: 3 };
  for (;;) {
    if (cancelled() || Date.now() >= deadline) throw new Error('sql_mining_time_budget');
    const limit = Math.min(pageSize, rowCap - scanned);
    const page = await fetch({ after, limit });
    if (cancelled() || Date.now() >= deadline) throw new Error('sql_mining_time_budget');
    if (!Number.isSafeInteger(page.coverage.scanned) || page.coverage.scanned < 0 || page.coverage.scanned > limit
      || !Number.isSafeInteger(page.coverage.denied) || page.coverage.denied < 0
      || page.coverage.denied > page.coverage.scanned) throw new Error('sql_mining_window_cap');
    observations.push(...page.observations);
    scanned += page.coverage.scanned; denied += page.coverage.denied; pages++; lastCoverage = page.coverage;
    incomplete += page.coverage.incomplete ?? 0;
    if ('matrix' in page.coverage && Array.isArray(page.coverage.matrix)) {
      for (const cell of page.coverage.matrix) {
        const key = JSON.stringify([cell.provider, cell.kind, cell.source]), prior = matrix.get(key);
        if (!prior || (severity[cell.status] ?? 0) > (severity[prior.status] ?? 0)) matrix.set(key, cell);
      }
    }
    if (page.next) {
      const key = JSON.stringify(page.next);
      if (!page.coverage.scanned || visited.has(key)) throw new Error('sql_mining_window_cap');
      visited.add(key);
    }
    if (!page.next || scanned >= rowCap) return { observations, next: page.next,
      coverage: { ...lastCoverage, ...(matrix.size ? { matrix: [...matrix.values()] } : {}),
        scanned, denied, incomplete, pages, windowExhausted: !page.next,
        stop: page.next ? 'row-cap' as const : 'window-exhausted' as const } };
    after = page.next;
  }
}
export async function runMonitoredCensus(opts: SqlMiningOptions & { routineId?: string; workflowId?: string },
  sqlStage: () => Promise<SqlMiningResult>, deps: Parameters<typeof productionOpportunityReaders>[1] = {}) {
  const sql = opts.client ?? getOrgPg().sql, scopeId = miningScopeId(opts.scope, opts.harnessSlug);
  if (opts.workspaceId !== opts.scope.workspaceId) throw new Error('invalid_sql_mining_scope');
  const runId = opts.workflowId ? monitoredCensusRunId(opts.workspaceId, opts.workflowId) : randomUUID();
  const started = new Date().toISOString(), now = opts.now ?? Date.now();
  const readers = productionOpportunityReaders({ ...opts, sourceBoundary: opts.scope.sourceBoundary }, deps);
  const common = { ...opts, since: new Date(now - 7 * 86400_000).toISOString(), until: new Date(now).toISOString(),
    authorizeSource: readers.authorizeLedgerSource,
    readOutput: readers.readOutput };
  const candidate = (family: MonitoredFamily, identity: unknown, refs: { sourceRefs: string[]; operationRefs: string[] },
    metrics: Record<string, number>, reviewEligible = false): CandidateEvidence => {
    if (!refs.sourceRefs.length || [...refs.sourceRefs, ...refs.operationRefs].some(t => !/^[a-f0-9]{64}$/.test(t))
      || Object.values(metrics).some(n => !Number.isFinite(n) || n < 0)) throw new Error('sql_mining_source_missing');
    return { id: createHmac('sha256', opts.scope.key)
      .update(JSON.stringify(['monitored-candidate-v1', scopeId, family, identity])).digest('hex'),
    ...refs, metrics, reviewEligible };
  };
  await sql`INSERT INTO harness_shared.sql_intent_runs
    (workspace_id,run_id,scope_id,harness_slug,routine_id,workflow_id,source_sha,runtime_id,started_at)
    VALUES (${opts.workspaceId},${runId}::uuid,${scopeId},${opts.harnessSlug},${opts.routineId ?? null},
      ${opts.workflowId ?? null},${getBuildInfo().sha},${runtimeId},${started}::timestamptz)
    ON CONFLICT (workspace_id,run_id) DO NOTHING`;
  const [identity] = await sql`SELECT source_sha,runtime_id,scope_id,harness_slug,finished_at
    FROM harness_shared.sql_intent_runs WHERE workspace_id=${opts.workspaceId} AND run_id=${runId}::uuid`;
  if (!identity || identity.runtime_id !== runtimeId || identity.source_sha !== getBuildInfo().sha
    || identity.scope_id !== scopeId || identity.harness_slug !== opts.harnessSlug || identity.finished_at)
    throw new Error('sql_mining_run_identity_or_replay');
  const budget = positive(opts.timeBudgetMs, 5000, 30_000);
  const pageSize = positive(opts.rowBudget, 250, 2000), rowCap = positive(opts.windowRowBudget, 20_000, 100_000);
  const measure = async (family: MonitoredFamily, work: (deadline: number, cancelled: () => boolean) => Promise<FamilyMeasurement>): Promise<FamilyMeasurement> => {
    let cancelled = false;
    try { return await boundedStage(async () => {
      const deadline = Date.now() + budget;
      const continuity = () => readers.readContinuity({ family: family as Exclude<MonitoredFamily, 'sql'>,
        since: common.since, until: common.until });
      const before = family === 'sql' ? null : await continuity();
      const row = await work(deadline, () => cancelled);
      if (family === 'sql') return row;
      const after = await continuity();
      const source = row.diagnostics.sourceCoverage as { denied: number; incomplete: number; windowExhausted: boolean; matrix?: NativeCoverage[] };
      const complete = before === 'complete' && after === 'complete' && source.windowExhausted
        && source.denied === 0 && source.incomplete === 0 && row.diagnostics.collisions === 0
        && (family !== 'native-operation' || nativeProvidersMeasured(source.matrix));
      row.coverage = row.coverage === 'truncated' ? 'truncated' : complete ? 'measured' : 'UNKNOWN';
      row.diagnostics.continuity = { before, after };
      row.diagnostics.reviewEligible = complete;
      for (const candidate of row.diagnostics.candidates as CandidateEvidence[]) {
        candidate.reviewEligible = complete && (family !== 'native-operation' || candidate.metrics.unknown === 0);
      }
      return row;
    }, budget); }
    catch (error) { return { family, coverage: 'UNKNOWN', scanned: 0, qualifying: 0,
      diagnostics: { stage: 'source', reason: miningFailureReason(error), reviewEligible: false, candidates: [] } }; }
    finally { cancelled = true; }
  };
  const families = await Promise.all([
    measure('sql', async () => {
      const result = await sqlStage();
      if (result.status !== 'ok') return { family: 'sql', coverage: 'UNKNOWN', scanned: result.rows, qualifying: 0,
        diagnostics: { stage: result.stage, reason: result.reason ?? 'unknown', reviewEligible: false, candidates: [] } };
      const [row] = await sql<{ summary: SqlDemandAggregate; source_tokens: string[]; revision_token: string }[]>`
        SELECT summary,source_tokens,revision_token FROM harness_shared.sql_intent_history
        WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId} AND ran_on=${new Date(now).toISOString().slice(0,10)}::date`;
      const coverage = result.more ? 'truncated' : row?.summary.coverage.status === 'complete' ? 'measured' : 'UNKNOWN';
      const sources = row ? await sql<{ observation: SqlDemandObservation }[]>`SELECT observation
        FROM harness_shared.sql_intent_operations WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId}
        AND source_token=ANY(${row.source_tokens}::text[])` : [];
      if (row) {
        const [current] = await sql`SELECT 1 FROM harness_shared.sql_intent_history
          WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId}
          AND ran_on=${new Date(now).toISOString().slice(0,10)}::date AND revision_token=${row.revision_token}`;
        if (!current || sources.length !== row.source_tokens.length) throw new Error('sql_mining_source_missing');
      }
      const observationsByCandidate = new Map<string, SqlDemandObservation[]>();
      for (const { observation: o } of sources) if (o.intent.status === 'supported') {
        const key = JSON.stringify([o.workspaceToken, o.harnessToken, o.boundaryToken, o.intent.version, o.intent.fingerprint]);
        const rows = observationsByCandidate.get(key) ?? []; rows.push(o); observationsByCandidate.set(key, rows);
      }
      const identities = identityIndex(sources.map(s => s.observation));
      const ranked = row ? rankSqlToolCandidates(row.summary).candidates : [];
      const candidates = ranked.map(c => {
        const observations = observationsByCandidate.get(c.id) ?? [];
        return candidate('sql', c.id, identities(observations.map(o => o.sourceToken)),
          { successful: c.counts.ok, error: c.counts.error, refused: c.counts.refused, unknown: c.counts.unknown,
            verifiedAgents: c.verifiedAgents, activeDays: c.activeDays.length }, c.eligible && coverage === 'measured');
      });
      return { family: 'sql', coverage, scanned: result.rows,
        qualifying: ranked.filter(c => c.eligible).length,
        diagnostics: { stage: result.stage, logicalCalls: result.logicalCalls ?? null, reviewEligible: coverage === 'measured',
          candidates, sourceRevision: row?.revision_token ?? null } };
    }),
    measure('search-reformulation', async (deadline, cancelled) => {
      const page = await drainWindow(p => fetchSearchReformulations({ ...common, ...p }), pageSize, rowCap, deadline, cancelled);
      const grouped = groupSearchReformulations(page.observations);
      const identities = identityIndex(page.observations);
      const chains = grouped.chains.filter(c => c.reformulations > 0 || c.fallbacks > 0);
      return { family: 'search-reformulation', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: chains.length,
        diagnostics: { sourceCoverage: page.coverage, sourceRevisions: observationRevisions(opts.scope, page.observations),
          collisions: grouped.collisions, reviewEligible: false,
          candidates: chains.map(c => candidate('search-reformulation', [c.scopeToken, c.id],
            identities(c.operations.map(o => o.sourceToken)),
            { logicalDemand: c.operations.length, reformulations: c.reformulations, fallbacks: c.fallbacks })) } };
    }),
    measure('result-recovery', async (deadline, cancelled) => {
      const page = await drainWindow(p => fetchResultRecovery({ ...common, ...p }), pageSize, rowCap, deadline, cancelled);
      const grouped = rankResultRecovery(page.observations);
      const identities = identityIndex(page.observations);
      const exposureSources = new Map<string, string[]>();
      for (const o of grouped.operations) {
        const key = JSON.stringify([o.scopeToken, o.tool]), sources = exposureSources.get(key) ?? [];
        sources.push(o.sourceToken); exposureSources.set(key, sources);
      }
      return { family: 'result-recovery', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.rankings.length, diagnostics: { sourceCoverage: page.coverage,
          sourceRevisions: observationRevisions(opts.scope, page.observations),
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false,
          candidates: grouped.rankings.map(c => candidate('result-recovery', [c.scopeToken, c.tool],
            identities([...(exposureSources.get(JSON.stringify([c.scopeToken, c.tool])) ?? []),
              ...c.episodes.flatMap(e => e.sourceRefs)]),
            { exposure: c.exposure, recoveryEpisodes: c.recoveryEpisodes, extraCalls: c.extraCalls, successful: c.successEpisodes })) } };
    }),
    measure('workaround-funnel', async (deadline, cancelled) => {
      const page = await drainWindow(p => fetchWorkaroundFunnels({ ...common, ...p }), pageSize, rowCap, deadline, cancelled);
      const grouped = rankWorkarounds(page.observations);
      const identities = identityIndex(page.observations);
      return { family: 'workaround-funnel', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.rankings.length, diagnostics: { sourceCoverage: page.coverage,
          sourceRevisions: observationRevisions(opts.scope, page.observations),
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false,
          candidates: grouped.rankings.map(c => candidate('workaround-funnel', [c.scopeToken, c.tool, c.repair],
            identities(c.episodes.flatMap(e => e.operations.map(o => o.sourceToken))),
            { successfulEpisodes: c.successfulEpisodes, extraCalls: c.extraCalls, elapsedMs: c.elapsedMs })) } };
    }),
    measure('native-operation', async (deadline, cancelled) => {
      const page = await drainWindow(p => fetchNativeOperations({ ...common, ...p, authorizeSource: readers.authorizeActivitySource,
        readTranscript: readers.readTranscript }), pageSize, rowCap, deadline, cancelled);
      const grouped = groupNativeOperations(page.observations);
      return { family: 'native-operation', coverage: page.next ? 'truncated' : 'UNKNOWN', scanned: page.coverage.scanned,
        qualifying: grouped.chains.length, diagnostics: { sourceCoverage: page.coverage,
          sourceRevisions: observationRevisions(opts.scope, page.observations),
          collisions: grouped.collisions, evidenceGaps: grouped.evidenceGaps, reviewEligible: false,
          candidates: grouped.chains.map(c => candidate('native-operation', [c.scopeToken, c.kind, c.id],
            { sourceRefs: c.sourceRefs, operationRefs: [...new Set(c.operationRefs)].sort() },
            { logicalDemand: c.logicalDemand, successful: c.successCount, unknown: c.unknownCount })) } };
    }),
  ]);
  await sql.begin(async tx => {
    for (const row of families) await tx`INSERT INTO harness_shared.sql_intent_family_runs
      (workspace_id,run_id,family,coverage,scanned,qualifying,diagnostics)
      VALUES (${opts.workspaceId},${runId}::uuid,${row.family},${row.coverage},${row.scanned},${row.qualifying},
        ${JSON.stringify({ ...row.diagnostics, window: { since: common.since, until: common.until } })}::jsonb)
      ON CONFLICT (workspace_id,run_id,family) DO UPDATE SET coverage=EXCLUDED.coverage,
        scanned=EXCLUDED.scanned,qualifying=EXCLUDED.qualifying,diagnostics=EXCLUDED.diagnostics`;
    await tx`UPDATE harness_shared.sql_intent_runs SET finished_at=now()
      WHERE workspace_id=${opts.workspaceId} AND run_id=${runId}::uuid`;
    await tx`DELETE FROM harness_shared.sql_intent_runs WHERE workspace_id=${opts.workspaceId}
      AND started_at < now() - ${AGGREGATE_LIFETIME_DAYS} * interval '1 day'`;
  });
  return { runId, families, coverage: { population: [...MONITORED_FAMILIES],
    checked: families.filter(f => f.coverage === 'measured').map(f => f.family),
    notChecked: families.filter(f => f.coverage !== 'measured').map(f => f.family),
    notApplicable: [], residue: families.filter(f => f.coverage !== 'measured').map(f => `${f.family}:${f.coverage}`) } };
}
