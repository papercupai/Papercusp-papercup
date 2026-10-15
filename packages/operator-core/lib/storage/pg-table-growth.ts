/**
 * P-002: retain the existing storage alarm's complete catalog scan in audit_log.
 * This is table-size history, not another disk consumer (no byte double counting),
 * table, or schedule. Only this action's diagnostic samples expire after 30 days.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const PG_TABLE_GROWTH_INSTRUMENT_KEY = 'storage.pg-table-growth';
export const PG_TABLE_SAMPLE_ACTION = 'storage:pg-table-sizes';
const ACTOR = 'system:storage-growth-alarm';
const HOUR = 3_600_000;
const MAX_TABLES = 20_000;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const table = z.object({ oid: z.string().regex(/^[1-9][0-9]*$/), name: z.string().min(1),
  totalBytes: integer, rows: integer.nullable() });
const sampleSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), complete: z.literal(true),
  workspaceId: z.string().min(1), host: z.string().min(1),
  measuredAt: z.string().datetime({ offset: true }), schema: z.literal('harness_shared'),
  database: z.object({ name: z.string().min(1), oid: z.string().min(1),
    server: z.string().min(1), port: z.string().min(1), schemaOid: z.string().min(1) }),
  tableCount: integer.positive().max(MAX_TABLES), tables: z.array(table).min(1).max(MAX_TABLES),
}).refine(s => s.tables.length === s.tableCount &&
  new Set(s.tables.map(t => t.name)).size === s.tableCount &&
  new Set(s.tables.map(t => t.oid)).size === s.tableCount, 'Catalog coverage must be complete and unique.');

export type PgTableSizeSample = z.infer<typeof sampleSchema>;
export type PgGrowthSql = Pick<import('postgres').Sql, 'unsafe'>;

/** One catalog statement, with no top-N filter: an unregistered small grower matters too. */
export async function samplePgTableSizes(sql: PgGrowthSql, workspaceId: string,
  opts: { host?: string; now?: () => number } = {}): Promise<PgTableSizeSample> {
  if (!workspaceId.trim()) throw new Error('A canonical workspace is required.');
  const rows = await sql.unsafe(`
    SELECT current_database() AS database_name,
           (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
           coalesce(inet_server_addr()::text, 'local-socket') AS server,
           current_setting('port') AS port, n.oid::text AS schema_oid,
           c.oid::text AS oid, c.relname AS name,
           pg_total_relation_size(c.oid)::text AS total_bytes,
           CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint::text ELSE NULL END AS rows,
           count(*) OVER ()::text AS table_count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared' AND c.relkind IN ('r', 'm', 'p')
     ORDER BY c.oid LIMIT ${MAX_TABLES + 1}`) as Array<Record<string, unknown>>;
  const first = rows[0];
  if (!first) throw new Error('The table catalog is empty; coverage is unknown.');
  return sampleSchema.parse({ schemaVersion: 1, id: randomUUID(), complete: true,
    workspaceId, host: opts.host ?? hostname(), measuredAt: new Date((opts.now ?? Date.now)()).toISOString(),
    schema: 'harness_shared', database: { name: first.database_name, oid: first.database_oid,
      server: first.server, port: first.port, schemaOid: first.schema_oid },
    tableCount: Number(first.table_count), tables: rows.map(r => ({ oid: r.oid, name: r.name,
      totalBytes: Number(r.total_bytes), rows: r.rows === null ? null : Number(r.rows) })) });
}

