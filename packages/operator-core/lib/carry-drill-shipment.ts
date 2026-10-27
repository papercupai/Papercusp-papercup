/** R-7 joins existing native receipts; it never starts a drill, deploy or cleanup. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { posix } from 'node:path';
import { reportBodySha256 } from './report-library';
import { completeReportDeliveryAt } from './report-result-delivery';
import { findLiveHostAsync } from './events/await/psu-pty-discovery';
import { measureCarryDrillLifecycle, readOwnerHostEvents, type CarryDrillMeasurement,
  type ColdBootDrillHostEvent } from './cold-boot-drill-live';

export const CARRY_SHIPMENT_PLAN = 'managed-carry-lifecycle-enforcement-2026-09-13';
/** Maintained carry implementation population, alongside the plan's code-truth audit. */
export const CARRY_SHIPMENT_SOURCE_PATHS = [
  'apps/operator/scripts/psu-pty-host.mjs',
  'apps/operator/scripts/hooks/cc/precompact-managed-carry.mjs',
  'packages/operator-core/lib/role-codex-home.ts',
  'packages/operator-core/lib/carry-respawn.ts',
  'packages/operator-core/lib/carry-respawn-outcome.ts',
  'packages/operator-core/lib/carry-doc.ts',
  'packages/operator-core/lib/agent-tools/session/request-compaction.ts',
  'packages/operator-core/lib/agent-tools/session/carry-drill.ts',
  'packages/operator-core/lib/agent-tools/reports/get.ts',
  'packages/operator-core/lib/cold-boot-drill.ts',
  'packages/operator-core/lib/cold-boot-drill-live.ts',
  'packages/operator-core/lib/carry-drill-shipment.ts',
  'packages/operator-core/lib/report-result-delivery.ts',
  'packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts',
  'packages/operator-core/lib/scorecards.ts',
  'packages/operator-core/lib/rubric-instrument-registry.ts',
] as const;

export interface CarryShipmentInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  ownerId: string;
  drillId: string;
  deploymentId: string;
  reportId: string;
  windowStart: string;
  windowEnd: string;
}
interface PipelineReceipt { id: string; kind: string; status: string; at: string; detail: Record<string, unknown>; }
interface InvocationReceipt { id: string; tool: string; status: string; at: string; durationMs: number | null;
  args: Record<string, unknown>; servingHost: string | null; servingProcess: string | null; servingSha: string | null;
  metadata?: Record<string, unknown> | null; }
interface CarrySourceAuthority { root: string; reviewedPaths: string[]; changedPaths: string[];
  auditedItems?: Array<{ itemId: string; auditSeq: number }>; }
interface CarrySourceMeasurement { contains: boolean | null; canonicalRoot?: string; canonicalCommit?: string;
  paths?: string[]; auditedItems?: CarrySourceAuthority['auditedItems']; }
export interface CarryShipmentReceipts {
  deployment: PipelineReceipt | null;
  promotions: PipelineReceipt[];
  invocations: InvocationReceipt[];
  report: { id: string; subjectKind: string; subjectRef: string; body: string; visibility: string; at: string } | null;
}
export interface CarryShipmentMeasurement {
  verdict: 'pass' | 'fail' | 'unknown';
  reason: string;
  scope: 'managed-carry-objective-shipment';
  lifecycle?: CarryDrillMeasurement;
  deployedSha?: string;
  reportId?: string;
  evidenceRefs?: string[];
  source?: CarrySourceMeasurement;
}

