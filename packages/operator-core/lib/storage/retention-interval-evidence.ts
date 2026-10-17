/**
 * Assess retained native storage receipts without probing or changing the host.
 * This is the assessor of the records, not the sampler that originally wrote
 * them. A passing byte-window assessment does not certify candidate admission,
 * inodes, continuous capacity, the frontend recorder, or final shipment.
 */
import { z } from 'zod';
import { criticalWriteHeadroomBytes, DEFAULT_DISK_POLICY } from './disk-space-alarm';
import { observeColdArchiveIntegrity, type ColdEvidence } from './cold-tier-evidence';
import { getStorageCategory, isPgCategory } from './categories';
import { tableRetentionTargets } from './table-retention';

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().regex(/^v1-[a-f0-9]{64}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const policy = z.object({
  criticalFreePctMin: z.number().positive().max(1),
  criticalFreeBytesMin: bytes.positive(),
  criticalFreeBytesCap: bytes.positive(),
  freeInodesPctMin: z.number().positive().max(1),
}).passthrough();
const snapshot = z.object({
  path: z.string().min(1).max(512), dev: bytes,
  totalBytes: bytes.positive(), availableBytes: bytes, reservedBytes: bytes,
  usableAfterReservationsBytes: z.number().finite().optional(),
  criticalFloorBytes: z.number().finite().optional(),
  totalInodes: bytes.optional(), freeInodes: bytes.optional(),
}).passthrough();
const generation = z.object({
  device: bytes, inode: bytes.positive(), markerInode: bytes.positive(), markerSha256: sha256,
}).passthrough();
const pin = z.object({
  name: z.string().min(1).max(512), identity, checkout: z.string().min(1).max(2048),
}).passthrough();
const store = z.object({
  path: z.string().min(1).max(512), physical: z.string().min(1).max(512), device: bytes,
  generations: z.record(identity, generation).refine((x) => Object.keys(x).length <= 256),
  pins: z.array(pin).max(256), leases: z.array(z.unknown()).max(256),
}).passthrough();
const endpoint = z.object({
  at: z.string().datetime({ offset: true }), nativePid: bytes.positive(), scriptSha256: sha256,
  policy, snapshots: z.array(snapshot).min(1).max(32),
  stores: z.array(store).min(1).max(16).refine((xs) =>
    new Set(xs.map((x) => x.path)).size === xs.length && new Set(xs.map((x) => x.physical)).size === xs.length,
  'Captured stores must have unique path and physical identity.'),
  runtimeStableDuringRead: z.boolean().optional(),
}).passthrough();
const epoch = z.union([bytes.positive(), z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)])
  .refine(Number.isSafeInteger, 'Native epoch milliseconds must be a safe integer.');
const step = z.object({
  workflow_uuid: z.string().min(1).max(512), function_name: z.literal('dependency-generation-retention'),
  started_at_epoch_ms: epoch, completed_at_epoch_ms: epoch,
  error: z.unknown().refine((x) => x !== undefined, 'An explicit native error or null receipt is required.'),
  receipt: z.object({
    status: z.enum(['complete', 'partial', 'unavailable']), errors: z.array(z.unknown()).max(256),
    stores: z.array(z.object({
      generationRoot: z.string().min(1).max(512), status: z.enum(['pruned', 'failed']),
      stdout: z.string().max(4096), stderr: z.string().max(4096),
      stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
    }).passthrough()).max(16),
  }).passthrough(),
}).passthrough();
const artifactSchema = z.object({
  native0250Window: z.object({ pre: endpoint, registeredStep: step }).passthrough(),
  oneHourNativeEndpoint: z.object({ receipt: endpoint }).passthrough(),
}).passthrough();

export interface RetentionEvidenceCheck {
  id: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
}
export interface RetentionIntervalAssessment {
  schemaVersion: 1;
  kind: 'retained-storage-interval-assessment';
  intervalStatus: 'pass' | 'fail' | 'unknown';
  sampledSpanMs: number | null;
  checks: RetentionEvidenceCheck[];
  byteSnapshots: Array<{ endpoint: 'before' | 'after'; path: string; device: number; usableBytes: number; floorBytes: number }>;
  coverage: { population: string[]; checked: string[]; notChecked: string[]; notApplicable: string[]; residue: string[] };
  scope: string[];
}

const soakRequirementsSchema = z.object({
  host: z.string().min(1), artifactRef: z.string().min(1),
  shippedAt: z.string().datetime({ offset: true }), startAt: z.string().datetime({ offset: true }),
  measuredAt: z.string().datetime({ offset: true }),
  maxSampleGapMs: bytes.positive(), maxAlarmGapMs: bytes.positive().max(6 * 3_600_000),
}).refine((x) => Date.parse(x.startAt) >= Date.parse(x.shippedAt), 'The soak must start after shipment.');

export const DISK_HEADROOM_SOAK_INSTRUMENT_KEY = 'storage:disk-headroom-post-shipment-72h';
/** The durable-headroom requirement has stronger targets and cadence than the native policy soak. */
export const DURABLE_HEADROOM_TARGETS_INSTRUMENT_KEY = 'storage:durable-headroom-targets-72h';
/** Native R-8 binding: routine completion, live age probes, cold archive integrity,
 * and serving-reader containment are one evidence record. */
export const POSTGRES_RETENTION_INSTRUMENT_KEY = 'storage:postgres-retention-30d';

const retentionName = z.string().min(1).refine(value => value.trim().length > 0);
const retentionTimestamp = z.string().datetime({ offset: true });
const postgresRoutineSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('telemetry-retention-completion'),
  workspaceId: retentionName, host: retentionName, workflowId: retentionName, routineId: retentionName,
  startedAt: retentionTimestamp, finishedAt: retentionTimestamp, completedAt: retentionTimestamp,
  dryRun: z.boolean(), tableRetentionComplete: z.boolean(),
  targets: z.array(z.object({ category: retentionName, complete: z.boolean(), retentionDays: bytes.positive() })).max(256),
}).passthrough();
const postgresEvidenceSchema = z.object({
  workspaceId: retentionName, host: retentionName, measuredAt: retentionTimestamp,
  routine: postgresRoutineSchema.nullable(),
  ages: z.array(z.object({ category: retentionName, oldestAgeDays: z.number().finite().nonnegative().nullable(), measured: z.boolean() })).max(256),
  coldIntegrity: z.object({ verdict: z.enum(['pass', 'fail', 'unknown']), detail: z.string() }),
  servingRuntimes: z.array(z.object({ runtime: retentionName, applicable: z.boolean(), containsColdFallback: z.boolean().nullable() })).max(256),
});
export type PostgresRetentionEvidence = z.infer<typeof postgresEvidenceSchema>;

// The maintained telemetry-retention seed runs daily at 04:00. A receipt older
// than one cadence cannot establish that the current production run completed.
const POSTGRES_RETENTION_RECEIPT_MAX_AGE_MS = 24 * 3_600_000;

/** Pure R-8 assessor. Missing native receipts/readers is UNKNOWN; a measured bad
 * age, failed routine, failed cold verification, or explicit serving refusal FAILS. */
