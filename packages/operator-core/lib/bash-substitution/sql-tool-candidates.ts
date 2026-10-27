/** P004: cursor, deduplicated operations and replacement summaries commit together. Never executes source SQL. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { aggregateSqlDemand, fetchSqlIntentCorpus, type SqlCorpusCursor, type SqlDemandAggregate,
  type SqlDemandObservation, type SqlIntentCorpusOptions } from './sql-intent-corpus';
import type { SqlIntentScope } from './sql-intent-fingerprint';
import { AGGREGATE_LIFETIME_DAYS, EXAMPLE_LIFETIME_MS, EXAMPLE_PURGE_GRACE_MS,
  exampleReadable, miningScopeId, minimizeSqlObservation, sourcesCurrentlyReadable } from '../agent-opportunities/privacy';
import { boundedStage, miningFailureReason, type MiningStage } from '../agent-opportunities/pipeline';
type Client = ReturnType<typeof getOrgPg>['sql'];
export interface SqlMiningOptions {
  workspaceId: string; harnessSlug: string; scope: SqlIntentScope;
  authorize: SqlIntentCorpusOptions['authorize']; client?: Client; now?: number;
  rowBudget?: number; timeBudgetMs?: number; windowRowBudget?: number; retainedFrom?: string;
}
export interface SqlMiningDeps {
  fetch?: typeof fetchSqlIntentCorpus;
  /** Publisher deduplicates this durable request key: outbox delivery can retry after a crash. */
  alert?: (packet: { requestKey: string; workspaceId: string; scopeId: string; ranOn: string }) => Promise<void>;
  beforeCommit?: () => Promise<void>;
}
export interface SqlMiningResult {
  status: 'ok' | 'UNKNOWN'; stage: MiningStage; reason?: string; rows: number;
  cursor?: SqlCorpusCursor | null; more?: boolean; logicalCalls?: number;
}
const positive = (v: number | undefined, fallback: number, max: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(1, Math.floor(v!))) : fallback;

