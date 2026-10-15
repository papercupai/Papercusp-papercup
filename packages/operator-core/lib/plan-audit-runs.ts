/** Audit execution metadata and large payloads reuse text artifacts; completed
 * snapshots reuse the immutable Reports library. No subject lifecycle writer. */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { saveTextArtifact } from './text-artifacts';
import { publishReport } from './report-library';
import { runUnshippedPlansAudit } from './unshipped-plans-audit';
import { activeWorkspaceId } from './workspace-registry';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';

export type PlanAuditScope = 'single' | 'visible' | 'workspace';
export interface PlanAuditRun {
  schemaVersion: 1;
  id: string;
  workspace: string;
  harness: string;
  scope: PlanAuditScope;
  planSlugs?: string[];
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  reportId?: string;
  rowCount?: number;
}
const PREFIX = 'reports/plan-audits/';
export const PLAN_AUDIT_RUN_TIMEOUT_MS = 300000;
export function planAuditUiPath(id: string): string {
  return '/adv?opcv=plans&paudit=' + encodeURIComponent(id);
}
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const running = new Map<string, Promise<void>>();

export function validateAuditRequest(input: unknown): { scope: PlanAuditScope; planSlugs?: string[] } {
  if (!input || typeof input !== 'object') throw new Error('Audit request must be an object');
  const value = input as Record<string, unknown>;
  if (!['single', 'visible', 'workspace'].includes(String(value.scope))) throw new Error('Choose single, visible, or workspace audit scope');
  const scope = value.scope as PlanAuditScope;
  if (scope === 'workspace') {
    if (value.planSlugs !== undefined) throw new Error('Workspace scope must not carry a selected population');
    return { scope };
  }
  if (!Array.isArray(value.planSlugs) || !value.planSlugs.length || value.planSlugs.length > 10000 || value.planSlugs.some(s => typeof s !== 'string' || !s.trim() || s.length > 300)) throw new Error('Selected scope requires 1–10000 valid plan slugs');
  const planSlugs = [...new Set((value.planSlugs as string[]).map(s => s.trim()))];
  if (scope === 'single' && planSlugs.length !== 1) throw new Error('Single-plan scope requires exactly one plan');
  return { scope, planSlugs };
}

function artifactPath(id: string, file: string): string {
  if (!idPattern.test(id)) throw new Error('Invalid audit run id');
  return PREFIX + id + '/' + file;
}
async function save(run: PlanAuditRun): Promise<void> {
  await saveTextArtifact(run.harness, artifactPath(run.id, 'run.json'), JSON.stringify(run));
}
/** Explicit workspace predicate: the generic artifact loader is harness-only. */
export async function readAuditArtifact(id: string, file: 'run.json' | 'report.html' | 'audit.json'): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_text_artifacts
    WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = ${operatorHomeHarnessSlug()}
      AND rel_path = ${artifactPath(id, file)} LIMIT 1`;
  return rows[0]?.content ?? null;
}
export async function getPlanAuditRun(id: string): Promise<PlanAuditRun | null> {
  const raw = await readAuditArtifact(id, 'run.json');
  if (!raw) return null;
  const run = JSON.parse(raw) as PlanAuditRun;
  if (run.id !== id || run.workspace !== activeWorkspaceId() || run.harness !== operatorHomeHarnessSlug()) throw new Error('Audit run identity mismatch');
  // A server crash cannot leave a forever-running success-shaped record.
  if (run.status === 'running' && Date.now() - Date.parse(run.startedAt) > PLAN_AUDIT_RUN_TIMEOUT_MS + 60000) {
    run.status = 'failed';run.error = 'Audit execution was interrupted or exceeded its deadline. Retry creates a new snapshot.';run.finishedAt = new Date().toISOString();
    await save(run);
  }
  return run;
}
export async function listPlanAuditRuns(): Promise<PlanAuditRun[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_text_artifacts
    WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = ${operatorHomeHarnessSlug()}
      AND rel_path LIKE 'reports/plan-audits/%/run.json'
    ORDER BY updated_at DESC LIMIT 30`;
  return rows.map(row => JSON.parse(row.content) as PlanAuditRun);
}

export async function startPlanAudit(input: unknown): Promise<PlanAuditRun> {
  const selection = validateAuditRequest(input);
  const run: PlanAuditRun = { schemaVersion: 1, id: randomUUID(), workspace: activeWorkspaceId(), harness: operatorHomeHarnessSlug(), ...selection, status: 'running', startedAt: new Date().toISOString() };
  await save(run); // durable BEFORE returning a run id or starting execution
  const task = executePlanAudit(run).finally(() => running.delete(run.id));
  running.set(run.id, task);
  // executePlanAudit records a failed terminal result. Failure to record it is
  // logged, not converted into success; the persisted deadline guard recovers it.
  void task.catch(error => console.error('Could not persist audit execution outcome', run.id, error));
  return run;
}

export async function executePlanAudit(run: PlanAuditRun): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runUnshippedPlansAudit({ workspaceId: run.workspace, artifactHarness: run.harness, planSlugs: run.planSlugs, includeHistorical: true, artifactPrefix: PREFIX + run.id }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Audit generation exceeded five minutes; retry creates a new snapshot.')), PLAN_AUDIT_RUN_TIMEOUT_MS);timer.unref?.(); }),
    ]);
    const report = await publishReport(getOrgPg().sql, {
      workspaceId: run.workspace, kind: 'audit', title: 'Plan audit · ' + run.scope + ' · ' + run.startedAt,
      summary: result.manifest.rows.length + ' plans inspected; point-in-time, read-only ledger/evidence audit.',
      subject: run.scope === 'single' ? { kind: 'plan', ref: run.planSlugs![0] } : { kind: 'pot', ref: run.harness },
      visibility: 'owner', source: 'owner', tags: ['plan-audit'],
      bodyMd: '# Plan audit\n\n[Open the navigable audit workspace](' + planAuditUiPath(run.id) + ')\n\nSnapshot: ' + result.manifest.generatedAt + '\n\nFull evidence: ' + result.artifacts.json + '\n\nNo plan lifecycle, assignment, claim, or blocker was changed. Stored test histories are not fresh test runs.',
    }, { harnessSlug: run.harness });
    await save({ ...run, status: 'complete', finishedAt: new Date().toISOString(), rowCount: result.manifest.rows.length, reportId: report.reportId });
  } catch (error) {
    await save({ ...run, status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