export function assessPostgresRetentionEvidence(input: unknown) {
  const checks: RetentionEvidenceCheck[] = [];
  const add = (id: string, status: RetentionEvidenceCheck['status'], detail: string) => checks.push({ id, status, detail });
  const finish = () => ({ verdict: checks.some(c => c.status === 'fail') ? 'fail' as const :
    checks.some(c => c.status === 'unknown') ? 'unknown' as const : 'pass' as const,
    detail: JSON.stringify({ checks, scope: 'R-8 native routine/age/cold-integrity/serving-reader evidence' }), checks });
  const parsed = postgresEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    add('evidence-shape', 'unknown', 'Native receipt, measurement scope, ages and explicit reader booleans are required.');
    return finish();
  }
  const evidence = parsed.data;
  const expected = tableRetentionTargets();
  const routine = evidence.routine;
  if (!routine) add('routine-receipt', 'unknown', 'No completed production telemetry-retention receipt was found.');
  else {
    const started = Date.parse(routine.startedAt), finished = Date.parse(routine.finishedAt);
    const completed = Date.parse(routine.completedAt), measured = Date.parse(evidence.measuredAt);
    add('routine-scope', routine.workspaceId === evidence.workspaceId && routine.host === evidence.host ? 'pass' : 'unknown',
      'The native receipt must belong to the measured workspace and host.');
    add('routine-freshness', started <= finished && finished <= completed && completed <= measured &&
      measured - finished <= POSTGRES_RETENTION_RECEIPT_MAX_AGE_MS ? 'pass' : 'fail',
    'Native start <= finish <= DBOS completion <= measurement; finish must be within the daily 24-hour cadence.');
    add('routine-receipt', routine.dryRun === false && routine.tableRetentionComplete &&
      routine.targets.length === expected.length && new Set(routine.targets.map(t => t.category)).size === expected.length &&
      expected.every(target => routine.targets.some(t => t.category === target.category && t.complete && t.retentionDays === target.retention_days))
      ? 'pass' : 'fail', 'A non-dry production receipt must complete the exact canonical categories and retention horizons.');
  }
  for (const target of expected) {
    const rows = evidence.ages.filter(a => a.category === target.category), row = rows[0];
    add(`age:${target.category}`, rows.length > 1 ? 'fail' : !row || !row.measured ? 'unknown' :
      row.oldestAgeDays !== null && row.oldestAgeDays > target.retention_days ? 'fail' : 'pass',
      `Measured oldest age must be <= ${target.retention_days} days.`);
  }
  add('cold-integrity', evidence.coldIntegrity.verdict, evidence.coldIntegrity.detail);
  const applicable = evidence.servingRuntimes.filter(r => r.applicable);
  add('serving-cold-fallback', applicable.length === 0 || applicable.some(r => r.containsColdFallback === false) ? 'fail' :
    applicable.some(r => r.containsColdFallback === null) ? 'unknown' : 'pass',
    'Every applicable serving reader must be positively bound to the maintained cold fallback.');
  return finish();
}

/** postgres.js returns numeric aggregates as decimal strings. Never coerce
 * booleans, blank strings or objects into measurements. */
function retentionNumber(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

/** Production adapter for the R-8 instrument. It reads the existing DBOS routine
 * output and category registry rather than inventing a second retention ledger. */
export async function measurePostgresRetentionEvidence(sql: Pick<import('postgres').Sql, 'unsafe'>, input: {
  workspaceId: string; host: string; servingRuntimes: PostgresRetentionEvidence['servingRuntimes'];
  coldIntegrity?: ColdEvidence;
}) {
  const categories = tableRetentionTargets();
  const ages = await Promise.all(categories.map(async target => {
    const missing = { category: target.category, oldestAgeDays: null, measured: false };
    const cat = getStorageCategory(target.category);
    if (!cat || !isPgCategory(cat) || !cat.ageColumn || !cat.ageColumnType) return missing;
    const ident = /^[a-z_][a-z0-9_]*$/;
    if (!ident.test(cat.schema) || !ident.test(cat.table) || !ident.test(cat.ageColumn)) return missing;
    try {
      const oldest = cat.ageColumnType === 'epoch_ms' ? `to_timestamp(min(${cat.ageColumn})/1000.0)` : `min(${cat.ageColumn})`;
      const rows = await sql.unsafe(`SELECT count(*)::text AS total_rows, count(${cat.ageColumn})::text AS dated_rows,
        extract(epoch FROM now() - ${oldest})/86400.0 AS oldest_age_days FROM ${cat.schema}.${cat.table}`);
      const row = rows.length === 1 ? rows[0] : undefined;
      const total = retentionNumber(row?.total_rows), dated = retentionNumber(row?.dated_rows);
      if (total === null || dated === null || !Number.isSafeInteger(total) || !Number.isSafeInteger(dated) || dated !== total) return missing;
      if (total === 0) return row?.oldest_age_days === null ? { ...missing, measured: true } : missing;
      const age = retentionNumber(row?.oldest_age_days);
      return age === null ? missing : { category: target.category, oldestAgeDays: age, measured: true };
    } catch { return missing; }
  }));
  let routine: unknown = null;
  try {
    const routineRows = await sql.unsafe(`SELECT o.workflow_uuid, o.completed_at_epoch_ms, o.output
      FROM dbos.operation_outputs o JOIN dbos.workflow_status w ON w.workflow_uuid=o.workflow_uuid
      WHERE o.function_name='system:telemetry-retention' AND w.name='routineFire' AND o.error IS NULL
        AND COALESCE(o.output::jsonb #>> '{json,diagnostics,retention,workspaceId}', o.output::jsonb #>> '{diagnostics,retention,workspaceId}')=$1
        AND COALESCE(o.output::jsonb #>> '{json,diagnostics,retention,host}', o.output::jsonb #>> '{diagnostics,retention,host}')=$2
      ORDER BY o.completed_at_epoch_ms DESC LIMIT 1`, [input.workspaceId, input.host]);
    const row = routineRows[0];
    const output = row?.output ? JSON.parse(String(row.output)) : null;
    const diagnostics = output?.json?.diagnostics?.retention ?? output?.diagnostics?.retention ?? null;
    const completion = epoch.safeParse(row?.completed_at_epoch_ms);
    if (diagnostics && completion.success && diagnostics.workflowId === row?.workflow_uuid) {
      routine = { ...diagnostics, completedAt: new Date(completion.data).toISOString() };
    }
  } catch { /* Missing/unreadable native ledger remains UNKNOWN, never a completion. */ }
  return assessPostgresRetentionEvidence({
    workspaceId: input.workspaceId, host: input.host, measuredAt: new Date().toISOString(), routine, ages,
    coldIntegrity: input.coldIntegrity ?? await observeColdArchiveIntegrity(sql, input.workspaceId),
    servingRuntimes: input.servingRuntimes,
  });
}

const targetRecordsSchema = z.object({
  censuses: soakCensusRows(),
  attempts: z.array(z.object({ id: z.string().min(1), host: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }) })).max(20_000),
  receipts: z.array(z.object({ id: z.string().min(1), host: z.string().min(1), dryRun: z.literal(false),
    startedAt: z.string().datetime({ offset: true }), finishedAt: z.string().datetime({ offset: true }),
    complete: z.boolean(), policyExhausted: z.boolean().nullable(), errors: z.array(z.string()),
    entries: z.array(z.object({ status: z.string() })), delegates: z.array(z.object({ ok: z.boolean() })),
  })).max(20_000),
  dispositions: z.object({ supersededPlan: z.string().min(1), successorPlan: z.literal('disk-durable-headroom-2026-10-15'),
    planTerminal: z.boolean(), linkedSuccessor: z.boolean(), siblingId: z.literal('WI-10007751'), siblingTerminal: z.boolean() }),
});
function soakCensusRows() {
  return z.array(z.object({ id: z.string().min(1), host: z.string().min(1), path: z.enum(['/', '/mnt/data']),
    at: z.string().datetime({ offset: true }), availableBytes: bytes, complete: z.boolean() })).max(20_000);
}