export async function mineSqlCandidateSlice(opts: SqlMiningOptions, deps: SqlMiningDeps = {}): Promise<SqlMiningResult> {
  const scopeId = miningScopeId(opts.scope, opts.harnessSlug);
  if (opts.workspaceId !== opts.scope.workspaceId) throw new Error('invalid_sql_mining_scope');
  const sql = opts.client ?? getOrgPg().sql;
  const now = opts.now ?? Date.now(), ranOn = new Date(now).toISOString().slice(0, 10);
  const budget = positive(opts.timeBudgetMs, 5000, 30_000), deadline = Date.now() + budget;
  const rowBudget = positive(opts.rowBudget, 250, 2000);
  let stage: MiningStage = 'source', cancelled = false;
  const check = () => { if (cancelled || Date.now() >= deadline) throw new Error('sql_mining_time_budget'); };
  try {
    return await boundedStage(async () => {
      const committed = await sql.begin(async tx => {
        await tx`SELECT set_config('statement_timeout', ${String(budget)}, true)`;
        await tx`INSERT INTO harness_shared.sql_intent_progress (workspace_id,scope_id,harness_slug)
          VALUES (${opts.workspaceId},${scopeId},${opts.harnessSlug}) ON CONFLICT DO NOTHING`;
        const [state] = await tx<{ cursor_at: string | null; cursor_id: string | null; pending_until: string | null }[]>`
          SELECT to_char(cursor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
            cursor_id::text, to_char(pending_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS pending_until
          FROM harness_shared.sql_intent_progress WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId} FOR UPDATE`;
        check();
        const until = state?.pending_until ?? new Date(now).toISOString();
        const since = new Date(Date.parse(until) - 7 * 86400_000).toISOString();
        // Only replay the overlap after finishing a prior snapshot; each source row replaces its contribution.
        const after = state?.cursor_at && state.cursor_id ? state.pending_until
          ? { at: state.cursor_at, id: state.cursor_id }
          : { at: new Date(Date.parse(state.cursor_at) - 10 * 60_000).toISOString(), id: '0' } : undefined;
        const page = await boundedStage(() => (deps.fetch ?? fetchSqlIntentCorpus)({ ...opts, since, until, after,
          limit: rowBudget, deadline, client: tx as unknown as Client }), Math.max(1, deadline - Date.now()));
        check();
        if (page.observations.length > rowBudget) throw new Error('sql_mining_window_cap');
        const refs = new Map(page.sources.map(s => [s.token, s.id]));
        for (const row of page.observations) {
          check();
          const sourceId = refs.get(row.sourceToken);
          if (!sourceId || !/^\d+$/.test(sourceId)) throw new Error('sql_mining_source_missing');
          await tx`INSERT INTO harness_shared.sql_intent_operations
            (workspace_id,scope_id,source_token,source_id,day,observation)
            VALUES (${opts.workspaceId},${scopeId},${row.sourceToken},${sourceId}::bigint,${row.day}::date,
              ${JSON.stringify(minimizeSqlObservation(row))}::jsonb)
            ON CONFLICT (workspace_id,scope_id,source_token) DO UPDATE SET observation=EXCLUDED.observation`;
          if (row.intent.status === 'supported') {
            await tx`INSERT INTO harness_shared.sql_intent_examples
              (workspace_id,scope_id,source_token,captured_at,expires_at,example)
              VALUES (${opts.workspaceId},${scopeId},${row.sourceToken},${new Date(now).toISOString()}::timestamptz,
                ${new Date(now + EXAMPLE_LIFETIME_MS).toISOString()}::timestamptz,
                ${JSON.stringify({ canonical: row.intent.canonical, features: row.intent.features })}::jsonb)
              ON CONFLICT DO NOTHING`;
          }
        }
        stage = 'aggregate';
        const cap = positive(opts.windowRowBudget, 20_000, 100_000);
        const observations = await tx<{ observation: SqlDemandObservation; source_id: string; source_token: string }[]>`
          SELECT observation,source_id::text,source_token FROM harness_shared.sql_intent_operations
          WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId} AND day >= ${since}::date
            AND day <= ${until}::date ORDER BY day,source_token LIMIT ${cap + 1}`;
        check();
        if (observations.length > cap) throw new Error('sql_mining_window_cap');
        const coverage = { ...page.coverage, scannedRows: observations.length, cap,
          status: page.next ? 'truncated' as const : page.coverage.retention === 'complete'
            ? 'complete' as const : 'unknown' as const };
        const summary = aggregateSqlDemand(observations.map(r => r.observation), coverage);
        const revision = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
        const sourceIds = observations.map(r => r.source_id), sourceTokens = observations.map(r => r.source_token);
        stage = 'commit';
        await tx`INSERT INTO harness_shared.sql_intent_history
          (workspace_id,scope_id,ran_on,window_since,window_until,summary,source_ids,source_tokens,revision_token)
          VALUES (${opts.workspaceId},${scopeId},${ranOn}::date,${since}::timestamptz,${until}::timestamptz,
            ${JSON.stringify(summary)}::jsonb,${sourceIds}::bigint[],${sourceTokens}::text[],${revision})
          ON CONFLICT (workspace_id,scope_id,ran_on) DO UPDATE SET summary=EXCLUDED.summary,
            source_ids=EXCLUDED.source_ids,source_tokens=EXCLUDED.source_tokens,revision_token=EXCLUDED.revision_token,
            window_since=EXCLUDED.window_since,window_until=EXCLUDED.window_until,computed_at=now()`;
        const cursor = page.last ?? (state?.cursor_at && state.cursor_id ? { at: state.cursor_at, id: state.cursor_id } : null);
        await tx`UPDATE harness_shared.sql_intent_progress SET cursor_at=${cursor?.at ?? null}::timestamptz,
          cursor_id=${cursor?.id ?? null}::bigint,pending_until=${page.next ? until : null}::timestamptz,updated_at=now()
          WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId}`;
        if (deps.beforeCommit) await boundedStage(deps.beforeCommit, Math.max(1, deadline - Date.now()));
        check();
        await tx`INSERT INTO harness_shared.sql_intent_stages (workspace_id,scope_id,stage,status,reason)
          VALUES (${opts.workspaceId},${scopeId},'commit','ok',NULL)
          ON CONFLICT (workspace_id,scope_id,stage) DO UPDATE SET status='ok',reason=NULL,measured_at=now()`;
        check();
        return { status: 'ok' as const, stage: 'commit' as const, rows: page.observations.length,
          cursor, more: !!page.next, logicalCalls: summary.logicalCalls, revision };
      });
      check();
      if (deps.alert && !committed.more && committed.logicalCalls > 0) {
        stage = 'alert';
        const [pending] = await sql`SELECT 1 FROM harness_shared.sql_intent_history
          WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId} AND ran_on=${ranOn}::date
            AND revision_token=${committed.revision} AND alerted_revision IS DISTINCT FROM revision_token`;
        check();
        if (pending) {
          await deps.alert({ requestKey: `sql-intent:${scopeId}:${ranOn}:${committed.revision}`,
            workspaceId: opts.workspaceId, scopeId, ranOn });
          check();
          await sql`UPDATE harness_shared.sql_intent_history SET alerted_revision=revision_token
            WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId} AND ran_on=${ranOn}::date
              AND revision_token=${committed.revision}`;
        }
      }
      return committed;
    }, budget);
  } catch (error) {
    cancelled = true;
    const reason = miningFailureReason(error);
    try {
      await boundedStage(async () => {
        await sql`INSERT INTO harness_shared.sql_intent_stages (workspace_id,scope_id,stage,status,reason)
          VALUES (${opts.workspaceId},${scopeId},${stage},'UNKNOWN',${reason})
          ON CONFLICT (workspace_id,scope_id,stage) DO UPDATE SET status='UNKNOWN',reason=EXCLUDED.reason,measured_at=now()`;
      }, 1000);
    } catch { /* Returned UNKNOWN retains the failure when storage is unavailable too. */ }
    return { status: 'UNKNOWN', stage, reason, rows: 0 };
  }
}

