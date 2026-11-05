/** EI-27540173897381380: plan readiness also binds direct implementation writes. */
import { createRequire } from 'node:module';
import { getOrgPg } from '@papercusp/db-org';
import { runWithWorkspace } from '../../workspace-als';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { parsePlan } from './parser';
import { getPlanRow } from './source';
import { planExecutionMeaning } from './plan-execution-meaning';
import type { ResolvedGoal } from '../../agent-goal-ref';
import type { AcceptanceBarSnapshotSource } from '../../acceptance-bar-contract-snapshot';
export { planExecutionMeaning } from './plan-execution-meaning';

// The installed parser has no bundled declarations. Treat its tokens as unknown
// and validate the small token vocabulary this read-only boundary accepts.
const parseShell: (command: string) => unknown[] = createRequire(import.meta.url)('shell-quote').parse;

export type ExecutionPlanBindingSource =
  | 'session-brief'
  | 'control-state'
  | 'active-session'
  | 'plan-item-claim'
  | 'work-item';
export interface ExecutionPlanBinding {
  planSlug: string;
  harnessSlug: string | null;
  source?: ExecutionPlanBindingSource;
  sourceRef?: string | null;
}
export interface PlanExecutionRefusal {
  code: 'plan_execution_not_ready';
  reason: string;
  planSlug?: string;
  blockers: string[];
}
export interface PlanExecutionGuardInput {
  ownerId: string; workspaceId: string; toolName: string; args: unknown;
  observeTiming?: PlanExecutionTimingObserver;
}
export interface PlanExecutionTiming { stage: string; durationMs: number }
export type PlanExecutionTimingObserver = (timing: PlanExecutionTiming) => void;

/** Diagnostics must never grant, refuse, or interrupt an authority check. */
async function measurePlanStage<T>(stage: string, observe: PlanExecutionTimingObserver | undefined,
  read: () => Promise<T>): Promise<T> {
  if (!observe) return read();
  const startedAt = performance.now();
  try { return await read(); } finally {
    try { observe({ stage, durationMs: performance.now() - startedAt }); } catch { /* diagnostics only */ }
  }
}

/** Settle concurrent reads before interpreting them in the original refusal order. */
function settledPlanValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
export interface ExecutionPlanGoalResolution {
  goal: ResolvedGoal | null;
  diagnostics: readonly unknown[];
}
export interface PlanExecutionGuardDeps {
  readBindings: (ownerId: string, workspaceId: string) => Promise<ExecutionPlanBinding[]>;
  resolveGoal?: (ownerId: string, workspaceId: string, observe?: PlanExecutionTimingObserver) => Promise<ExecutionPlanGoalResolution>;
  checkPlan: (binding: ExecutionPlanBinding, workspaceId: string, observe?: PlanExecutionTimingObserver) => Promise<string[]>;
}

const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'edit', 'write', 'apply_patch', 'capability:edit',
  'capability:write', 'locks:acquire', 'locks:acquire_granular']);
const shellTools = new Set(['Bash', 'bash', 'exec_command', 'shell_command', 'shell', 'capability:bash']);
const executionTools = new Set(['code:run', 'capability:terminal', 'capability:git', 'templates:new-app',
  'capability:launch-agent', 'fleet:launch-on-plan', 'plans:launch', 'plans:run-now', 'plans:arm-schedule']);