/** Exact R-10 assessment: decimal GB/TB, 72 hourly buckets on each device, and
 * the full native started/finished population. No alarm can excuse a target dip. */
export function assessDurableHeadroomTargets(input: unknown,
  window: { host: string; windowStart: string; windowEnd: string; measuredAt: string }) {
  const checks: RetentionEvidenceCheck[] = [];
  const add = (id: string, status: RetentionEvidenceCheck['status'], detail: string) => checks.push({ id, status, detail });
  const finish = () => ({ verdict: checks.some(c => c.status === 'fail') ? 'fail' as const :
    checks.some(c => c.status === 'unknown') ? 'unknown' as const : 'pass' as const,
    detail: JSON.stringify({ checks, scope: 'Hourly native samples only; capacity between samples is unmeasured. GB/TB are decimal bytes.' }), checks });
  const parsed = targetRecordsSchema.safeParse(input);
  const start = Date.parse(window.windowStart), end = Date.parse(window.windowEnd), measured = Date.parse(window.measuredAt);
  const hour = 3_600_000;
  if (!parsed.success || !window.host.trim() || ![start, end, measured].every(Number.isFinite) || end - start !== 72 * hour || end > measured) {
    add('evidence-shape', 'unknown', 'Require a completed exact 72h window and complete, host-attributed native census/run/disposition records.');
    return finish();
  }
  const { censuses, attempts, receipts, dispositions } = parsed.data;
  if ([...censuses, ...attempts, ...receipts].some(r => r.host !== window.host)) {
    add('host-scope', 'unknown', 'Foreign-host records cannot certify this window.'); return finish();
  }
  for (const path of ['/', '/mnt/data'] as const) {
    const rows = censuses.filter(r => r.path === path && Date.parse(r.at) >= start && Date.parse(r.at) <= end);
    add(`unique-ordered:${path}`, rows.every((r, i) => i === 0 || Date.parse(r.at) > Date.parse(rows[i - 1]!.at)) &&
      new Set(rows.map(r => r.id)).size === rows.length ? 'pass' : 'fail', 'Native sample order and identity must be unique.');
    const missing = Array.from({ length: 72 }, (_, h) => h).filter(h => !rows.some(r =>
      Date.parse(r.at) >= start + h * hour && Date.parse(r.at) < start + (h + 1) * hour && r.complete));
    add(`hourly-coverage:${path}`, missing.length ? 'unknown' : 'pass', `Missing/incomplete hourly buckets: ${missing.join(',') || 'none'}.`);
    const floor = path === '/' ? 400 * 1000 ** 3 : 2 * 1000 ** 4;
    add(`exact-target:${path}`, rows.some(r => r.availableBytes < floor) ? 'fail' : rows.length ? 'pass' : 'unknown', `Every observed sample must have >=${floor} free bytes.`);
  }
  const runs = attempts.filter(r => Date.parse(r.startedAt) >= start && Date.parse(r.startedAt) <= end);
  const results = receipts.filter(r => Date.parse(r.startedAt) >= start && Date.parse(r.startedAt) <= end);
  add('run-population', runs.length && new Set(runs.map(r => r.id)).size === runs.length &&
    new Set(results.map(r => r.id)).size === results.length && results.every(r => runs.some(a => a.id === r.id)) ? 'pass' : 'unknown',
  'Every real start must have exactly one matching terminal receipt; empty or ambiguous populations cannot pass.');
  for (const run of runs) {
    const receipt = results.find(r => r.id === run.id && r.startedAt === run.startedAt);
    add(`complete-run:${run.id}`, !receipt || Date.parse(receipt.finishedAt) > measured ? 'unknown' :
      Date.parse(receipt.finishedAt) < Date.parse(run.startedAt) || !receipt.complete || receipt.policyExhausted !== true ||
      receipt.errors.length || receipt.entries.some(e => e.status === 'failed') || receipt.delegates.some(d => !d.ok) ? 'fail' : 'pass',
    'The native run must finish, exhaust its policy and have no errors or failed effects/delegates.');
  }
  // A silent/dead scheduler cannot pass merely because it emitted one good receipt.
  const missingRuns = Array.from({ length: 72 }, (_, h) => h).filter(h => !runs.some(r =>
    Date.parse(r.startedAt) >= start + h * hour && Date.parse(r.startedAt) < start + (h + 1) * hour));
  add('hourly-reclaim-coverage', missingRuns.length ? 'unknown' : 'pass', `Hours without a real reclaim start: ${missingRuns.join(',') || 'none'}.`);
  add('superseded-disposition', dispositions.planTerminal && dispositions.linkedSuccessor && dispositions.siblingTerminal ? 'pass' : 'unknown',
    'The superseded plan must be terminal and linked into this successor; WI-10007751 must be terminal.');
  return finish();
}

/** Extend the existing native ledger reader; never use supplied scores, receipt
 * claims, policy floors, or data from another host as R-10 evidence. */
export async function measureDurableHeadroomTargets(sql: Pick<import('postgres').Sql, 'unsafe'>,
  input: { workspaceId: string; harnessSlug: string; host: string; windowStart: string; windowEnd: string }) {
  const start = Date.parse(input.windowStart), end = Date.parse(input.windowEnd);
  if (!input.workspaceId.trim() || !input.harnessSlug.trim() || !input.host.trim() || !Number.isFinite(start) || end - start !== 72 * 3_600_000) {
    return { verdict: 'unknown' as const, detail: 'Canonical workspace/harness/host and exact 72h window required.' };
  }
  const rows = await sql.unsafe(`WITH census AS (
    SELECT run_id::text AS id, host, device AS path, finished_at AS at, avail_bytes AS "availableBytes", complete
    FROM harness_shared.disk_census_runs WHERE host=$1 AND device IN ('/','/mnt/data')
      AND finished_at BETWEEN $2::timestamptz AND $3::timestamptz ORDER BY finished_at,device,run_id LIMIT 20001
  ), activity AS (
    SELECT action, details FROM harness_shared.audit_log
    WHERE workspace_id=$4 AND actor='system:disk-retention' AND action IN ('disk-retention:started','disk-retention:receipt')
      AND (details->>'host'=$1 OR details->>'host' IS NULL) AND details->>'dryRun'='false'
      AND ts BETWEEN $5 AND $6 ORDER BY ts,id LIMIT 40001
  ), predecessor AS (
    SELECT plan_slug, status, superseded_by FROM harness_shared.harness_plans
    WHERE workspace_id=$4 AND harness_slug=$7 AND plan_slug='disk-headroom-standing-reclaim-2026-10-12'
  ) SELECT
    COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.at,c.path,c.id) FROM census c),'[]'::jsonb) AS censuses,
    COALESCE((SELECT jsonb_agg(details ORDER BY details->>'startedAt') FROM activity WHERE action='disk-retention:started'),'[]'::jsonb) AS attempts,
    COALESCE((SELECT jsonb_agg(details ORDER BY details->>'startedAt') FROM activity WHERE action='disk-retention:receipt'),'[]'::jsonb) AS receipts,
    (SELECT jsonb_build_object('supersededPlan',plan_slug,'successorPlan','disk-durable-headroom-2026-10-15',
      'planTerminal',status IN ('done','dropped','superseded','complete','completed'),
      'linkedSuccessor',superseded_by='disk-durable-headroom-2026-10-15',
      'siblingId','WI-10007751','siblingTerminal',COALESCE((SELECT status IN ('done','resolved','dropped','declined')
        FROM harness_shared.work_items WHERE workspace_id=$4 AND harness_slug=$7 AND feature_id='WI-10007751'),false)) FROM predecessor) AS dispositions`,
  [input.host, input.windowStart, input.windowEnd, input.workspaceId, start, Date.now(), input.harnessSlug]);
  return assessDurableHeadroomTargets(rows[0], { ...input, measuredAt: new Date().toISOString() });
}