/** Serialized JSON is explicitly text-bound, matching the existing reclaim receipt writer. */
export async function recordPgTableSizeSample(sql: PgGrowthSql, sample: PgTableSizeSample): Promise<void> {
  sampleSchema.parse(sample);
  const ts = Date.parse(sample.measuredAt);
  await sql.unsafe(`INSERT INTO harness_shared.audit_log
    (id, ts, actor, action, subject, details, workspace_id)
    VALUES ($1,$2,$3,$4,$1,$5::text::jsonb,$6)`,
  [sample.id, ts, ACTOR, PG_TABLE_SAMPLE_ACTION, JSON.stringify(sample), sample.workspaceId]);
  const rows = await sql.unsafe(`SELECT details FROM harness_shared.audit_log
    WHERE id = $1 AND workspace_id = $2 AND actor = $3 AND action = $4`,
  [sample.id, sample.workspaceId, ACTOR, PG_TABLE_SAMPLE_ACTION]) as Array<{ details: unknown }>;
  if (!isDeepStrictEqual(rows[0]?.details, sample)) throw new Error('Table-size sample readback mismatch.');
  // Never prune another audit action or another host/workspace's samples.
  await sql.unsafe(`DELETE FROM harness_shared.audit_log
    WHERE workspace_id = $1 AND actor = $2 AND action = $3
      AND details->>'host' = $4 AND ts < $5`,
  [sample.workspaceId, ACTOR, PG_TABLE_SAMPLE_ACTION, sample.host, ts - 30 * 24 * HOUR]);
}

export interface PgTableGrowthRow {
  table: string; oid: string; totalBytes: number;
  baselineBytes: number | null; growthBytes: number | null;
  /** A new/recreated table has no comparable baseline; absence never means zero. */
  status: 'comparable' | 'new-or-recreated';
  retentionCode: string | null;
}
export interface PgTableGrowthMeasurement {
  verdict: 'pass' | 'unknown'; reason: string;
  measurementVerdict: 'pass' | 'unknown';
  sampleIds: string[]; sampledAt?: string; baselineAt?: string;
  elapsedHours?: number; tables: PgTableGrowthRow[];
  topLargest: string[]; topGrowers: string[]; unresolved: string[]; dropped: string[];
}
function unknown(reason: string): PgTableGrowthMeasurement {
  return { verdict: 'unknown', measurementVerdict: 'unknown', reason, sampleIds: [],
    tables: [], topLargest: [], topGrowers: [], unresolved: [], dropped: [] };
}

/** Pure assessment; policy exemptions are not owner decisions on the acceptance plan. */
export function assessPgTableGrowth(latest: unknown, baseline: unknown,
  input: { workspaceId: string; host: string; windowStart: string; windowEnd: string },
  retentionCode: Readonly<Record<string, string>> = {}): PgTableGrowthMeasurement {
  const a = sampleSchema.safeParse(latest), b = sampleSchema.safeParse(baseline);
  if (!a.success || !b.success) return unknown('Missing, malformed or incomplete catalog samples.');
  const current = a.data, previous = b.data;
  const at = Date.parse(current.measuredAt), before = Date.parse(previous.measuredAt);
  const start = Date.parse(input.windowStart), end = Date.parse(input.windowEnd);
  if (![start, end].every(Number.isFinite) || start >= end ||
      at > end || end - at > 7 * HOUR || before < start || at - before < 24 * HOUR || at - before > 30 * HOUR ||
      current.id === previous.id || current.workspaceId !== input.workspaceId || previous.workspaceId !== input.workspaceId ||
      current.host !== input.host || previous.host !== input.host || !isDeepStrictEqual(current.database, previous.database)) {
    return unknown('Require fresh, same-workspace/host/database catalog samples 24–30h apart inside the subject window.');
  }
  const old = new Map(previous.tables.map(t => [t.name, t]));
  const tables: PgTableGrowthRow[] = current.tables.map(t => {
    const prior = old.get(t.name), comparable = prior?.oid === t.oid;
    return { table: t.name, oid: t.oid, totalBytes: t.totalBytes,
      baselineBytes: comparable ? prior!.totalBytes : null,
      growthBytes: comparable ? t.totalBytes - prior!.totalBytes : null,
      status: comparable ? 'comparable' : 'new-or-recreated', retentionCode: retentionCode[t.name] || null };
  });
  const bySize = [...tables].sort((a, b) => b.totalBytes - a.totalBytes || a.table.localeCompare(b.table));
  const growers = tables.filter(t => t.growthBytes !== null && t.growthBytes > 0)
    .sort((a, b) => b.growthBytes! - a.growthBytes! || a.table.localeCompare(b.table));
  const topLargest = bySize.slice(0, 20).map(t => t.table), topGrowers = growers.slice(0, 20).map(t => t.table);
  const needsPolicy = new Set([...topLargest, ...growers.map(t => t.table),
    ...tables.filter(t => t.status !== 'comparable').map(t => t.table)]);
  const unresolved = tables.filter(t => needsPolicy.has(t.table) && !t.retentionCode).map(t => t.table).sort();
  const dropped = previous.tables.filter(t => !tables.some(c => c.table === t.name)).map(t => t.name).sort();
  const comparable = tables.every(t => t.status === 'comparable');
  // A growth measurement cannot certify an unmeasured/merely asserted owner decision.
  const verdict = comparable && unresolved.length === 0 ? 'pass' : 'unknown';
  return { verdict, measurementVerdict: comparable ? 'pass' : 'unknown',
    reason: verdict === 'pass' ? 'Complete per-table growth measured; in-scope tables have recorded retention code paths.'
      : 'Growth recorded; new/recreated tables or retention/owner-decision coverage still require verification.',
    sampleIds: [previous.id, current.id], sampledAt: current.measuredAt, baselineAt: previous.measuredAt,
    elapsedHours: (at - before) / HOUR, tables, topLargest, topGrowers, unresolved, dropped };
}

