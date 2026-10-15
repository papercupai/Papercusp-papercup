/**
 * loadHarnessTokens — Insights → Tokens subtab data source (B-TOK-UI).
 *
 * Plan: token-tracking-plan-and-briefs-2026-06-20 (B-TOK-1). The SIBLING of
 * load-spend.ts: where SpendCard shows ONE headline total, the Tokens dashboard
 * breaks the same cache-inclusive spend DOWN by model, role, and time so the owner
 * can see WHERE the burn is (the 24h audit: opus = 90% of spend, cache-read = 82%
 * of all tokens — invisible until B-TOK-2 fixed the input+output-only ~5× undercount).
 *
 * Reads `harness_shared.agent_usage_samples` (rate-limit-layer-v2 mig 161 + the
 * cross-backend / cache_creation / attribution columns from mig 170/210/330),
 * workspace + harness scoped. CACHE-INCLUSIVE everywhere: every token sum is
 * input + output + cache_read + cache_creation (the same expression load-spend.ts
 * uses), so the dashboard never reproduces the undercount it exists to expose.
 *
 * Per-account attribution is available for rows stamped with
 * agent_usage_samples.account_id; pre-migration/unpinned rows remain grouped as
 * unattributed and hidden from the by-account chart.
 *
 * Pure logic — injectable runQuery (mirrors the per-card loaders). Defensive: a
 * missing table/column yields an explicitly unavailable snapshot, never zero usage.
 */