/** Resolve shipment identity from the existing deploy ledger, then assess the native records. */
export async function measureDiskHeadroomSoakWindow(
  sql: Pick<import('postgres').Sql, 'unsafe'>,
  input: {
    workspaceId: string; installSlug: string; host: string; deploymentId: string;
    windowStart: string; windowEnd: string; measuredAt: string;
  },
) {
  const request = z.object({
    workspaceId: z.string().min(1), installSlug: z.string().min(1), host: z.string().min(1).max(253),
    deploymentId: z.string().regex(/^[1-9][0-9]*$/),
    windowStart: z.string().datetime({ offset: true }), windowEnd: z.string().datetime({ offset: true }),
    measuredAt: z.string().datetime({ offset: true }),
  }).safeParse(input);
  if (!request.success || Date.parse(input.windowEnd) - Date.parse(input.windowStart) !== 72 * 3_600_000 ||
      Date.parse(input.windowEnd) > Date.parse(input.measuredAt)) {
    return { verdict: 'unknown' as const, reason: 'Require a complete, exact 72-hour plan window and a scoped deployment id/host.' };
  }
  const rows = await sql.unsafe(`
    SELECT id::text AS id, detail->>'host' AS host, detail->>'fullTargetSha' AS "artifactRef",
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "shippedAt"
      FROM harness_shared.pipeline_events
     WHERE id = $1::bigint AND workspace_id = $2 AND install_slug = $3
       AND kind = 'deploy' AND status = 'ok'`,
  [input.deploymentId, input.workspaceId, input.installSlug]);
  const shipment = z.object({
    id: z.literal(input.deploymentId), host: z.string(), artifactRef: z.string().regex(/^[a-f0-9]{40}$/),
    shippedAt: z.string().datetime({ offset: true }),
  }).safeParse(rows[0]);
  if (!shipment.success || !shipment.data.host.startsWith(`${input.host}:`) ||
      Date.parse(shipment.data.shippedAt) > Date.parse(input.windowStart)) {
    return { verdict: 'unknown' as const, reason: 'No successful post-health deploy receipt with this host and full artifact SHA precedes the window.' };
  }
  const evidence = await readDiskHeadroomSoakEvidence(sql, input.workspaceId, {
    host: input.host, artifactRef: shipment.data.artifactRef, shippedAt: shipment.data.shippedAt,
    startAt: input.windowStart, measuredAt: input.measuredAt,
    // Census runs every six hours; allow one hour for completion jitter. Alarm escalation has a six-hour cooldown.
    maxSampleGapMs: 7 * 3_600_000, maxAlarmGapMs: 6 * 3_600_000,
  });
  return { verdict: evidence.assessment.soakStatus, reason: evidence.assessment.scope,
    shipment: shipment.data, requirements: evidence.requirements, assessment: evidence.assessment };
}
const soakRecordsSchema = z.object({
  censuses: z.array(z.object({
    id: z.string().min(1), host: z.string().min(1), path: z.enum(['/', '/mnt/data']),
    at: z.string().datetime({ offset: true }), availableBytes: bytes, complete: z.boolean(),
  })).max(20_000),
  alarms: z.array(z.object({
    id: z.string().min(1), host: z.string().min(1), at: z.string().datetime({ offset: true }),
    consumers: z.record(z.string(), z.array(z.string().trim().min(1))),
  })).max(20_000),
});

/** Assess existing census/alarm ledger rows; never substitute a fixture for a shipped 72h window. */
export function assessDiskHeadroomSoak(input: unknown, requirements: unknown) {
  const checks: RetentionEvidenceCheck[] = [];
  const add = (id: string, status: RetentionEvidenceCheck['status'], detail: string) => checks.push({ id, status, detail });
  const finish = () => ({
    schemaVersion: 1 as const, kind: 'disk-headroom-soak-assessment' as const,
    soakStatus: checks.some((x) => x.status === 'fail') ? 'fail' as const :
      checks.some((x) => x.status === 'unknown') ? 'unknown' as const : 'pass' as const,
    checks,
    coverage: {
      population: checks.map((x) => x.id), checked: checks.filter((x) => x.status !== 'unknown').map((x) => x.id),
      notChecked: checks.filter((x) => x.status === 'unknown').map((x) => x.id), notApplicable: [] as string[],
      residue: checks.filter((x) => x.status !== 'pass').map((x) => `${x.id}: ${x.detail}`),
    },
    scope: 'Discrete census rows and named alarms only. Shipment identity and ledger query completeness must be verified by the caller; capacity between samples remains unmeasured.',
  });
  const required = soakRequirementsSchema.safeParse(requirements), parsed = soakRecordsSchema.safeParse(input);
  if (!required.success || !parsed.success) {
    add('record-shape', 'unknown', 'Require an explicit shipped artifact, post-shipment window, census rows and alarm rows.');
    return finish();
  }
  const { censuses, alarms } = parsed.data;
  const start = Date.parse(required.data.startAt), end = start + 72 * 3_600_000;
  const shipped = Date.parse(required.data.shippedAt), measured = Date.parse(required.data.measuredAt);
  add('elapsed-72h', measured >= end ? 'pass' : 'unknown', 'The observation clock must reach the full post-shipment 72-hour boundary.');
  if ([...censuses, ...alarms].some((x) => x.host !== required.data.host || Date.parse(x.at) > measured)) {
    add('record-scope', 'unknown', 'A foreign-host or future row cannot certify this host/window.');
    return finish();
  }
  for (const path of ['/', '/mnt/data'] as const) {
    const rows = censuses.filter((x) => x.path === path && Date.parse(x.at) >= shipped);
    const ordered = rows.every((x, i) => i === 0 || Date.parse(x.at) > Date.parse(rows[i - 1]!.at));
    const ids = new Set(rows.map((x) => x.id));
    add(`sample-order:${path}`, ordered && ids.size === rows.length ? 'pass' : 'fail', 'Preserve strictly increasing, unique native samples; do not sort away gaps or duplicate records.');
    if (!ordered || ids.size !== rows.length) continue;
    const before = rows.reduce((last, row, index) => Date.parse(row.at) <= start ? index : last, -1);
    const after = rows.findIndex((x) => Date.parse(x.at) >= end);
    add(`window-coverage:${path}`, before >= 0 && after >= 0 ? 'pass' : 'unknown', 'Each device needs post-shipment samples bracketing both soak boundaries.');
    const window = rows.slice(Math.max(0, before), after < 0 ? undefined : after + 1);
    const gaps = window.slice(1).map((x, i) => Date.parse(x.at) - Date.parse(window[i]!.at));
    add(`sample-gap:${path}`, gaps.length === 0 ? 'unknown' : Math.max(...gaps) <= required.data.maxSampleGapMs ? 'pass' : 'fail', 'Bound every observed gap by the evaluator cadence, including boundary-adjacent samples.');
    add(`complete-census:${path}`, window.length > 0 && window.every((x) => x.complete) ? 'pass' : 'unknown', 'Missing or incomplete census evidence stays unknown.');
    for (const row of window.filter((x) => Date.parse(x.at) >= start && Date.parse(x.at) <= end && x.availableBytes < 100 * 1024 ** 3)) {
      const at = Date.parse(row.at);
      const matching = alarms.some((alarm) => Date.parse(alarm.at) >= start && Date.parse(alarm.at) <= end &&
        Math.abs(Date.parse(alarm.at) - at) <= required.data.maxAlarmGapMs && (alarm.consumers[path]?.length ?? 0) > 0);
      add(`dip:${path}:${row.id}`, matching ? 'pass' : 'fail', 'Every measured dip below 100 GiB requires a nearby alarm naming this device\'s consumers.');
    }
  }
  for (const alarm of alarms.filter((x) => Date.parse(x.at) >= start && Date.parse(x.at) <= end)) {
    add(`named-alarm:${alarm.id}`, ['/', '/mnt/data'].every((path) => (alarm.consumers[path]?.length ?? 0) > 0) ? 'pass' : 'fail', 'Every alarm in the window must name consumers on both devices.');
  }
  return finish();
}