export interface SqlCandidateReadOptions extends SqlMiningOptions {
  /** Mandatory current ACL lookup: cached approval is not sufficient. */
  authorizeSource: (ledgerId: string) => Promise<boolean>;
  ranOn?: string;
}
export interface SqlCandidateSnapshot {
  ranOn: string; summary: SqlDemandAggregate; examples: unknown[];
  /** References are released only after every contributing source passes current authority. */
  sourceIds: string[];
}
export async function readSqlCandidates(opts: SqlCandidateReadOptions): Promise<SqlCandidateSnapshot[]> {
  const sql = opts.client ?? getOrgPg().sql, scopeId = miningScopeId(opts.scope, opts.harnessSlug);
  const scopeReadable = () => opts.authorize({ workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug, sourceBoundary: opts.scope.sourceBoundary });
  const sourceReadable = async (id: string) => {
    const [source] = await sql`SELECT 1 FROM harness_shared.tool_invocations WHERE id=${id}::bigint
      AND workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug}`;
    return !!source && await opts.authorizeSource(id);
  };
  if (opts.scope.workspaceId !== opts.workspaceId || !await scopeReadable()) return [];
  const now = opts.now ?? Date.now();
  const rows = await sql<{ ran_on: string; summary: SqlDemandAggregate; source_ids: string[]; source_tokens: string[] }[]>`
    SELECT ran_on::text,summary,source_ids::text[],source_tokens FROM harness_shared.sql_intent_history
    WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId}
      AND computed_at > ${new Date(now - AGGREGATE_LIFETIME_DAYS * 86400_000).toISOString()}::timestamptz
      AND (${opts.ranOn ?? null}::date IS NULL OR ran_on=${opts.ranOn ?? null}::date)
    ORDER BY ran_on DESC LIMIT 120`;
  const result: SqlCandidateSnapshot[] = [];
  for (const row of rows) {
    if (!await sourcesCurrentlyReadable(row.source_ids, sourceReadable)) continue;
    const examples = await sql<{ example: unknown; expires_at: Date }[]>`SELECT example,expires_at
      FROM harness_shared.sql_intent_examples WHERE workspace_id=${opts.workspaceId} AND scope_id=${scopeId}
        AND source_token=ANY(${row.source_tokens}::text[])
        AND expires_at > ${new Date(now).toISOString()}::timestamptz ORDER BY source_token LIMIT 5`;
    result.push({ ranOn: row.ran_on, summary: row.summary, sourceIds: [...new Set(row.source_ids)],
      examples: examples.filter(e => exampleReadable(e.expires_at, now)).map(e => e.example) });
  }
  // Hydration and later snapshots await IO after the initial grant. Recheck the
  // entire released population so revocation/deletion cannot release stale data.
  if (!await sourcesCurrentlyReadable(result.flatMap(row => row.sourceIds), sourceReadable)
    || !await scopeReadable()) return [];
  return result;
}
/** Same census cadence; the read rail denies expiry even when cleanup fails. */
export async function purgeSqlCandidateData(opts: Pick<SqlMiningOptions, 'workspaceId' | 'client' | 'now'>): Promise<{
  purged: number; breach: boolean;
}> {
  const sql = opts.client ?? getOrgPg().sql, now = opts.now ?? Date.now();
  return await sql.begin(async tx => {
    const [prior] = await tx`SELECT EXISTS(SELECT 1 FROM harness_shared.sql_intent_examples
      WHERE workspace_id=${opts.workspaceId} AND expires_at <= ${new Date(now - EXAMPLE_PURGE_GRACE_MS).toISOString()}::timestamptz) AS breach`;
    await tx`INSERT INTO harness_shared.sql_intent_stages (workspace_id,scope_id,stage,status,reason)
      SELECT DISTINCT workspace_id,scope_id,'purge','UNKNOWN','example-purge-deadline-breached'
      FROM harness_shared.sql_intent_examples WHERE workspace_id=${opts.workspaceId}
        AND expires_at <= ${new Date(now - EXAMPLE_PURGE_GRACE_MS).toISOString()}::timestamptz
      ON CONFLICT (workspace_id,scope_id,stage) DO UPDATE SET status='UNKNOWN',reason=EXCLUDED.reason,measured_at=now()`;
    const deleted = await tx`DELETE FROM harness_shared.sql_intent_examples WHERE workspace_id=${opts.workspaceId}
      AND expires_at <= ${new Date(now).toISOString()}::timestamptz RETURNING 1`;
    await tx`DELETE FROM harness_shared.sql_intent_operations WHERE workspace_id=${opts.workspaceId}
      AND day < ${new Date(now - AGGREGATE_LIFETIME_DAYS * 86400_000).toISOString()}::date`;
    await tx`DELETE FROM harness_shared.sql_intent_history WHERE workspace_id=${opts.workspaceId}
      AND computed_at <= ${new Date(now - AGGREGATE_LIFETIME_DAYS * 86400_000).toISOString()}::timestamptz`;
    return { purged: deleted.length, breach: prior?.breach === true };
  });
}