const readCommands = new Set(['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'readlink', 'realpath']);

/** A deliberately small read-only shell subset; arbitrary interpreters require activation. */
export function isPlanResearchCommand(command: unknown): boolean {
  if (isPlanPtoolReadCommand(command)) return true;
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

const readOnlyPtoolTools = new Set([
  'tools:find', 'plans:get', 'plans:items', 'work_items:get', 'reports:get',
  'consult:get_feedback', 'conversations:get', 'coord:inbox', 'coord:read', 'docs:get', 'docs:search',
]);

/**
 * Recognize only a single ptool JSON call with a quoted heredoc. Its body is
 * inert data; the exact target verb is checked against a narrow allowlist below.
 */
function ptoolJsonHeredocTool(command: unknown): string | null {
  if (typeof command !== 'string' || command.length > 32_768 || command.includes('\0')) return null;
  const normalized = command.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) return null;
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 3) return null;

  const header = lines.shift()!;
  const closingDelimiter = lines.pop()!;
  const match = /^ptool[ \t]+([a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*)[ \t]+--json[ \t]+-((?:[ \t]+--(?:workspace|harness)=(?:"[A-Za-z0-9._-]+"|'[A-Za-z0-9._-]+'|[A-Za-z0-9._-]+))*)[ \t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(header);
  if (!match || closingDelimiter !== match[3] || lines.includes(match[3])) return null;

  try {
    const payload: unknown = JSON.parse(lines.join('\n'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (match[1] !== 'tools:invoke') return match[1];
    const nested = payload as Record<string, unknown>;
    if (Object.keys(nested).some(key => !['name', 'args', 'projection'].includes(key))) return null;
    return typeof nested.name === 'string' && nested.args && typeof nested.args === 'object' && !Array.isArray(nested.args)
      ? nested.name : null;
  } catch {
    return null;
  }
}

function isPlanPtoolReadCommand(command: unknown): boolean {
  const tool = ptoolJsonHeredocTool(command);
  return tool !== null && readOnlyPtoolTools.has(tool);
}

function isPlanPtoolConsultControl(command: unknown): boolean {
  const tool = ptoolJsonHeredocTool(command);
  return tool === 'consult:reply' || tool === 'consult:decline';
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
  const command = input.command ?? input.cmd;
  return !isPlanResearchCommand(command) &&
    !isPlanPtoolReadCommand(command) &&
    !isPlanPtoolConsultControl(command);
}

/** Read durable authority, never coord_presence or caller-supplied plan/force/purpose. */
export async function readExecutionPlanBindings(ownerId: string, workspaceId: string): Promise<ExecutionPlanBinding[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{
    plan_slug: string | null;
    harness_slug: string | null;
    source: ExecutionPlanBindingSource;
    source_ref: string | null;
  }>>`
    SELECT current_plan_slug AS plan_slug, harness_slug, 'session-brief'::text AS source,
           current_plan_slug AS source_ref
      FROM harness_shared.session_briefs
     WHERE owner_id=${ownerId} AND workspace_id=${workspaceId} AND current_plan_slug IS NOT NULL
    UNION ALL
    SELECT control_state #>> '{scope,plan}', control_state #>> '{scope,harness}',
           'control-state'::text, control_state #>> '{scope,plan}'
      FROM harness_shared.session_briefs
     WHERE owner_id=${ownerId} AND workspace_id=${workspaceId}
       AND control_state #>> '{scope,plan}' IS NOT NULL
    UNION ALL
    SELECT plan_slug, NULL::text, 'active-session'::text, plan_slug
      FROM harness_shared.adv_sessions
     WHERE coord_owner_id=${ownerId} AND workspace_id=${workspaceId} AND plan_slug IS NOT NULL
       AND ended_at IS NULL
    UNION ALL
    SELECT plan_slug, harness_slug, 'plan-item-claim'::text, plan_slug || '#' || item_id
      FROM harness_shared.plan_item_claims
     WHERE owner=${ownerId} AND workspace_id=${workspaceId}
    UNION ALL
    SELECT source_plan_slug, harness_slug, 'work-item'::text, feature_id
      FROM harness_shared.work_items
     WHERE taken_by=${ownerId} AND workspace_id=${workspaceId}
       AND source_plan_slug IS NOT NULL
       AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))`;
  return rows.filter(row => typeof row.plan_slug === 'string' && row.plan_slug.trim())
    .map(row => ({
      planSlug: row.plan_slug!,
      harnessSlug: row.harness_slug,
      source: row.source,
      sourceRef: row.source_ref,
    }));
}

function uniquePlanBindings(bindings: readonly ExecutionPlanBinding[]): ExecutionPlanBinding[] {
  const unique = new Map<string, ExecutionPlanBinding>();
  for (const binding of bindings) {
    const key = JSON.stringify([binding.planSlug, binding.harnessSlug]);
    unique.set(key, { planSlug: binding.planSlug, harnessSlug: binding.harnessSlug });
  }
  return [...unique.values()];
}

/** Narrow enforcement by source identity only when the resolver and binding census agree. */
export function selectExecutionPlanBindings(
  bindings: readonly ExecutionPlanBinding[],
  goal: ResolvedGoal | null,
): ExecutionPlanBinding[] {
  if (!goal || goal.source === 'fleet-mission' ||
      bindings.some(binding => !binding.source || !binding.sourceRef)) {
    return uniquePlanBindings(bindings);
  }

  const selectedRefs = new Set([goal.ref, goal.corroboratedBy].filter((ref): ref is string => Boolean(ref)));
  const selectedPlanSlugs = new Set<string>();
  for (const binding of bindings) {
    if (binding.sourceRef && selectedRefs.has(binding.sourceRef)) selectedPlanSlugs.add(binding.planSlug);
  }
  // A declared plan-slug override is itself a resolvable pointer. Work-item
  // overrides match their sourceRef above, while plan-item overrides match their
  // exact ref and contribute the plan slug from that binding.
  if (goal.source === 'author-override') {
    for (const binding of bindings) {
      if (binding.planSlug === goal.ref) selectedPlanSlugs.add(binding.planSlug);
    }
  }

  const selected = bindings.filter(binding =>
    Boolean(binding.sourceRef && selectedRefs.has(binding.sourceRef)) ||
    selectedPlanSlugs.has(binding.planSlug));
  // A plan-item or authored override without matching durable binding evidence is
  // ambiguous. Keep the full census so the guard cannot turn a stale/missing
  // selected binding into permission.
  if (selected.length === 0 && (goal.source === 'plan-item' || goal.source === 'author-override')) {
    return uniquePlanBindings(bindings);
  }
  return uniquePlanBindings(selected);
}

async function readExecutionPlanGoal(ownerId: string, workspaceId: string,
  observe?: PlanExecutionTimingObserver): Promise<ExecutionPlanGoalResolution> {
  return runWithWorkspace(workspaceId, async () => {
    const { resolveOwnerGoalWithAssessment } = await measurePlanStage('goal_module', observe,
      () => import('../coordination/agent-goal-sources'));
    return measurePlanStage('goal_read', observe, () => resolveOwnerGoalWithAssessment(ownerId, 'self'));
  });
}

export async function checkExecutionPlan(binding: ExecutionPlanBinding, workspaceId: string,
  observe?: PlanExecutionTimingObserver): Promise<string[]> {
  const { readPlanExecutionStart } = await import('./plan-execution-authority');
  const proof = await measurePlanStage('start_proof', observe, () => readPlanExecutionStart(binding, workspaceId));
  if (proof.length) return proof;
  return checkPlanExecutionReadiness(binding, workspaceId, observe);
}

/** Current policy is required both when issuing authority and on every use. */
export async function checkPlanExecutionReadiness(binding: ExecutionPlanBinding, workspaceId: string,
  observe?: PlanExecutionTimingObserver): Promise<string[]> {
  return runWithWorkspace(workspaceId, async () => {
    const { sql } = getOrgPg();
    const rows = await measurePlanStage('scope', observe, () => sql<Array<{ harness_slug: string; content: string; content_hash: string; op_status: string | null; created_at: Date | string | null }>>`
      SELECT harness_slug, content, content_hash, op_status, created_at FROM harness_shared.harness_plans
       WHERE workspace_id=${workspaceId} AND plan_slug=${binding.planSlug}
         AND (${binding.harnessSlug}::text IS NULL OR harness_slug=${binding.harnessSlug})`);
    if (rows.length !== 1) return [rows.length ? 'plan_scope_ambiguous' : 'bound_plan_missing'];
    const row = rows[0]!;
    const opts = { harnessSlug: row.harness_slug, workspaceId };
    const plan = await measurePlanStage('plan_row', observe, () => getPlanRow(binding.planSlug, opts));
    if (!plan || plan.contentHash !== row.content_hash) return ['plan_revision_changed'];
    const parsed = parsePlan(plan.content);
    if (!['ready', 'active', 'awaiting-acceptance'].includes(parsed.frontmatter.status ?? ''))
      return [`plan_status:${parsed.frontmatter.status ?? 'unknown'}`];
    const scope = { workspaceId, harnessSlug: row.harness_slug, planSlug: binding.planSlug };
    const { evaluateConversationActivationGate } = await import('./plan-activation-gate');
    const [activationRead, auditRead] = await Promise.allSettled([
      measurePlanStage('activation', observe, () => evaluateConversationActivationGate(sql as never, scope)),
      measurePlanStage('audit', observe, () => sql<Array<{ audited_plan_content_hash: string | null; content_snapshot: string | null }>>`
        SELECT a.audited_plan_content_hash, r.content_snapshot
          FROM harness_shared.plan_audits a
          LEFT JOIN harness_shared.plan_revisions r ON r.id=a.audited_plan_revision_id
            AND r.workspace_id=a.workspace_id AND r.harness_slug=a.harness_slug AND r.plan_slug=a.plan_slug
         WHERE a.workspace_id=${workspaceId} AND a.harness_slug=${row.harness_slug} AND a.plan_slug=${binding.planSlug}
           AND a.audit_kind='activation' ORDER BY a.audit_seq DESC LIMIT 1`),
    ]);
    const activation = settledPlanValue(activationRead);
    if (!activation.satisfied) return [activation.code ?? 'conversation_audit_required'];
    const audit = settledPlanValue(auditRead)[0];
    // Preserve the canonical gate's explicit legacy/template exemptions, not an ad-hoc override.
    if (!activation.grandfathered) {
      if (!audit?.audited_plan_content_hash) return ['activation_revision_unmeasured'];
      if (audit.audited_plan_content_hash !== row.content_hash &&
        (!audit.content_snapshot || planExecutionMeaning(audit.content_snapshot) !== planExecutionMeaning(plan.content)))
        return ['activation_audit_stale'];
    }
    const [{ evaluatePlanStartReadiness }, { checkPlanAdmission }, { checkPlanStartable },
      { evaluatePlanSpecQualityGate }, { evaluatePlanStartBarCritique, isPlanStartBarCritiqueInCohort }, { specQualityPlanItemIds },
      { validatePlanCandidateDependencies }] = await Promise.all([
      import('./plan-input-validation'), import('./plan-admission-gate'),
      import('./plan-start-gate'), import('./plan-spec-quality-gate'), import('./plan-start-critique-gate'),
      import('./spec-quality'),
      import('./plan-candidate-dependencies'),
    ]);
    const dependencies = validatePlanCandidateDependencies(parsed, 'started');
    if (dependencies.state === 'rejected' || dependencies.state === 'invalid-draft') return ['plan_dependencies_invalid'];
    // This door enforces the current contract, not proof completion. Measuring
    // every bound artifact here repeats ship-only work on each native tool call.
    // Metadata still reads the live bounded sources; grading/ship reject reuse.
    const items = plan.items.length ? plan.items : parsed.items;
    // Legacy plans only receive diagnostic critiques. Native authority needs no
    // reconstruction of those histories; full start/report readers retain it.
    // Read the cohort on every invocation, and evaluate unknown dates normally.
    const createdMs = row.created_at == null ? Number.NaN : new Date(row.created_at).getTime();
    // These readers share the pinned plan revision, not settled authority.
    // Quality and admission do not depend on the BAR reader's reconciliation.
    // Critique does depend on quality, so keep that edge within its branch.
    const [gateRead, qualityRead, admissionRead] = await Promise.allSettled([
      measurePlanStage('start_gate', observe,
        () => checkPlanStartable(binding.planSlug, opts, null, 'start', {
          proofMode: 'metadata',
          ...(observe ? { onRead: (source: AcceptanceBarSnapshotSource, durationMs: number) => {
            try { observe({ stage: `start_gate_snapshot_${source}`, durationMs }); }
            catch { /* Diagnostics do not grant or refuse authority. */ }
          } } : {}),
        })),
      (async () => {
        const quality = await measurePlanStage('spec_quality', observe, () => evaluatePlanSpecQualityGate({ harnessSlug: row.harness_slug,
          planSlug: binding.planSlug, planItemIds: specQualityPlanItemIds(items), planItems: items }));
        const critique = quality.satisfied && quality.applicable && isPlanStartBarCritiqueInCohort(createdMs)
          ? await measurePlanStage('critique', observe, () => evaluatePlanStartBarCritique({ workspaceId, harnessSlug: row.harness_slug,
            planSlug: binding.planSlug, nonDroppedItemCount: specQualityPlanItemIds(items).length,
            contractEnforced: quality.mode === 'enforced' }))
          : null;
        return { quality, critique };
      })(),
      measurePlanStage('admission', observe,
        () => checkPlanAdmission({ slug: binding.planSlug, door: 'run-now', opts, row: plan })),
    ]);
    const gate = settledPlanValue(gateRead);
    if (!gate.ok) return [gate.refusal.code];
    const { quality, critique } = settledPlanValue(qualityRead);
    if (!quality.satisfied) return [quality.code ?? 'spec_quality_not_current'];
    if (critique?.mode === 'enforced' && !critique.verdict.satisfied)
      return [critique.verdict.code ?? 'critique_missing'];
    const inputs = evaluatePlanStartReadiness({ template: plan.template, inputSchema: plan.inputSchema }, plan.templateData);
    if (!inputs.ready) return [inputs.code];
    // checkPlanStartable already evaluates the complete pre-start BAR under pinned
    // plan types on this invocation. Repeating it remeasures every evidence binding.
    // Keep that canonical check fresh on every use; do not cache its verdict.
    const admission = settledPlanValue(admissionRead);
    if (!admission.admitted) return [admission.refusal.code];
    // Never combine successful branches from a revision changed during the reads.
    const current = await measurePlanStage('recheck', observe, () => sql<Array<{ content_hash: string }>>`
      SELECT content_hash FROM harness_shared.harness_plans
       WHERE workspace_id=${workspaceId} AND harness_slug=${row.harness_slug} AND plan_slug=${binding.planSlug}`);
    return current.length === 1 && current[0]!.content_hash === row.content_hash ? [] : ['plan_revision_changed'];
  });
}

export async function checkPlanExecutionGuard(input: PlanExecutionGuardInput,
  deps: PlanExecutionGuardDeps = {
    readBindings: readExecutionPlanBindings,
    resolveGoal: readExecutionPlanGoal,
    checkPlan: checkExecutionPlan,
  },
): Promise<PlanExecutionRefusal | null> {
  if (!isPlanImplementationCall(input.toolName, input.args)) return null;
  try {
    const allBindings = await measurePlanStage('bindings', input.observeTiming,
      () => deps.readBindings(input.ownerId, input.workspaceId));
    // Goal selection only narrows this authoritative census; it cannot add a
    // bound plan. Avoid its store reads when there is nothing to select. The
    // census is still read afresh on every call, and read failures refuse below.
    if (allBindings.length === 0) return null;
    let resolution: ExecutionPlanGoalResolution | null = null;
    if (deps.resolveGoal) {
      try {
        resolution = await measurePlanStage('goal', input.observeTiming,
          () => deps.resolveGoal!(input.ownerId, input.workspaceId, input.observeTiming));
      } catch {
        // An unreadable selector cannot narrow authority. Check the entire durable
        // census instead, preserving the existing fail-closed behavior.
      }
    }
    const bindings = resolution && resolution.diagnostics.length === 0
      ? selectExecutionPlanBindings(allBindings, resolution.goal)
      : uniquePlanBindings(allBindings);
    for (const binding of bindings) {
      const blockers = await measurePlanStage('binding', input.observeTiming,
        () => deps.checkPlan(binding, input.workspaceId, input.observeTiming));
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