/** One snapshot of the existing native ledgers. A cap hit or legacy hostless alarm cannot pass. */
export async function readDiskHeadroomSoakEvidence(
  sql: Pick<import('postgres').Sql, 'unsafe'>, workspaceId: string, requirements: unknown,
) {
  const required = soakRequirementsSchema.parse(requirements);
  const end = new Date(Date.parse(required.startAt) + 72 * 3_600_000).toISOString();
  const censusEnd = new Date(Math.min(Date.parse(required.measuredAt), Date.parse(end) + required.maxSampleGapMs)).toISOString();
  const alarmEnd = new Date(Math.min(Date.parse(required.measuredAt), Date.parse(end))).toISOString();
  const rows = await sql.unsafe(`
    WITH censuses AS (
      SELECT run_id::text AS id, host, device AS path, finished_at AS at,
             avail_bytes AS "availableBytes", complete
        FROM harness_shared.disk_census_runs
       WHERE host = $1 AND device IN ('/', '/mnt/data')
         AND finished_at BETWEEN $2::timestamptz AND $3::timestamptz
       ORDER BY finished_at, device, run_id LIMIT 20001
    ), alarms AS (
      SELECT id::text AS id, data->>'host' AS host, created_at AS at, data->'consumers' AS consumers
        FROM harness_shared.attention_notifications
       WHERE workspace_id = $4 AND data->>'conditionKey' = 'alarm:disk-space'
         AND (data->>'host' = $1 OR data->>'host' IS NULL)
         AND created_at BETWEEN $5::timestamptz AND $6::timestamptz
       ORDER BY created_at, id LIMIT 20001
    )
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.at, c.path, c.id) FROM censuses c), '[]'::jsonb) AS censuses,
           COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.at, a.id) FROM alarms a), '[]'::jsonb) AS alarms`,
  [required.host, required.shippedAt, censusEnd, workspaceId, required.startAt, alarmEnd]);
  const records = rows[0] ?? { censuses: [], alarms: [] };
  return { records, requirements: required, assessment: assessDiskHeadroomSoak(records, required) };
}

const REQUIRED_PATHS = ['/', '/mnt/data', '/tmp/pcv'] as const;
const EXTERNAL_CHECKS = new Set(['inode-headroom', 'final-candidate-demand']);

// Compact native samples have measured storage and a writer identity, but no
// loaded-source witness. Assess their measurements without inventing one.
const sampleSeriesSchema = z.array(endpoint.omit({ stores: true }).extend({
  scriptSha256: sha256.optional(),
})).min(1).max(20_000);
const sampleRequirementsSchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  maxSampleGapMs: bytes.positive(),
}).refine((x) => Date.parse(x.endAt) > Date.parse(x.startAt), 'Require a positive observation window.');

/**
 * Assess sample coverage, not interpolated capacity. The evaluator supplies the
 * required window and maximum gap separately from the retained measurements.
 * This reuses endpoint policy/device records; it does not start a sampler or
 * upgrade an endpoint-only proof into continuous host evidence.
 */
