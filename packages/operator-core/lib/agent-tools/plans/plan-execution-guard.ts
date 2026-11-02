/** EI-27540173897381380: plan readiness also binds direct implementation writes. */
import { createRequire } from 'node:module';
import { getOrgPg } from '@papercusp/db-org';
import { runWithWorkspace } from '../../workspace-als';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { parsePlan } from './parser';
import { getPlanRow } from './source';
import { planExecutionMeaning } from './plan-execution-meaning';
export { planExecutionMeaning } from './plan-execution-meaning';

// The installed parser has no bundled declarations. Treat its tokens as unknown
// and validate the small token vocabulary this read-only boundary accepts.
const parseShell: (command: string) => unknown[] = createRequire(import.meta.url)('shell-quote').parse;

export interface ExecutionPlanBinding { planSlug: string; harnessSlug: string | null }
export interface PlanExecutionRefusal {
  code: 'plan_execution_not_ready';
  reason: string;
  planSlug?: string;
  blockers: string[];
}
export interface PlanExecutionGuardInput {
  ownerId: string; workspaceId: string; toolName: string; args: unknown;
}
export interface PlanExecutionGuardDeps {
  readBindings: (ownerId: string, workspaceId: string) => Promise<ExecutionPlanBinding[]>;
  checkPlan: (binding: ExecutionPlanBinding, workspaceId: string) => Promise<string[]>;
}

const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'edit', 'write', 'apply_patch', 'capability:edit',
  'capability:write', 'locks:acquire', 'locks:acquire_granular']);
const shellTools = new Set(['Bash', 'bash', 'exec_command', 'shell_command', 'shell', 'capability:bash']);
const executionTools = new Set(['code:run', 'capability:terminal', 'capability:git', 'templates:new-app',
  'capability:launch-agent', 'fleet:launch-on-plan', 'plans:launch', 'plans:run-now', 'plans:arm-schedule']);