/** The deployment, promotion, serving identities and report all come from their writers' ledgers. */
export async function readCarryShipmentReceipts(input: CarryShipmentInput, sql: Sql = getOrgPg().sql): Promise<CarryShipmentReceipts> {
  const rows = await sql.unsafe(`
    SELECT
      (SELECT jsonb_build_object('id',id::text,'kind',kind,'status',status,'at',created_at,'detail',detail)
       FROM harness_shared.pipeline_events WHERE workspace_id=$1 AND install_slug=$2 AND id=$3::bigint) AS deployment,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id::text,'kind',kind,'status',status,'at',created_at,'detail',detail))
       FROM harness_shared.pipeline_events WHERE workspace_id=$1 AND install_slug=$2 AND kind='green_checkpoint'
       AND status IN ('advanced','advanced-prefix','up-to-date') AND created_at <= $6::timestamptz
       AND (detail->>'candidate' ~ '^[a-f0-9]{10,40}$' AND
         (SELECT detail->>'fullTargetSha' FROM harness_shared.pipeline_events WHERE workspace_id=$1 AND id=$3::bigint) LIKE (detail->>'candidate') || '%'
         OR detail->>'advancedTo' ~ '^[a-f0-9]{10,40}$' AND
         (SELECT detail->>'fullTargetSha' FROM harness_shared.pipeline_events WHERE workspace_id=$1 AND id=$3::bigint) LIKE (detail->>'advancedTo') || '%')), '[]'::jsonb) AS promotions,
      COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM (
        SELECT id::text,tool_name AS tool,status,invoked_at AS at,duration_ms AS "durationMs",args_json AS args,
          serving_host AS "servingHost",serving_process_id AS "servingProcess",serving_build_sha AS "servingSha",
          metadata_json AS metadata
        FROM harness_shared.tool_invocations WHERE workspace_id=$1 AND coord_owner_id=$4
        AND invoked_at BETWEEN $5::timestamptz AND $6::timestamptz
        AND tool_name IN ('session:carry-drill','session:end','reports:get','capability:read') ORDER BY invoked_at LIMIT 501
      ) i),'[]'::jsonb) AS invocations,
      (SELECT jsonb_build_object('id',report_id,'subjectKind',subject_kind,'subjectRef',subject_ref,'body',body_md,
        'visibility',visibility,'at',published_at) FROM harness_shared.report_library
       WHERE workspace_id=$1 AND report_id=$7 AND retired_at IS NULL) AS report`,
  [input.workspaceId, input.harnessSlug, input.deploymentId, input.ownerId, input.windowStart, input.windowEnd, input.reportId]);
  return rows[0] as unknown as CarryShipmentReceipts;
}

/** Reuse the code-truth audit and independent edit/commit attribution population. */
export async function readCarrySourceAuthority(input: CarryShipmentInput): Promise<CarrySourceAuthority | null> {
  return withWorkspace(input.workspaceId, async () => {
    const [{ loadHarnessRegistry, resolveHarnessContentPath }, { getEffectiveItemAudits, getPlanItemStatuses },
      { readAttributedAuditFiles }] = await Promise.all([
      import('./harness-registry'), import('./plan-audits'), import('./agent-tools/plans/audit-derived-citations'),
    ]);
    const [registry, items, audits] = await Promise.all([
      loadHarnessRegistry(), getPlanItemStatuses(input.planSlug, { harnessSlug: input.harnessSlug }),
      getEffectiveItemAudits(input.planSlug),
    ]);
    const root = resolveHarnessContentPath(registry, input.harnessSlug);
    const itemIds = items.filter(item => item.status !== 'dropped').map(item => item.itemId);
    if (!root || !itemIds.length || itemIds.some(id => !audits.some(audit => audit.entry.itemId === id))) return null;
    const reviewedPaths = audits.filter(audit => itemIds.includes(audit.entry.itemId))
      .flatMap(audit => audit.entry.citations.flatMap(citation => citation.path ? [citation.path] : []));
    const changed = await readAttributedAuditFiles({ ...input, itemIds });
    // The attribution reader caps at 5000. Hitting that ceiling cannot certify completeness.
    if (changed.length >= 5000) return null;
    return { root, reviewedPaths, changedPaths: changed.map(file => file.path),
      auditedItems: audits.filter(audit => itemIds.includes(audit.entry.itemId))
        .map(audit => ({ itemId: audit.entry.itemId, auditSeq: audit.auditSeq })) };
  });
}

async function containsCarrySource(sha: string, input: CarryShipmentInput,
  readAuthority = readCarrySourceAuthority): Promise<CarrySourceMeasurement> {
  const unknown = { contains: null };
  const authority = await readAuthority(input);
  if (!authority) return unknown;
  const paths = [...new Set(authority.reviewedPaths)].sort();
  const validPath = (path: string) => !!path && !path.includes('\\') && !posix.isAbsolute(path) &&
    posix.normalize(path) === path && path !== '..' && !path.startsWith('../');
  if (!paths.length || !paths.every(validPath) ||
      [...CARRY_SHIPMENT_SOURCE_PATHS, ...authority.changedPaths].some(path => !validPath(path) || !paths.includes(path))) return unknown;
  // Never use the evaluator's checkout: a deployed module can agree with itself while staging differs.
  const git = promisify(execFile), cwd = authority.root;
  const run = (args: string[]) => git('git', args, { cwd, timeout: 10_000, maxBuffer: 100_000 });
  try {
    const canonicalCommit = (await run(['rev-parse', 'HEAD'])).stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(canonicalCommit)) return unknown;
    const dirty = await run(['status', '--porcelain', '--', ...paths]);
    if (dirty.stdout.trim()) return unknown;
    const tracked = new Set((await run(['ls-tree', '-r', '--name-only', canonicalCommit, '--', ...paths])).stdout.trim().split('\n'));
    if (paths.some(path => !tracked.has(path))) return unknown;
    const diff = await run(['diff', '--name-only', canonicalCommit, sha, '--', ...paths]);
    if ((await run(['rev-parse', 'HEAD'])).stdout.trim() !== canonicalCommit) return unknown;
    return { contains: !diff.stdout.trim(), canonicalRoot: cwd, canonicalCommit, paths,
      ...(authority.auditedItems ? { auditedItems: authority.auditedItems } : {}) };
  } catch { return unknown; }
}