export function assessRetainedStorageSamples(input: unknown, requirements: unknown) {
  const checks: RetentionEvidenceCheck[] = [];
  const add = (id: string, status: RetentionEvidenceCheck['status'], detail: string) => checks.push({ id, status, detail });
  const finish = (sampledSpanMs: number | null, largestGapMs: number | null, observedSamples: number) => ({
    schemaVersion: 1 as const, kind: 'retained-storage-sample-assessment' as const,
    sampleStatus: checks.some((x) => x.status === 'fail') ? 'fail' as const :
      checks.some((x) => x.status === 'unknown') ? 'unknown' as const : 'pass' as const,
    sampledSpanMs, largestGapMs, observedSamples, checks,
    coverage: {
      population: checks.map((x) => x.id),
      checked: checks.filter((x) => x.status !== 'unknown').map((x) => x.id),
      notChecked: checks.filter((x) => x.status === 'unknown').map((x) => x.id),
      notApplicable: [] as string[], residue: checks.filter((x) => x.status !== 'pass').map((x) => `${x.id}: ${x.detail}`),
    },
    scope: [
      'Retained discrete samples and their maximum gaps only; capacity between samples remains unmeasured.',
      'The required window and cadence come from the evaluator, not a passing flag in the artifact.',
      'Recorded runtime identity and stability during reads do not establish uninterrupted runtime between reads.',
      'No candidate admission, protected-payload custody, native retention execution, recorder recovery or shipment claim.',
    ],
  });
  const required = sampleRequirementsSchema.safeParse(requirements);
  const parsed = sampleSeriesSchema.safeParse(input);
  if (!required.success || !parsed.success) {
    add('sample-shape', 'unknown', [...(!required.success ? required.error.issues : []), ...(!parsed.success ? parsed.error.issues : [])]
      .slice(0, 8).map((x) => x.path.join('.') + ': ' + x.message).join('; '));
    return finish(null, null, 0);
  }
  const samples = parsed.data;
  const times = samples.map((x) => Date.parse(x.at));
  const chronological = times.every((at, index) => index === 0 || at > times[index - 1]!);
  add('sample-order', chronological ? 'pass' : 'fail', 'Supplied timestamps must be strictly increasing; no sorting or deduplication hides lost samples.');
  if (!chronological) return finish(null, null, samples.length);
  const start = Date.parse(required.data.startAt), end = Date.parse(required.data.endAt);
  const coversWindow = times[0]! <= start && times[times.length - 1]! >= end;
  add('window-coverage', coversWindow ? 'pass' : 'unknown', 'Actual samples must bracket both requested window boundaries.');
  // Only adjacent samples bracketing the requested window matter to its gap and
  // headroom checks. A much older prefix cannot fabricate or invalidate coverage.
  const first = times.reduce((index, at, current) => at <= start ? current : index, 0);
  const last = times.findIndex((at) => at >= end);
  const window = samples.slice(first, last < 0 ? undefined : last + 1);
  const gaps = window.slice(1).map((x, index) => Date.parse(x.at) - Date.parse(window[index]!.at));
  const largestGapMs = gaps.length ? Math.max(...gaps) : null;
  add('sample-gap', largestGapMs === null ? 'unknown' : largestGapMs <= required.data.maxSampleGapMs ? 'pass' : 'fail',
    `Largest observed gap ${largestGapMs ?? 'unknown'}ms; evaluator permits ${required.data.maxSampleGapMs}ms. No interpolation.`);
  const baseline = window[0]!;
  add('runtime-custody', window.some((x) => x.runtimeStableDuringRead === undefined || x.scriptSha256 === undefined) ? 'unknown' :
    window.every((x) => x.runtimeStableDuringRead && x.nativePid === baseline.nativePid && x.scriptSha256 === baseline.scriptSha256) ? 'pass' : 'fail',
    'Every included read must record the same PID/source and an explicit stability witness.');
  for (const path of REQUIRED_PATHS) {
    const rows = window.map((sample) => ({ sample, matches: sample.snapshots.filter((x) => x.path === path) }));
    const complete = rows.every((x) => x.matches.length === 1);
    const device = rows[0]!.matches[0];
    add(`byte-headroom:${path}`, !complete ? 'unknown' : rows.every(({ sample, matches }) => {
      const s = matches[0]!, usable = s.availableBytes - s.reservedBytes;
      const floor = criticalWriteHeadroomBytes(s.totalBytes, { ...DEFAULT_DISK_POLICY, ...sample.policy });
      return s.dev === device!.dev && s.totalBytes === device!.totalBytes && s.availableBytes <= s.totalBytes && usable >= floor &&
        (s.usableAfterReservationsBytes === undefined || s.usableAfterReservationsBytes === usable) &&
        (s.criticalFloorBytes === undefined || Math.abs(s.criticalFloorBytes - floor) <= 0.000001);
    }) ? 'pass' : 'fail', 'Recompute available-minus-reserved against each recorded policy on one stable device; check every included sample.');
    add(`inode-headroom:${path}`, !complete || rows.some(({ matches }) => matches[0]!.totalInodes === undefined || matches[0]!.freeInodes === undefined) ? 'unknown' :
      rows.every(({ sample, matches }) => {
        const s = matches[0]!;
        return s.freeInodes! <= s.totalInodes! && (s.totalInodes === 0 || s.freeInodes! / s.totalInodes! >= sample.policy.freeInodesPctMin);
      }) ? 'pass' : 'fail', 'Require recorded inode counts at every included sample; zero total means this filesystem does not report inodes.');
  }
  add('physical-alias-budget', window.every((sample) => sample.snapshots.every((s) =>
    sample.snapshots.filter((other) => other.dev === s.dev).every((other) => other.totalBytes === s.totalBytes && other.reservedBytes === s.reservedBytes))) ? 'pass' : 'fail',
  'Paths spending the same physical device must report one reservation budget; never sum alias budgets.');
  return finish(Date.parse(window[window.length - 1]!.at) - Date.parse(baseline.at), largestGapMs, window.length);
}