const readCommands = new Set(['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'readlink', 'realpath']);

/** A deliberately small read-only shell subset; arbitrary interpreters require activation. */
export function isPlanResearchCommand(command: unknown): boolean {
  if (typeof command !== 'string' || /[$`\n\r]/.test(command)) return false;
  try {
    const tokens = parseShell(command);
    let needsCommand = true;
    for (const token of tokens) {
      if (typeof token !== 'string') {
        if (token && typeof token === 'object' && 'op' in token && typeof token.op === 'string'
          && ['|', '&&', ';'].includes(token.op)) {
          if (needsCommand) return false;
          needsCommand = true;
        } else return false;
      } else if (needsCommand) {
        if (!readCommands.has(token)) return false;
        needsCommand = false;
      } else if (/^--(?:pre|hostname-bin)(?:=|$)/.test(token)) return false;
    }
    return tokens.length > 0 && !needsCommand;
  } catch { return false; }
}

export function isPlanImplementationCall(toolName: string, args: unknown): boolean {
  const name = toolName.replace(/^functions\./, '').replace(/^mcp__.+?__/, '').replace(/^capability_/, 'capability:');
  if (name === 'write_stdin') {
    const chars = (args as { chars?: unknown } | null)?.chars;
    return typeof chars === 'string' && chars.length > 0;
  }
  if (fileTools.has(name) || executionTools.has(name)) return true;
  if (!shellTools.has(name)) return false;
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  return !isPlanResearchCommand(input.command ?? input.cmd);
}

/** Read durable authority, never coord_presence or caller-supplied plan/force/purpose. */
export async function readExecutionPlanBindings(ownerId: string, workspaceId: string): Promise<ExecutionPlanBinding[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ plan_slug: string; harness_slug: string | null }>>`
    SELECT current_plan_slug AS plan_slug, harness_slug
      FROM harness_shared.session_briefs WHERE owner_id=${ownerId} AND workspace_id=${workspaceId}
    UNION
    SELECT control_state #>> '{scope,plan}', control_state #>> '{scope,harness}'
      FROM harness_shared.session_briefs WHERE owner_id=${ownerId} AND workspace_id=${workspaceId}
    UNION
    SELECT plan_slug, NULL::text FROM harness_shared.adv_sessions
      WHERE coord_owner_id=${ownerId} AND workspace_id=${workspaceId} AND plan_slug IS NOT NULL
        AND ended_at IS NULL
    UNION
    SELECT plan_slug, harness_slug FROM harness_shared.plan_item_claims
      WHERE owner=${ownerId} AND workspace_id=${workspaceId}
    UNION
    SELECT source_plan_slug, harness_slug FROM harness_shared.work_items
      WHERE taken_by=${ownerId} AND workspace_id=${workspaceId} AND source_plan_slug IS NOT NULL
        AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))`;
  return rows.filter(row => typeof row.plan_slug === 'string' && row.plan_slug.trim())
    .map(row => ({ planSlug: row.plan_slug, harnessSlug: row.harness_slug }));
}

export async function checkExecutionPlan(binding: ExecutionPlanBinding, workspaceId: string): Promise<string[]> {
  const { readPlanExecutionStart } = await import('./plan-execution-authority');
  const proof = await readPlanExecutionStart(binding, workspaceId);
  if (proof.length) return proof;
  return checkPlanExecutionReadiness(binding, workspaceId);
}

/** Current policy is required both when issuing authority and on every use. */
export async function checkPlanExecutionReadiness(binding: ExecutionPlanBinding, workspaceId: string): Promise<string[]> {
  return runWithWorkspace(workspaceId, async () => {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ harness_slug: string; content: string; content_hash: string; op_status: string | null }>>`
      SELECT harness_slug, content, content_hash, op_status FROM harness_shared.harness_plans
       WHERE workspace_id=${workspaceId} AND plan_slug=${binding.planSlug}
         AND (${binding.harnessSlug}::text IS NULL OR harness_slug=${binding.harnessSlug})`;
    if (rows.length !== 1) return [rows.length ? 'plan_scope_ambiguous' : 'bound_plan_missing'];
    const row = rows[0]!;
    const opts = { harnessSlug: row.harness_slug, workspaceId };
    const plan = await getPlanRow(binding.planSlug, opts);
    if (!plan || plan.contentHash !== row.content_hash) return ['plan_revision_changed'];
    const parsed = parsePlan(plan.content);
    if (!['ready', 'active', 'awaiting-acceptance'].includes(parsed.frontmatter.status ?? ''))
      return [`plan_status:${parsed.frontmatter.status ?? 'unknown'}`];
    const scope = { workspaceId, harnessSlug: row.harness_slug, planSlug: binding.planSlug };
    const { evaluateConversationActivationGate } = await import('./plan-activation-gate');
    const activation = await evaluateConversationActivationGate(sql as never, scope);
    if (!activation.satisfied) return [activation.code ?? 'conversation_audit_required'];
    const audits = await sql<Array<{ audited_plan_content_hash: string | null; content_snapshot: string | null }>>`
      SELECT a.audited_plan_content_hash, r.content_snapshot
        FROM harness_shared.plan_audits a
        LEFT JOIN harness_shared.plan_revisions r ON r.id=a.audited_plan_revision_id
          AND r.workspace_id=a.workspace_id AND r.harness_slug=a.harness_slug AND r.plan_slug=a.plan_slug
       WHERE a.workspace_id=${workspaceId} AND a.harness_slug=${row.harness_slug} AND a.plan_slug=${binding.planSlug}
         AND a.audit_kind='activation' ORDER BY a.audit_seq DESC LIMIT 1`;
    const audit = audits[0];
    // Preserve the canonical gate's explicit legacy/template exemptions, not an ad-hoc override.
    if (!activation.grandfathered) {
      if (!audit?.audited_plan_content_hash) return ['activation_revision_unmeasured'];
      if (audit.audited_plan_content_hash !== row.content_hash &&
        (!audit.content_snapshot || planExecutionMeaning(audit.content_snapshot) !== planExecutionMeaning(plan.content)))
        return ['activation_audit_stale'];
    }
    const [{ evaluatePlanStartReadiness }, { readAndEvaluateAcceptanceBarLifecycle },
      { checkPlanAdmission }, { withPinnedPlanTypes }, { checkPlanStartable },
      { evaluatePlanSpecQualityGate }, { evaluatePlanStartBarCritique }, { specQualityPlanItemIds },
      { validatePlanCandidateDependencies }] = await Promise.all([
      import('./plan-input-validation'), import('../../acceptance-bar-lifecycle-evaluator'),
      import('./plan-admission-gate'), import('../../plan-types/pins'),
      import('./plan-start-gate'), import('./plan-spec-quality-gate'), import('./plan-start-critique-gate'),
      import('./spec-quality'),
      import('./plan-candidate-dependencies'),
    ]);
    const dependencies = validatePlanCandidateDependencies(parsed, 'started');
    if (dependencies.state === 'rejected' || dependencies.state === 'invalid-draft') return ['plan_dependencies_invalid'];
    const gate = await checkPlanStartable(binding.planSlug, opts, null, 'start');
    if (!gate.ok) return [gate.refusal.code];
    const items = plan.items.length ? plan.items : parsed.items;
    const quality = await evaluatePlanSpecQualityGate({ harnessSlug: row.harness_slug,
      planSlug: binding.planSlug, planItemIds: specQualityPlanItemIds(items), planItems: items });
    if (!quality.satisfied) return [quality.code ?? 'spec_quality_not_current'];
    if (quality.applicable) {
      const critique = await evaluatePlanStartBarCritique({ workspaceId, harnessSlug: row.harness_slug,
        planSlug: binding.planSlug, nonDroppedItemCount: specQualityPlanItemIds(items).length,
        contractEnforced: quality.mode === 'enforced' });
      if (critique?.mode === 'enforced' && !critique.verdict.satisfied)
        return [critique.verdict.code ?? 'critique_missing'];
    }
    const inputs = evaluatePlanStartReadiness({ template: plan.template, inputSchema: plan.inputSchema }, plan.templateData);
    if (!inputs.ready) return [inputs.code];
    const bars = await withPinnedPlanTypes(scope, () => readAndEvaluateAcceptanceBarLifecycle(binding.planSlug,
      'pre-start', { harnessSlug: row.harness_slug, requireCompleteContractBeforeProof: true }));
    if (!bars.satisfied) return bars.codes.length ? bars.codes : ['acceptance_bar_contract_not_ready'];
    const admission = await checkPlanAdmission({ slug: binding.planSlug, door: 'run-now', opts, row: plan });
    return admission.admitted ? [] : [admission.refusal.code];
  });
}

export async function checkPlanExecutionGuard(input: PlanExecutionGuardInput,
  deps: PlanExecutionGuardDeps = { readBindings: readExecutionPlanBindings, checkPlan: checkExecutionPlan },
): Promise<PlanExecutionRefusal | null> {
  if (!isPlanImplementationCall(input.toolName, input.args)) return null;
  try {
    const bindings = await deps.readBindings(input.ownerId, input.workspaceId);
    for (const binding of bindings) {
      const blockers = await deps.checkPlan(binding, input.workspaceId);
      if (blockers.length) return { code: 'plan_execution_not_ready', planSlug: binding.planSlug, blockers,
        reason: `Plan '${binding.planSlug}' is not executable (${blockers.join(', ')}). Implementation writes are refused. `
          + 'Repair the plan with plans:edit/audit and finish the standard plans:start process first. '
          + 'Read-only research and canonical plan repair remain available; an ad-hoc item, AUTO or force does not waive activation.' };
    }
    return null;
  } catch {
    return { code: 'plan_execution_not_ready', blockers: ['plan_authority_unavailable'],
      reason: 'Plan execution authority could not be read; implementation writes are refused. Use read-only tools or repair plan authority, then retry.' };
  }
}