import type {
  TokensDashboardSnapshot,
  TokenGroupRow,
  TokenTimeBucket,
} from './card-types';
import { z } from 'zod';
import { cloudTelemetryConsentSchema, cloudTelemetryEventSchema, type CloudTelemetryEvent } from '../telemetry-kinds';
import { isHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import type { CloudTelemetryContext } from '../cloud-telemetry';

export interface LoadHarnessTokensOpts {
  /** Request workspace (per-window-workspace-context). Explicit predicate so the
   *  sums never fold in another workspace through the admin handle. */
  workspace_id: string;
  harness_slug: string;
  windowMs?: number;
  /** Export callers bound both ends to the current consent epoch. */
  periodStartMs?: number;
  periodEndMs?: number;
  /** Cap rows per grouped breakdown (model/role). Default 20. */
  groupLimit?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

const num = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The cache-inclusive token sum — the ONE expression every query reuses. */
const TOKENS_EXPR = `COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                     + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)`;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Deterministic UTC 'MMM D' label (no locale dependence in the loader). */
function dayLabel(startMs: number): string {
  const d = new Date(startMs);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

interface TotalsRow {
  runs: string | number | null;
  total_usd: string | number | null;
  estimated_usd: string | number | null;
  reported_usd: string | number | null;
  unpriced_calls: string | number | null;
  unknown_token_calls: string | number | null;
  tokens: string | number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_creation_tokens: string | number | null;
}
interface GroupRow {
  key: string | null;
  tokens: string | number | null;
  cost_usd: string | number | null;
  runs: string | number | null;
}
interface DayRow {
  day_start: string | number | null;
  tokens: string | number | null;
  cost_usd: string | number | null;
}
interface CallRow {
  id: string | number;
  ts: string | number;
  model: string | null;
  cost_source: string | null;
  cost_usd: string | number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_creation_tokens: string | number | null;
}

function emptySnapshot(windowMs: number, accountAttributionAvailable = true): TokensDashboardSnapshot {
  return {
    observation: 'unavailable',
    recentCalls: [],
    windowMs,
    totals: {
      tokens: 0,
      costUsd: 0,
      estimatedUsd: 0,
      reportedUsd: 0,
      unpricedCalls: 0,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    byModel: [],
    byRole: [],
    byAccount: [],
    byDay: [],
    accountAttributionAvailable,
  };
}

export async function loadHarnessTokens(
  opts: LoadHarnessTokensOpts,
): Promise<TokensDashboardSnapshot> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const windowMs = opts.windowMs ?? 7 * DAY_MS;
  const groupLimit = Math.max(1, Math.min(100, opts.groupLimit ?? 20));
  const windowEnd = opts.periodEndMs ?? Date.now();
  const windowStart = opts.periodStartMs ?? windowEnd - windowMs;
  const scope = [workspace_id, harness_slug, windowStart, windowEnd];

  try {
    const [totalsRows, modelRows, roleRows, accountRows, dayRows, callRows] = await Promise.all([
      runQuery<TotalsRow>(
        `SELECT COUNT(*)                                                          AS runs,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_source IN ('provider', 'estimated')), 0) AS total_usd,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_source = 'estimated'), 0) AS estimated_usd,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_source = 'provider'), 0)  AS reported_usd,
                COUNT(*) FILTER (WHERE cost_usd IS NULL OR cost_source IS NULL
                  OR cost_source NOT IN ('provider', 'estimated'))                AS unpriced_calls,
                COUNT(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL
                  OR cache_read_tokens IS NULL OR cache_creation_tokens IS NULL) AS unknown_token_calls,
                COALESCE(SUM(${TOKENS_EXPR}), 0)                                  AS tokens,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0)                       AS input_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0)                      AS output_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0)                  AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0)             AS cache_creation_tokens
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3 AND ts <= $4`,
        scope,
      ),
      runQuery<GroupRow>(
        `SELECT COALESCE(NULLIF(model, ''), model_class, 'unknown') AS key,
                COALESCE(SUM(${TOKENS_EXPR}), 0)                     AS tokens,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_source IN ('provider', 'estimated')), 0) AS cost_usd,
                COUNT(*)                                             AS runs
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3 AND ts <= $4
          GROUP BY 1
          ORDER BY tokens DESC
          LIMIT ${groupLimit}`,
        scope,
      ),
      runQuery<GroupRow>(
        `SELECT COALESCE(NULLIF(role, ''), 'unattributed') AS key,
                COALESCE(SUM(${TOKENS_EXPR}), 0)            AS tokens,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_source IN ('provider', 'estimated')), 0) AS cost_usd,
                COUNT(*)                                    AS runs
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3 AND ts <= $4
          GROUP BY 1
          ORDER BY tokens DESC
          LIMIT ${groupLimit}`,
        scope,
      ),
      runQuery<GroupRow>(
        `SELECT account_id AS key,
                COALESCE(SUM(${TOKENS_EXPR}), 0) AS tokens,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_source IN ('provider', 'estimated')), 0) AS cost_usd,
                COUNT(*)                         AS runs
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3 AND ts <= $4
            AND account_id IS NOT NULL
          GROUP BY 1
          ORDER BY tokens DESC
          LIMIT ${groupLimit}`,
        scope,
      ),
      runQuery<DayRow>(
        // ts is epoch ms; floor to the UTC day boundary so each bucket is one day.
        `SELECT (FLOOR(ts / ${DAY_MS}) * ${DAY_MS})::bigint AS day_start,
                COALESCE(SUM(${TOKENS_EXPR}), 0)            AS tokens,
                COALESCE(SUM(cost_usd) FILTER (WHERE cost_source IN ('provider', 'estimated')), 0) AS cost_usd
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3 AND ts <= $4
          GROUP BY 1
          ORDER BY day_start ASC`,
        scope,
      ),
      runQuery<CallRow>(
        `SELECT id, ts, COALESCE(NULLIF(model, ''), model_class, 'unknown') AS model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                cost_usd, cost_source
           FROM harness_shared.agent_usage_samples
          WHERE workspace_id = $1 AND harness_slug = $2 AND ts >= $3 AND ts <= $4
          ORDER BY ts DESC, id DESC LIMIT 20`,
        scope,
      ),
    ]);

    const t = totalsRows[0];
    const toGroup = (r: GroupRow): TokenGroupRow => ({
      key: r.key ?? 'unknown',
      tokens: num(r.tokens),
      costUsd: num(r.cost_usd),
      runs: num(r.runs),
    });
    const toDay = (r: DayRow): TokenTimeBucket => {
      const startMs = num(r.day_start);
      return { startMs, label: dayLabel(startMs), tokens: num(r.tokens), costUsd: num(r.cost_usd) };
    };

    return {
      observation: 'observed',
      periodStartMs: windowStart,
      periodEndMs: windowEnd,
      recentCalls: callRows.map(r => {
        const costSource = r.cost_usd == null ? 'unknown' :
          r.cost_source === 'provider' || r.cost_source === 'estimated' ? r.cost_source : 'unknown';
        const nullable = (value: string | number | null) => value == null ? null : num(value);
        return { id: String(r.id), atMs: num(r.ts), model: r.model ?? 'unknown',
          inputTokens: nullable(r.input_tokens), outputTokens: nullable(r.output_tokens),
          cacheReadTokens: nullable(r.cache_read_tokens), cacheCreationTokens: nullable(r.cache_creation_tokens),
          costUsd: costSource === 'unknown' ? null : nullable(r.cost_usd), costSource };
      }),
      windowMs,
      totals: {
        tokens: num(t?.tokens),
        costUsd: num(t?.total_usd),
        estimatedUsd: num(t?.estimated_usd),
        reportedUsd: num(t?.reported_usd),
        unpricedCalls: num(t?.unpriced_calls),
        unknownTokenCalls: num(t?.unknown_token_calls),
        runs: num(t?.runs),
        inputTokens: num(t?.input_tokens),
        outputTokens: num(t?.output_tokens),
        cacheReadTokens: num(t?.cache_read_tokens),
        cacheCreationTokens: num(t?.cache_creation_tokens),
      },
      byModel: modelRows.map(toGroup),
      byRole: roleRows.map(toGroup),
      byAccount: accountRows.map(toGroup),
      byDay: dayRows.map(toDay),
      accountAttributionAvailable: true,
    };
  } catch {
    // Keep unavailable distinct from a successfully observed empty ledger.
    return emptySnapshot(windowMs, false);
  }
}

/** Explicit export projection of this local observed window. Final delivery
 * still checks current consent; constructing this value grants no export. */
export function cloudDiagnosticAggregateFromUsage(snapshot: TokensDashboardSnapshot, operationId: string): CloudTelemetryEvent | null {
  if (snapshot.observation !== 'observed' || !Number.isFinite(snapshot.periodStartMs) ||
    !Number.isFinite(snapshot.periodEndMs) || (snapshot.totals.unknownTokenCalls ?? 0) > 0) return null;
  const totals = snapshot.totals;
  const parsed = cloudTelemetryEventSchema.safeParse({ event: 'cloud_diagnostic_aggregate', operation_id: operationId,
    properties: {
      period_start: new Date(snapshot.periodStartMs!).toISOString(), period_end: new Date(snapshot.periodEndMs!).toISOString(),
      calls: totals.runs, input_tokens: totals.inputTokens, output_tokens: totals.outputTokens,
      cache_read_tokens: totals.cacheReadTokens, cache_creation_tokens: totals.cacheCreationTokens,
      provider_cost_usd: totals.reportedUsd ?? null, estimated_cost_usd: totals.estimatedUsd,
      unpriced_calls: totals.unpricedCalls ?? totals.runs,
    } });
  return parsed.success ? parsed.data : null;
}

/** Customer host action, reached only through its authenticated private relay.
 * No usage, scope, consent or destination can be supplied by request JSON. */
export async function exportCustomerUsageDiagnostics(input: unknown, opts: {
  workspaceId: string; harnessSlug: string; organizationId: string; controlPlaneWorkspaceId: string;
  authorize: () => Promise<{ ok: true; principal: HostedPrincipal; monitoringConsent?: unknown } | { ok: false }>;
  runQuery: LoadHarnessTokensOpts['runQuery'];
  runtime: Pick<CloudTelemetryContext, 'environment' | 'release' | 'synthetic'>;
  deliver?: (event: unknown, context: CloudTelemetryContext, readConsent: () => Promise<unknown>) => Promise<{ delivered: boolean; code?: string }>;
  now?: () => number;
}): Promise<{ delivered: boolean; code?: string }> {
  const parsed = z.object({ operation_id: z.string().uuid(), window_ms: z.union([
    z.literal(DAY_MS), z.literal(7 * DAY_MS),
  ]) }).strict().safeParse(input);
  if (!parsed.success) return { delivered: false, code: 'invalid_export_request' };
  try {
    const current = await opts.authorize();
    const valid = (principal: HostedPrincipal) => isHostedPrincipal(principal) &&
      principal.permissions.has('workspace:operate') && principal.permissions.has('members:manage') &&
      principal.selectedWorkspaceId === opts.workspaceId &&
      principal.activeOrganizationId === opts.organizationId && principal.workspaceId === opts.controlPlaneWorkspaceId;
    if (!current.ok || !valid(current.principal)) return { delivered: false, code: 'unverified_principal' };
    const consent = cloudTelemetryConsentSchema.safeParse(current.monitoringConsent);
    if (!consent.success) return { delivered: false, code: 'consent_unavailable' };
    const choice = consent.data.diagnostics;
    if (!choice.enabled || !choice.since) return { delivered: false, code: 'consent_disabled' };
    const end = (opts.now ?? Date.now)();
    const start = Math.max(end - parsed.data.window_ms, Date.parse(choice.since));
    if (!Number.isFinite(start) || start > end) return { delivered: false, code: 'outside_consent_epoch' };
    const snapshot = await loadHarnessTokens({ workspace_id: opts.workspaceId, harness_slug: opts.harnessSlug,
      windowMs: end - start, periodStartMs: start, periodEndMs: end, runQuery: opts.runQuery });
    const event = cloudDiagnosticAggregateFromUsage(snapshot, parsed.data.operation_id);
    if (!event) return { delivered: false, code: 'local_usage_unavailable' };
    const deliver = opts.deliver ?? (await import('../cloud-telemetry-posthog')).deliverCloudPosthog;
    return await deliver(event, { principal: current.principal, ...opts.runtime, origin: 'customer-runtime',
      hostingMode: 'byoc', observedAt: new Date(end).toISOString() }, async () => {
      const final = await opts.authorize();
      const keys = ['workspaceId', 'selectedWorkspaceId', 'userId', 'activeOrganizationId', 'sessionId', 'sessionVersion'] as const;
      if (!final.ok || !valid(final.principal) || keys.some(key => final.principal[key] !== current.principal[key])) {
        throw new Error('diagnostic_export_authority_changed');
      }
      const latest = cloudTelemetryConsentSchema.parse(final.monitoringConsent);
      if (latest.diagnostics.since !== choice.since) throw new Error('diagnostic_export_epoch_changed');
      return latest;
    });
  } catch { return { delivered: false, code: 'delivery_unavailable' }; }
}

/** Production relay composition: the ledger is read on the customer's runtime,
 * under its trusted connector binding, and only the closed aggregate is sent. */
export async function handleCustomerDiagnosticExport(request: Request, opts: {
  workspaceId: string; organizationId: string; controlPlaneWorkspaceId: string;
  authorize: Parameters<typeof exportCustomerUsageDiagnostics>[1]['authorize'];
}): Promise<Response | undefined> {
  const match = /^\/api\/harness\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/insights\/diagnostic-export$/.exec(new URL(request.url).pathname);
  if (request.method !== 'POST' || !match) return undefined;
  const { withWorkspace } = await import('@papercusp/db-org');
  const { getBuildInfo } = await import('../build-info');
  const result = await exportCustomerUsageDiagnostics(await request.json().catch(() => null), {
    ...opts, harnessSlug: match[1], runtime: { environment: process.env.PORT === '3170' ? 'staging' :
      process.env.NODE_ENV === 'production' ? 'production' : 'development', release: getBuildInfo().sha ?? '' },
    runQuery: <T>(query: string, params: unknown[]) => withWorkspace(opts.workspaceId,
      async tx => await tx.unsafe(query, params as never) as unknown as T[]),
  });
  return Response.json(result, { status: 202, headers: { 'cache-control': 'no-store' } });
}