/** Recompute conclusions from bounded records; never trust their authored pass booleans. */
export function assessRetainedStorageInterval(input: unknown): RetentionIntervalAssessment {
  const checks: RetentionEvidenceCheck[] = [];
  const byteSnapshots: RetentionIntervalAssessment['byteSnapshots'] = [];
  const add = (id: string, status: RetentionEvidenceCheck['status'], detail: string) => checks.push({ id, status, detail });
  const finish = (sampledSpanMs: number | null): RetentionIntervalAssessment => {
    const interval = checks.filter((x) => !EXTERNAL_CHECKS.has(x.id));
    return {
      schemaVersion: 1, kind: 'retained-storage-interval-assessment', sampledSpanMs,
      intervalStatus: interval.some((x) => x.status === 'fail') ? 'fail' : interval.some((x) => x.status === 'unknown') ? 'unknown' : 'pass',
      checks, byteSnapshots,
      coverage: {
        population: checks.map((x) => x.id),
        checked: checks.filter((x) => x.status !== 'unknown').map((x) => x.id),
        notChecked: checks.filter((x) => x.status === 'unknown').map((x) => x.id),
        notApplicable: [], residue: checks.filter((x) => x.status !== 'pass').map((x) => `${x.id}: ${x.detail}`),
      },
      scope: [
        'Assessment of retained endpoint and native retention records; no host measurement or mutation.',
        'Byte headroom and captured protected-pin custody only; no continuous-capacity claim.',
        'No certification of candidate admission, frontend recorder, native journal recovery, or final shipment.',
        'A native completion receipt establishes per-store execution, not exclusive removal causality.',
      ],
    };
  };
  const parsed = artifactSchema.safeParse(input);
  if (!parsed.success) {
    add('receipt-shape', 'unknown', parsed.error.issues.slice(0, 8).map((x) => x.path.join('.') + ': ' + x.message).join('; '));
    return finish(null);
  }
  const before = parsed.data.native0250Window.pre;
  const after = parsed.data.oneHourNativeEndpoint.receipt;
  const retainedStep = parsed.data.native0250Window.registeredStep;
  const beforeMs = Date.parse(before.at), afterMs = Date.parse(after.at), span = afterMs - beforeMs;
  add('runtime-custody', after.runtimeStableDuringRead === undefined ? 'unknown' :
    after.runtimeStableDuringRead && before.nativePid === after.nativePid && before.scriptSha256 === after.scriptSha256 ? 'pass' : 'fail',
  'Compare recorded PID/script fingerprints and the sampler’s explicit service-stability witness.');
  add('sampled-hour-span', span >= 3_600_000 ? 'pass' : 'fail', `${span}ms between the recorded endpoints; no interpolation between samples.`);
  const completeStep = retainedStep.error === null && retainedStep.receipt.status === 'complete' && retainedStep.receipt.errors.length === 0;
  const stepInWindow = retainedStep.started_at_epoch_ms >= beforeMs && retainedStep.completed_at_epoch_ms >= retainedStep.started_at_epoch_ms && retainedStep.completed_at_epoch_ms <= afterMs;
  add('registered-retention-completion', completeStep && stepInWindow ? 'pass' : 'fail',
    `${retainedStep.workflow_uuid}: completion and per-store receipt must fall inside the retained window.`);

  for (const path of REQUIRED_PATHS) {
    const b = before.snapshots.filter((x) => x.path === path), a = after.snapshots.filter((x) => x.path === path);
    if (b.length !== 1 || a.length !== 1) {
      add(`byte-headroom:${path}`, 'unknown', 'Exactly one before and after snapshot is required for this explicit path.');
      continue;
    }
    let valid = b[0]!.dev === a[0]!.dev && b[0]!.totalBytes === a[0]!.totalBytes;
    for (const [which, observation, nativePolicy] of [['before', b[0]!, before.policy], ['after', a[0]!, after.policy]] as const) {
      const usableBytes = observation.availableBytes - observation.reservedBytes;
      const floorBytes = criticalWriteHeadroomBytes(observation.totalBytes, { ...DEFAULT_DISK_POLICY, ...nativePolicy });
      byteSnapshots.push({ endpoint: which, path, device: observation.dev, usableBytes, floorBytes });
      valid &&= observation.availableBytes <= observation.totalBytes && usableBytes >= floorBytes;
      valid &&= observation.usableAfterReservationsBytes === undefined || observation.usableAfterReservationsBytes === usableBytes;
      valid &&= observation.criticalFloorBytes === undefined || Math.abs(observation.criticalFloorBytes - floorBytes) <= 0.000001;
    }
    add(`byte-headroom:${path}`, valid ? 'pass' : 'fail', 'Independently recomputed available-minus-reservations and current recorded native policy floor on the same device.');
  }
  for (const [which, observations] of [['before', before.snapshots], ['after', after.snapshots]] as const) {
    const data = observations.find((x) => x.path === '/mnt/data'), alias = observations.find((x) => x.path === '/tmp/pcv');
    add(`physical-alias-budget:${which}`, !data || !alias ? 'unknown' :
      data.dev === alias.dev && data.totalBytes === alias.totalBytes && data.reservedBytes === alias.reservedBytes ? 'pass' : 'fail',
    'The explicit data/tmp aliases must use one physical-device reservation budget; never add that budget twice.');
  }
  for (const b of before.stores) {
    const matches = after.stores.filter((x) => x.path === b.path);
    if (matches.length !== 1) {
      add(`protected-pins:${b.path}`, 'unknown', 'The captured baseline store needs exactly one after-store custody record.');
      continue;
    }
    const a = matches[0]!;
    const pinsUnique = new Set(b.pins.map((x) => x.name)).size === b.pins.length && new Set(a.pins.map((x) => x.name)).size === a.pins.length;
    const preserved = b.pins.every((p) => {
      const ap = a.pins.find((x) => x.name === p.name), bg = b.generations[p.identity], ag = a.generations[p.identity];
      return ap?.identity === p.identity && ap.checkout === p.checkout && bg && ag &&
        bg.device === b.device && ag.device === a.device && bg.device === ag.device &&
        bg.inode === ag.inode && bg.markerInode === ag.markerInode && bg.markerSha256 === ag.markerSha256;
    });
    add(`protected-pins:${b.path}`, pinsUnique && preserved && b.physical === a.physical && b.device === a.device ? 'pass' : 'fail',
      'Compare pin identity/checkout and referenced generation device/inode/marker; ignore refreshable pin-file hashes.');
    const receipts = retainedStep.receipt.stores.filter((x) => x.generationRoot === b.path || x.generationRoot === b.physical);
    add(`native-store-receipt:${b.path}`, receipts.length !== 1 ? 'fail' :
      receipts[0]!.status === 'pruned' && !receipts[0]!.stdoutTruncated && !receipts[0]!.stderrTruncated ? 'pass' : 'fail',
      'Exactly one successful, untruncated native execution receipt is required for each captured physical store.');
    if (b.leases.length > 0) add(`selector-lease-custody:${b.path}`, 'unknown', 'Nonempty baseline leases require a separate liveness/expiry-aware custody witness.');
  }
  const inodeSnapshots = [...before.snapshots, ...after.snapshots];
  add('inode-headroom', inodeSnapshots.some((x) => x.totalInodes === undefined || x.freeInodes === undefined) ? 'unknown' :
    [...before.snapshots.map((x) => ({ x, floor: before.policy.freeInodesPctMin })), ...after.snapshots.map((x) => ({ x, floor: after.policy.freeInodesPctMin }))]
      .every(({ x, floor }) => x.totalInodes === 0 || x.freeInodes! <= x.totalInodes! && x.freeInodes! / x.totalInodes! >= floor) ? 'pass' : 'fail',
    'Byte samples do not establish inode headroom when inode counts were not captured.');
  add('final-candidate-demand', 'unknown', 'No applicable final native candidate admission-demand receipt is consumed by this interval assessor.');
  return finish(span);
}

const retainedPath = z.string().min(1).max(2048).regex(/^\/(?:[^/]+\/)*[^/]+$/)
  .refine((path) => path.split('/').every((part) => part !== '.' && part !== '..'), 'Require a normalized absolute retained path.');
const changes = z.array(z.unknown()).max(1024);
const count = bytes.max(1024);
const derivativeReceiptSchema = z.object({
  before: z.object({
    candidates: z.array(z.object({
      path: retainedPath, present: z.boolean(), directory: z.boolean(), sameDevice: z.boolean(),
      physicalPathUnaliased: z.boolean(), nestedMounts: changes,
    }).passthrough()).min(1).max(256),
    sources: z.array(z.object({ bank: retainedPath, sourcePresent: z.boolean() }).passthrough()).min(1).max(256),
    receipts: z.array(z.object({ path: retainedPath, bytes, sha256, metadataStable: z.boolean() }).passthrough()).min(1).max(1024),
    issues: changes,
  }).passthrough(),
  reconciliation: z.object({
    removedCandidates: count, remainingCount: count, remainingPaths: z.array(retainedPath).max(256),
    checkedReceipts: count, receiptChanges: changes,
  }).passthrough(),
  resumeBefore: z.object({
    candidateCount: count, checkedReceipts: count, sourceMarkers: count,
    sourceIdentities: z.record(retainedPath, z.tuple([bytes, bytes.positive()])), availableBytesBefore: bytes,
  }).passthrough(),
  resumeAfter: z.object({
    guardExit: z.number().int(), remainingCandidates: z.array(retainedPath).max(256),
    removedCandidateCount: count, resumedCandidateCount: count, checkedRetainedReceipts: count,
    receiptChanges: changes, sourceIdentityChanges: changes, markerChanges: changes,
    symlinkChanges: changes, protectedD224ReceiptChanges: changes,
    availableBytesBefore: bytes, availableBytesAfter: bytes, originalAvailableBytesBefore: bytes,
    observedNetAvailableIncreaseBytes: z.number().int().safe(),
    observedNetAvailableIncreaseSinceOriginalBytes: z.number().int().safe(),
  }).passthrough(),
  pathResults: z.array(z.object({ path: retainedPath, exit: z.number().int() })).max(256),
  resumeTerminalExit: z.number().int(),
  audit: z.object({
    originalRemovedPopulation: count, originalAdmissionRows: count, originalCompletionRows: count,
    resumePopulation: count, resumeCompletionRows: count, resumeFailureRows: count,
  }).passthrough(),
});