export async function measureCarryDrillShipment(input: CarryShipmentInput, deps: {
  lifecycle?: typeof measureCarryDrillLifecycle;
  receipts?: typeof readCarryShipmentReceipts;
  containsSource?: (sha: string) => Promise<boolean | null>;
  sourceAuthority?: typeof readCarrySourceAuthority;
  hostEvents?: (ownerId: string) => Promise<ColdBootDrillHostEvent[]>;
  hostGone?: (ownerId: string) => Promise<boolean>;
} = {}): Promise<CarryShipmentMeasurement> {
  const result = (verdict: CarryShipmentMeasurement['verdict'], reason: string,
    extra: Partial<CarryShipmentMeasurement> = {}): CarryShipmentMeasurement => ({
    verdict, reason, scope: 'managed-carry-objective-shipment', ...extra,
  });
  if (input.planSlug !== CARRY_SHIPMENT_PLAN || input.harnessSlug !== 'papercusp' || !input.workspaceId ||
      !/^[1-9][0-9]*$/.test(input.deploymentId) || !input.reportId?.trim())
    return result('unknown', 'Exact carry plan, workspace, deployment and durable report selections are required.');
  try {
    const lifecycle = await (deps.lifecycle ?? measureCarryDrillLifecycle)(input);
    if (lifecycle.verdict !== 'pass') return result(lifecycle.verdict, lifecycle.reason, { lifecycle });
    const receipts = await (deps.receipts ?? readCarryShipmentReceipts)(input);
    if (!receipts || receipts.invocations.length > 500) return result('unknown', 'Receipt population missing or exceeds the bounded reader.');
    const deploy = receipts.deployment, sha = deploy?.detail?.fullTargetSha;
    if (!deploy || typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) return result('unknown', 'Exact full deployment artifact identity is missing.');
    if (deploy.kind !== 'deploy' || deploy.status !== 'ok') return result('fail', 'The selected deployment was not successful.');
    const sameSha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{10,40}$/.test(value) && sha.startsWith(value);
    const green = receipts.promotions.find(row => row.kind === 'green_checkpoint' &&
      ((['advanced','up-to-date'].includes(row.status) && sameSha(row.detail.candidate)) ||
       (row.status === 'advanced-prefix' && sameSha(row.detail.advancedTo))) && Date.parse(row.at) <= Date.parse(deploy.at));
    if (!green) return result('unknown', 'No normal green promotion receipt for this exact deployed artifact.');
    const source = deps.containsSource ? { contains: await deps.containsSource(sha) }
      : await containsCarrySource(sha, input, deps.sourceAuthority);
    if (source.contains !== true) return result(source.contains === false ? 'fail' : 'unknown',
      'Deployed artifact does not prove the reviewed canonical carry source population.', { source });
    const invocations = receipts.invocations;
    const starts = invocations.filter(row => row.tool === 'session:carry-drill' && row.args?.op === 'start');
    if (starts.length !== 1) return result('unknown', 'Exactly one native start receipt must select this bounded subject window.');
    const start = starts[0];
    const requestedAt = Date.parse(lifecycle.requestedAt ?? '');
    // The invocation writer stamps dispatch SETTLE time, not start time.
    if (!Number.isFinite(requestedAt) || start.durationMs == null ||
        requestedAt < Date.parse(start.at) - start.durationMs - 1000 || requestedAt > Date.parse(start.at))
      return result('unknown', 'The selected durable request is not tied to this native start invocation.');
    if (start.status !== 'ok' || start.servingHost !== 'port-3070' || !start.servingProcess || !sameSha(start.servingSha) ||
        Date.parse(deploy.at) > Date.parse(start.at)) return result('fail', 'The drill was not served by the selected deployed operator artifact.');
    for (const op of ['grade','verify','report']) {
      const calls = invocations.filter(row => row.tool === 'session:carry-drill' && row.args?.op === op &&
        (op === 'report' || row.args?.drillId === input.drillId));
      if (!calls.length) return result('unknown', `Native ${op} receipt missing.`);
      if (op === 'grade' && calls.length !== 1) return result('fail', 'Native grade receipt is not exactly once.');
      if (calls.some(row => row.status !== 'ok' || row.servingHost !== start.servingHost ||
          row.servingProcess !== start.servingProcess || !sameSha(row.servingSha)))
        return result('fail', `The ${op} receipt changed deployed build/process or failed.`);
    }
    const report = receipts.report;
    if (!report) return result('unknown', 'Durable report is absent.');
    if (report.subjectKind !== 'plan' || report.subjectRef !== input.planSlug || report.visibility !== 'owner' ||
        ![input.ownerId,input.drillId,sha].every(value => report.body.includes(value)))
      return result('fail', 'The durable owner report does not identify the exact plan, drill and artifact.');
    const reportCalls = invocations.filter(row => row.tool === 'session:carry-drill' && row.args?.op === 'report');
    if (!Number.isFinite(Date.parse(report.at)) || Date.parse(report.at) > Date.parse(input.windowEnd) ||
        reportCalls.some(row => Date.parse(row.at) > Date.parse(report.at)))
      return result('fail', 'The durable report does not follow the selected native report call within the observation window.');
    const readbacks = invocations.filter(row => row.tool === 'reports:get' && row.status === 'ok' &&
      row.metadata?.resultOutcome !== 'soft-failure' &&
      (row.args?.id === report.id || row.args?.report_id === report.id) && Date.parse(row.at) >= Date.parse(report.at) &&
      Array.isArray(row.metadata?.reportReadbacks) && row.metadata.reportReadbacks.some(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const read = value as Record<string, unknown>;
        return read.id === report.id && read.bodySha256 === reportBodySha256(report.body) &&
          read.bodyBytes === Buffer.byteLength(report.body, 'utf8') && read.visibility === report.visibility &&
          typeof read.publishedAt === 'string' && Date.parse(read.publishedAt) === Date.parse(report.at);
      }));
    if (!readbacks.length)
      return result('unknown', 'Successful complete native report edition readback is not proven.');
    const edition = { id: report.id, bodySha256: reportBodySha256(report.body),
      bodyBytes: Buffer.byteLength(report.body, 'utf8'), visibility: report.visibility, publishedAt: report.at };
    const deliveries = readbacks.flatMap(row => {
      const at = completeReportDeliveryAt(row.metadata, edition, invocations.filter(call => call.tool === 'capability:read'),
        Math.max(Date.parse(report.at), Date.parse(row.at)), Date.parse(input.windowEnd));
      return at == null ? [] : [at];
    });
    if (!deliveries.length) return result('unknown', 'Complete final report delivery or complete hash-bound spill consumption is not proven.');
    const cleanup = invocations.find(row => row.tool === 'session:end' && row.status === 'ok' && Date.parse(row.at) >= Date.parse(report.at));
    const host = await (deps.hostEvents ?? (owner => readOwnerHostEvents(owner, undefined, { requireComplete: true })))(input.ownerId);
    const shutdown = host.find(row => row.kind === 'shutdown-accepted' && row.ts && Date.parse(row.ts) >= Date.parse(report.at));
    const teardown = host.find(row => row.kind === 'host-teardown' && row.ts && shutdown?.ts && Date.parse(row.ts) >= Date.parse(shutdown.ts));
    if (!cleanup || !shutdown || !teardown) return result('unknown', 'Supported cleanup invocation, accepted shutdown and host teardown receipts are required.');
    if (!shutdown.ts || !teardown.ts || cleanup.durationMs == null ||
        Date.parse(shutdown.ts) < Date.parse(cleanup.at) - cleanup.durationMs - 1000 ||
        Date.parse(teardown.ts) > Date.parse(input.windowEnd))
      return result('fail', 'Cleanup receipts do not follow their native invocation within the observation window.');
    // Invocation timestamps record completion. Readback must finish before cleanup begins.
    const cleanupStartedAt = Date.parse(cleanup.at) - cleanup.durationMs;
    if (!deliveries.some(at => at <= cleanupStartedAt && at <= Date.parse(shutdown.ts!)))
      return result('fail', 'Native report readback did not complete before supported cleanup began.');
    if (!(await (deps.hostGone ?? (async owner => !(await findLiveHostAsync(owner))))(input.ownerId)))
      return result('fail', 'The disposable host is still live after its cleanup receipt.');
    return result('pass', 'Objective deployed carry, native lifecycle, durable report/readback and supported cleanup receipts verified.',
      { lifecycle, source, deployedSha: sha, reportId: report.id, evidenceRefs: [`pipeline-event:${deploy.id}`, `pipeline-event:${green.id}`,
        `report:${report.id}`, ...invocations.map(row => `tool-invocation:${row.id}`)] });
  } catch (error) { return result('unknown', `Native shipment evidence unavailable: ${String(error)}`); }
}