/** Read retained native samples, never caller-supplied measurements or provenance. */
export async function measurePgTableGrowthWindow(sql: PgGrowthSql,
  input: { workspaceId: string; windowStart: string; windowEnd: string; host?: string }): Promise<PgTableGrowthMeasurement> {
  const start = Date.parse(input.windowStart), end = Date.parse(input.windowEnd), host = input.host ?? hostname();
  if (!input.workspaceId.trim() || ![start, end].every(Number.isFinite) || start >= end) return unknown('Invalid workspace or observation window.');
  const rows = await sql.unsafe(`SELECT subject, ts, details FROM harness_shared.audit_log
    WHERE workspace_id = $1 AND actor = $2 AND action = $3
      AND ts BETWEEN $4 AND $5 AND details->>'host' = $6
    ORDER BY ts DESC, id DESC LIMIT 129`,
  [input.workspaceId, ACTOR, PG_TABLE_SAMPLE_ACTION, start, end, host]) as Array<{ subject: string; ts: string | number; details: unknown }>;
  if (!rows.length || rows.length > 128) return unknown('Missing or truncated table-size sample history.');
  const parsed = rows.map(r => sampleSchema.safeParse(r.details));
  if (parsed.some((p, i) => !p.success || p.data.id !== rows[i]!.subject || Date.parse(p.data.measuredAt) !== Number(rows[i]!.ts))) {
    return unknown('Native sample envelope or catalog coverage is invalid.');
  }
  const samples = parsed.map(p => p.data!);
  const latest = samples[0]!;
  const baseline = samples.find(s => Date.parse(latest.measuredAt) - Date.parse(s.measuredAt) >= 24 * HOUR);
  // Reuse the existing audited retention registry. A never-prunable exemption alone
  // does not prove the acceptance plan records an owner decision, so it is excluded.
  const { RETENTION_COVERED_ELSEWHERE, RETENTION_WINDOWS } = await import('./storage-growth-alarm');
  const retention = Object.fromEntries(Object.entries(RETENTION_COVERED_ELSEWHERE)
    .filter(([, path]) => /^(pruned by|cascade-deleted with)/.test(path)));
  for (const window of RETENTION_WINDOWS) retention[window.table] = window.prunedBy;
  return assessPgTableGrowth(latest, baseline, { ...input, host }, retention);
}