export interface DerivativeReceiptAssessment {
  schemaVersion: 1;
  kind: 'qualified-derivative-receipt-assessment';
  receiptStatus: 'pass' | 'fail' | 'unknown';
  observedNetAvailableIncreaseBytes: number | null;
  checks: RetentionEvidenceCheck[];
  coverage: RetentionIntervalAssessment['coverage'];
  scope: string[];
}

/** Assess saved transaction records, preserving gaps the original sampler did not measure. */
export function assessQualifiedDerivativeReceipts(input: unknown): DerivativeReceiptAssessment {
  const checks: RetentionEvidenceCheck[] = [];
  const add = (id: string, pass: boolean, detail: string) => checks.push({ id, status: pass ? 'pass' : 'fail', detail });
  const finish = (net: number | null): DerivativeReceiptAssessment => {
    const assessed = checks.filter((x) => x.status !== 'unknown');
    return {
      schemaVersion: 1, kind: 'qualified-derivative-receipt-assessment',
      receiptStatus: assessed.some((x) => x.status === 'fail') ? 'fail' : assessed.length ? 'pass' : 'unknown',
      observedNetAvailableIncreaseBytes: net, checks,
      coverage: {
        population: checks.map((x) => x.id), checked: assessed.map((x) => x.id),
        notChecked: checks.filter((x) => x.status === 'unknown').map((x) => x.id), notApplicable: [],
        residue: checks.filter((x) => x.status !== 'pass').map((x) => `${x.id}: ${x.detail}`),
      },
      scope: [
        'Consistency assessment of saved qualification, reconciliation, terminal, per-path and audit records; no host probe or mutation.',
        'Preservation checks assess the sampler’s recorded comparisons, not an independent reread of protected payload bytes.',
        'Available-byte subtraction is an observed net change; concurrent writers and physical sharing prevent exclusive reclaim attribution.',
        'No continuous headroom, candidate admission, recorder/journal recovery or final shipment certification.',
      ],
    };
  };
  const parsed = derivativeReceiptSchema.safeParse(input);
  if (!parsed.success) {
    checks.push({ id: 'receipt-shape', status: 'unknown', detail: parsed.error.issues.slice(0, 8).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
    return finish(null);
  }
  const { before, reconciliation: r, resumeBefore: b, resumeAfter: a, pathResults, resumeTerminalExit, audit } = parsed.data;
  const candidatePaths = before.candidates.map((x) => x.path);
  const sourcePaths = before.sources.map((x) => `${x.bank}/source`);
  const unique = (xs: string[]) => new Set(xs).size === xs.length;
  const sameSet = (xs: string[], ys: string[]) => unique(xs) && unique(ys) && xs.length === ys.length && xs.every((x) => ys.includes(x));
  add('qualified-population', unique(candidatePaths) && before.issues.length === 0 && before.candidates.every((x) =>
    x.present && x.directory && x.sameDevice && x.physicalPathUnaliased && x.nestedMounts.length === 0),
  'Require a nonempty unique candidate population and each recorded directory/device/alias/mount qualification.');
  add('retained-receipt-population', unique(before.receipts.map((x) => x.path)) && before.receipts.every((x) => x.metadataStable),
    'Require unique retained receipt paths, valid hashes/sizes and the recorded metadata-stability witnesses.');
  const contains = (parent: string, child: string) => parent === child || child.startsWith(`${parent}/`);
  const protectedPaths = [...sourcePaths, ...before.receipts.map((x) => x.path)];
  add('protected-path-boundaries', candidatePaths.every((path, index) =>
    !protectedPaths.some((protectedPath) => contains(path, protectedPath) || contains(protectedPath, path)) &&
    !candidatePaths.some((other, otherIndex) => index !== otherIndex && (contains(path, other) || contains(other, path)))),
  'Reject candidate overlap with captured source/receipt paths and overlapping candidate subtrees.');
  add('interruption-reconciliation', unique(r.remainingPaths) && r.remainingCount === r.remainingPaths.length &&
    r.remainingPaths.every((x) => candidatePaths.includes(x)) && r.removedCandidates + r.remainingCount === candidatePaths.length &&
    r.checkedReceipts === before.receipts.length && r.receiptChanges.length === 0,
  'Partition the original population into already absent and still present paths; never repeat the interrupted attempt blindly.');
  add('resume-path-completion', sameSet(pathResults.map((x) => x.path), r.remainingPaths) && pathResults.every((x) => x.exit === 0) &&
    b.candidateCount === r.remainingCount && a.resumedCandidateCount === r.remainingCount &&
    a.removedCandidateCount === candidatePaths.length && a.remainingCandidates.length === 0 && a.guardExit === 0 && resumeTerminalExit === 0,
  'Require exactly one successful per-path result for each remaining path plus recorded absence and terminal success.');
  add('recorded-preservation-comparisons', unique(sourcePaths) && before.sources.every((x) => x.sourcePresent) &&
    sameSet(Object.keys(b.sourceIdentities), sourcePaths) && b.sourceMarkers === sourcePaths.length &&
    b.checkedReceipts === before.receipts.length && a.checkedRetainedReceipts === before.receipts.length &&
    [a.receiptChanges, a.sourceIdentityChanges, a.markerChanges, a.symlinkChanges, a.protectedD224ReceiptChanges].every((x) => x.length === 0),
  'Verify population coverage and empty recorded drift sets for receipts, source identities, markers, links and protected nomination receipts.');
  add('resume-deletion-audit', audit.originalRemovedPopulation === r.removedCandidates &&
    audit.originalAdmissionRows === r.removedCandidates && audit.originalCompletionRows <= r.removedCandidates &&
    audit.resumePopulation === r.remainingCount && audit.resumeCompletionRows === pathResults.length && audit.resumeFailureRows === 0,
  'Reconcile the recorded original and resumed audit counters; original admission rows are not invented completion receipts.');
  const resumeNet = a.availableBytesAfter - b.availableBytesBefore;
  const originalNet = a.availableBytesAfter - a.originalAvailableBytesBefore;
  add('observed-net-available-bytes', a.availableBytesBefore === b.availableBytesBefore &&
    a.observedNetAvailableIncreaseBytes === resumeNet && a.observedNetAvailableIncreaseSinceOriginalBytes === originalNet,
  'Recompute both net changes from retained available-byte counters, without exclusive causality or sustained-capacity claims.');
  if (audit.originalCompletionRows !== r.removedCandidates) checks.push({
    id: 'original-per-path-completion-audit', status: 'unknown',
    detail: 'The original interrupted removal has no complete per-path terminal audit; later recorded absence is distinct evidence.',
  });
  for (const [id, detail] of [
    ['protected-payload-reread', 'Recorded unchanged comparisons do not establish an independent full protected-payload reread.'],
    ['universal-process-no-use', 'Incomplete process visibility cannot establish universal absence of live use.'],
    ['exclusive-reclaim-bytes', 'Concurrent allocation and physical sharing were not isolated.'],
    ['continuous-headroom', 'Discrete available-byte records do not establish capacity between samples.'],
    ['final-candidate-demand', 'No applicable final native candidate admission-demand receipt is assessed.'],
    ['recorder-journal-recovery', 'The cleanup receipts do not assess frontend recorder or native journal recovery.'],
    ['final-shipment', 'No independently supplied final shipment receipt is assessed.'],
  ] as const) checks.push({ id, status: 'unknown', detail });
  return finish(originalNet);
}
