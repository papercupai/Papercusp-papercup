import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { dispatchProjectedTool, type ProjectedTool } from '@papercusp/agent-mcp';
import { resolveAgentGoal } from '../../agent-goal-ref';

const connection = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: connection.sql }),
  withWorkspace: async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => db.sql.begin(tx => fn(tx)),
}));
// Activation prerequisites have their own real-PG suite. This suite controls only that
// verdict so the production revision comparison can be falsified against real rows.
vi.mock('./plan-activation-gate', () => ({ evaluateConversationActivationGate: async () => ({ satisfied: true, auditSeq: 1 }) }));
// The real revision comparison must reach the next policy gate. Its explicit
// refusal keeps this narrow fixture from claiming complete start admission or
// provisioning the unrelated registry, scorecard and budget subsystems.
const policy = vi.hoisted(() => ({ realStartGate: false, qualityApplicable: false,
  readLifecycle: vi.fn(), readQuality: vi.fn(), readAdmission: vi.fn(), critique: vi.fn() }));
vi.mock('./plan-start-gate', async original => {
  const actual = await original<typeof import('./plan-start-gate')>();
  return { ...actual, checkPlanStartable: (...args: Parameters<typeof actual.checkPlanStartable>) =>
    policy.realStartGate ? actual.checkPlanStartable(...args)
      : Promise.resolve({ ok: false, refusal: { code: 'private-downstream-start-policy' } }) };
});
vi.mock('../../acceptance-bar-lifecycle-evaluator', async original => ({
  ...(await original<typeof import('../../acceptance-bar-lifecycle-evaluator')>()),
  readAndEvaluateAcceptanceBarLifecycle: (...args: unknown[]) => policy.readLifecycle(...args),
}));
vi.mock('../../plan-types/pins', async original => ({
  ...(await original<typeof import('../../plan-types/pins')>()),
  withPinnedPlanTypes: async (_scope: unknown, read: () => Promise<unknown>) => read(),
}));
vi.mock('./plan-spec-quality-gate', async original => ({
  ...(await original<typeof import('./plan-spec-quality-gate')>()),
  evaluatePlanSpecQualityGate: (...args: unknown[]) => policy.readQuality(...args),
}));
vi.mock('./plan-admission-gate', async original => {
  const actual = await original<typeof import('./plan-admission-gate')>();
  return { ...actual, checkPlanAdmission: (...args: Parameters<typeof actual.checkPlanAdmission>) =>
    policy.readAdmission(...args) ?? actual.checkPlanAdmission(...args) };
});
vi.mock('./plan-start-critique-gate', async original => ({
  ...(await original<typeof import('./plan-start-critique-gate')>()),
  evaluatePlanStartBarCritique: (...args: unknown[]) => policy.critique(...args),
}));
import { checkExecutionPlan, checkPlanExecutionGuard, readExecutionPlanBindings } from './plan-execution-guard';
import { toolGuardText } from '../../endpoint-route/routes/agent-mcp/identity-hook-sinks';
import { controlAnchorKernelResolver } from '../../projected-tool-deps';

const WS = 'private-plan-execution';
const OWNER = 'su-private-builder';
const binding = { planSlug: 'draft-feature', harnessSlug: 'project' };
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('planexec');
  connection.sql = db.sql;
  // Narrow read projections of existing relations; all rows belong to this private DB.
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.session_briefs (owner_id text, workspace_id text,
      current_plan_slug text, harness_slug text, control_state jsonb, control_generation bigint);
    CREATE TABLE harness_shared.adv_sessions (id bigint, coord_owner_id text, workspace_id text,
      plan_slug text, launch_spec jsonb, started_at timestamptz, ended_at timestamptz, ended_by text);
    CREATE TABLE harness_shared.plan_item_claims (owner text, workspace_id text, harness_slug text,
      plan_slug text, item_id text, expires_ts timestamptz);
    CREATE TABLE harness_shared.work_items (taken_by text, workspace_id text, harness_slug text,
      source_plan_slug text, status text);
    CREATE TABLE harness_shared.harness_plans (workspace_id text, harness_slug text, plan_slug text,
      content text, content_hash text, op_status text, status text DEFAULT 'draft', execution_start_revision_seq integer);
    CREATE TABLE harness_shared.plan_audits (workspace_id text, harness_slug text, plan_slug text,
      audit_kind text, audit_seq bigint, audited_plan_content_hash text, audited_plan_revision_id bigint);
    CREATE TABLE harness_shared.plan_revisions (id bigint, workspace_id text, harness_slug text,
      plan_slug text, content_snapshot text, seq integer);
    CREATE TABLE harness_shared.harness_registry (workspace_id text PRIMARY KEY, payload jsonb);
    -- The real start gate reads admission policy. No policy row makes this
    -- private project ungoverned while retaining the canonical admission reader.
    CREATE TABLE harness_shared.pot_policy (workspace_id text, harness_slug text,
      policy_json text, owner_pubkey text, signature text, policy_version bigint,
      fed_hlc text, updated_at bigint);
    INSERT INTO harness_shared.harness_registry VALUES ('private-plan-execution',
      '{"projects":[{"slug":"project","harness_kind":"hive"}]}'::jsonb);
    -- Exercise the canonical rendered-plan reader, including its complete projection.
    ALTER TABLE harness_shared.harness_plans
      ADD COLUMN version integer DEFAULT 1, ADD COLUMN title text, ADD COLUMN created text,
      ADD COLUMN updated text, ADD COLUMN owner text, ADD COLUMN initiative text,
      ADD COLUMN supersedes text, ADD COLUMN superseded_by text,
      ADD COLUMN op_started_at timestamptz, ADD COLUMN op_updated_at timestamptz,
      ADD COLUMN current_wave integer, ADD COLUMN op_priority integer,
      ADD COLUMN archived boolean DEFAULT false, ADD COLUMN is_legacy boolean DEFAULT false,
      ADD COLUMN updated_at timestamptz, ADD COLUMN created_at timestamptz DEFAULT now(),
      ADD COLUMN items jsonb DEFAULT '[]',
      ADD COLUMN now_state text, ADD COLUMN now_next text, ADD COLUMN now_note jsonb,
      ADD COLUMN promote_policy text, ADD COLUMN schedule jsonb, ADD COLUMN schedule_active boolean,
      ADD COLUMN scheduled_at timestamptz, ADD COLUMN expires_at timestamptz, ADD COLUMN tzid text,
      ADD COLUMN template_slug text, ADD COLUMN run_seq integer, ADD COLUMN template text,
      ADD COLUMN template_data jsonb, ADD COLUMN input_schema jsonb, ADD COLUMN output_schema jsonb,
      ADD COLUMN forced_past jsonb, ADD COLUMN verification_profile text,
      ADD COLUMN verification_profile_source text;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN feature_id text, ADD COLUMN item_kind text, ADD COLUMN plan_slug text,
      ADD COLUMN plan_line_id text, ADD COLUMN plan_line_text text, ADD COLUMN plan_importance text,
      ADD COLUMN plan_phase text, ADD COLUMN plan_decision_refs text[], ADD COLUMN plan_deliverable text,
      ADD COLUMN plan_owner_gate_marker text, ADD COLUMN plan_seq integer;
    CREATE TABLE harness_shared.work_item_deps (workspace_id text, dep_type text,
      blocked_kind text, blocked_ref text, blocker_kind text, blocker_ref text);
  `);
}, 120_000);
afterAll(async () => { connection.sql = null; await db?.cleanup(); });
beforeEach(async () => {
  policy.qualityApplicable = false;
  policy.readQuality.mockReset();
  policy.readQuality.mockImplementation(async () => ({ satisfied: true, applicable: policy.qualityApplicable, mode: 'enforced' }));
  policy.readAdmission.mockReset();
  policy.critique.mockReset();
  await db.sql.unsafe('TRUNCATE harness_shared.session_briefs, harness_shared.adv_sessions, harness_shared.plan_item_claims, harness_shared.work_items, harness_shared.harness_plans, harness_shared.plan_audits, harness_shared.plan_revisions');
  await db.sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,content,content_hash,op_status) VALUES (${WS}, 'project', 'draft-feature',
    ${'---\ntitle: Draft\nstatus: draft\n---\n# Draft\n'}, 'draft-hash', NULL)`;
});

describe('real write-boundary bypass regression', () => {
  it('separates goal module and read timing without allowing a broken diagnostic sink to change refusal', async () => {
    await db.sql`INSERT INTO harness_shared.session_briefs VALUES (${OWNER}, ${WS}, 'draft-feature', 'project',
      ${db.sql.json({ scope: { plan: 'draft-feature', harness: 'project' } })}, 1)`;
    const timings: Array<{ stage: string; durationMs: number }> = [];
    const result = await checkPlanExecutionGuard({ ownerId: OWNER, workspaceId: WS,
      toolName: 'apply_patch', args: {}, observeTiming: timing => {
        timings.push(timing);
        throw new Error('diagnostic sink unavailable');
      } });
    expect(result).toMatchObject({ planSlug: 'draft-feature', blockers: ['plan_status:draft'] });
    expect(timings.map(timing => timing.stage)).toEqual(expect.arrayContaining(['goal_module', 'goal_read', 'goal']));
    expect(timings.every(timing => Number.isFinite(timing.durationMs) && timing.durationMs >= 0)).toBe(true);
  });
  it('denies native patches and shell writes despite an unrelated held WI and no worn identity', async () => {
    await db.sql`INSERT INTO harness_shared.session_briefs VALUES (${OWNER}, ${WS}, 'draft-feature', 'project',
      ${db.sql.json({ scope: { plan: 'draft-feature', harness: 'project' } })}, 1)`;
    await db.sql`INSERT INTO harness_shared.work_items (taken_by,workspace_id,harness_slug,source_plan_slug,status)
      VALUES (${OWNER}, ${WS}, 'project', NULL, 'wip')`;
    for (const tool of ['apply_patch', 'exec_command']) {
      const text = await toolGuardText({ ownerId: OWNER, workspaceId: WS,
        call: { tool, input: { cmd: 'touch implementation.ts' }, client: 'codex' } }, async () => null);
      expect(text).toContain('plan_execution_not_ready');
      expect(text).toContain('plan_status:draft');
    }
    expect(await toolGuardText({ ownerId: OWNER, workspaceId: WS,
      call: { tool: 'exec_command', input: { cmd: 'rg -n scope source.ts' }, client: 'codex' } }, async () => null)).toBe('');
  });
  it('refuses platform dispatch before the implementation handler executes', async () => {
    // No session anchor: the linked work-item is independently authoritative.
    await db.sql`INSERT INTO harness_shared.work_items (taken_by,workspace_id,harness_slug,source_plan_slug,status)
      VALUES (${OWNER}, ${WS}, 'project', 'draft-feature', 'wip')`;
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'wrote source' }] }));
    const tool: ProjectedTool = {
      pluginName: 'fixture', description: 'private write', inputSchema: { type: 'object' }, capabilities: [],
      expose: { mcp: { name: 'capability:write' } }, fn: handler,
    } as ProjectedTool;
    const result = await dispatchProjectedTool(tool, 'capability:write', {},
      { workspaceId: WS, isSuperuser: true, uiClientId: OWNER, signal: new AbortController().signal,
        log: () => {}, progress: () => {}, emit: () => {} }, { kernelEnforcement: controlAnchorKernelResolver });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('plan_execution_not_ready');
    expect(handler).not.toHaveBeenCalled();
  });
  it('retains launch and expired-but-held plan claims, scoped to the owner and workspace', async () => {
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES (1,${OWNER},${WS},'draft-feature',NULL,now(),NULL,NULL)`;
    await db.sql`INSERT INTO harness_shared.plan_item_claims
      (owner,workspace_id,harness_slug,plan_slug,item_id,expires_ts)
      VALUES (${OWNER},${WS},'project','claim-plan','P-001',now()-interval '1 day')`;
    await db.sql`INSERT INTO harness_shared.plan_item_claims
      (owner,workspace_id,harness_slug,plan_slug,item_id,expires_ts)
      VALUES (${OWNER},'other-workspace','project','foreign-plan','P-002',now())`;
    expect(await readExecutionPlanBindings(OWNER, WS)).toEqual(expect.arrayContaining([
      expect.objectContaining({ planSlug: 'draft-feature', harnessSlug: null, source: 'active-session' }),
      expect.objectContaining({ planSlug: 'claim-plan', harnessSlug: 'project',
        source: 'plan-item-claim', sourceRef: 'claim-plan#P-001' }),
    ]));
    expect((await readExecutionPlanBindings(OWNER, WS)).some(row => row.planSlug === 'foreign-plan')).toBe(false);
  });
  it('uses the selected work-item when an unrelated plan-item claim is also held', async () => {
    await db.sql`INSERT INTO harness_shared.work_items
      (taken_by,workspace_id,harness_slug,source_plan_slug,status,feature_id)
      VALUES (${OWNER},${WS},'project','security-plan','wip','EI-security')`;
    await db.sql`INSERT INTO harness_shared.plan_item_claims
      (owner,workspace_id,harness_slug,plan_slug,item_id,expires_ts)
      VALUES (${OWNER},${WS},'project','unrelated-plan','P-008',now()-interval '1 day')`;
    const goal = resolveAgentGoal({
      workItems: [{ id: 'EI-security' }],
      planItems: [{ planSlug: 'unrelated-plan', itemId: 'P-008' }],
    })!;
    const checked: string[] = [];
    const refusal = await checkPlanExecutionGuard({
      ownerId: OWNER, workspaceId: WS, toolName: 'apply_patch', args: {},
    }, {
      readBindings: readExecutionPlanBindings,
      resolveGoal: async () => ({ goal, diagnostics: [] }),
      checkPlan: async binding => {
        checked.push(binding.planSlug);
        return binding.planSlug === 'unrelated-plan' ? ['plan_status:draft'] : [];
      },
    });

    expect(refusal).toBeNull();
    expect(checked).toEqual(['security-plan']);
  });
  it('still blocks when the selected work-item points to a plan that has not started', async () => {
    await db.sql`INSERT INTO harness_shared.work_items
      (taken_by,workspace_id,harness_slug,source_plan_slug,status,feature_id)
      VALUES (${OWNER},${WS},'project','draft-feature','wip','EI-security')`;
    await db.sql`INSERT INTO harness_shared.plan_item_claims
      (owner,workspace_id,harness_slug,plan_slug,item_id,expires_ts)
      VALUES (${OWNER},${WS},'project','unrelated-plan','P-008',now())`;
    const readyPlan = '---\ntitle: Draft\nstatus: ready\n---\n# Draft\n';
    await db.sql`UPDATE harness_shared.harness_plans
      SET content=${readyPlan},content_hash='ready-hash',status='ready'`;
    const goal = resolveAgentGoal({
      workItems: [{ id: 'EI-security' }],
      planItems: [{ planSlug: 'unrelated-plan', itemId: 'P-008' }],
    })!;
    const refusal = await checkPlanExecutionGuard({
      ownerId: OWNER, workspaceId: WS, toolName: 'apply_patch', args: {},
    }, {
      readBindings: readExecutionPlanBindings,
      resolveGoal: async () => ({ goal, diagnostics: [] }),
      checkPlan: checkExecutionPlan,
    });

    expect(refusal).toMatchObject({
      code: 'plan_execution_not_ready',
      planSlug: 'draft-feature',
      blockers: ['plan_not_started'],
    });
  });
  it('allows genuinely unbound work, but never interprets an unreadable binding store as unbound', async () => {
    const input = { ownerId: OWNER, workspaceId: WS, toolName: 'apply_patch', args: {} };
    expect(await checkPlanExecutionGuard(input)).toBeNull();
    await db.sql.unsafe('ALTER TABLE harness_shared.work_items RENAME TO unavailable_work_items');
    try { expect(await checkPlanExecutionGuard(input)).toMatchObject({ blockers: ['plan_authority_unavailable'] }); }
    finally { await db.sql.unsafe('ALTER TABLE harness_shared.unavailable_work_items RENAME TO work_items'); }
  });
  it('refuses materially changed scope against the immutable audited revision', async () => {
    const before = '---\ntitle: Feature\nstatus: ready\n---\n# Feature\n## Requirements\nPreserve findings.\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${before.replace('ready', 'active').replace('Preserve', 'Discard')}, content_hash='new', op_status='started', status='active'`;
    await db.sql`INSERT INTO harness_shared.plan_revisions (id,workspace_id,harness_slug,plan_slug,content_snapshot) VALUES (1,${WS},'project','draft-feature',${before})`;
    await db.sql`INSERT INTO harness_shared.plan_audits VALUES (${WS},'project','draft-feature','activation',1,'old',1)`;
    const { checkPlanExecutionReadiness } = await import('./plan-execution-guard');
    expect(await checkPlanExecutionReadiness(binding, WS)).toEqual(['activation_audit_stale']);
  });
  it('admits first-start generated promotion receipts but rejects a material addition to that same section', async () => {
    const before = '---\ntitle: Feature\nstatus: draft\n---\n# Feature\n## Requirements\nPreserve findings.\n';
    const after = before.replace('status: draft', 'status: ready')
      + '\n## Promoted\n\n<!-- plan-pipeline: do not edit this block manually -->\n- [ ] WI-123 — Preserve findings <!-- P-001 -->\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${after}, content_hash='after-promotion', status='ready'`;
    await db.sql`INSERT INTO harness_shared.plan_revisions (id,workspace_id,harness_slug,plan_slug,content_snapshot) VALUES (1,${WS},'project','draft-feature',${before})`;
    await db.sql`INSERT INTO harness_shared.plan_audits VALUES (${WS},'project','draft-feature','activation',1,'before-promotion',1)`;
    const { checkPlanExecutionReadiness } = await import('./plan-execution-guard');
    expect(await checkPlanExecutionReadiness(binding, WS)).toEqual(['private-downstream-start-policy']);
    await db.sql`UPDATE harness_shared.harness_plans SET content=${after + '\nDiscard failed attempts.\n'}, content_hash='material-change'`;
    expect(await checkPlanExecutionReadiness(binding, WS)).toEqual(['activation_audit_stale']);
  });
  it('reads the canonical BAR once per invocation and refuses a changed verdict on the next use', async () => {
    const content = '---\ntitle: Feature\nstatus: active\n---\n# Feature\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${content}, content_hash='current', status='active', op_status='started'`;
    await db.sql`INSERT INTO harness_shared.plan_audits VALUES (${WS},'project','draft-feature','activation',1,'current',NULL)`;
    policy.realStartGate = true;
    policy.readLifecycle.mockReset();
    policy.readLifecycle.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[2] as { onRead?: (source: string, elapsedMs: number) => void };
      options.onRead?.('plan', 4);
      return { satisfied: true, codes: [], blockingBars: [] };
    })
      .mockResolvedValue({ satisfied: false, codes: ['current-policy-regressed'], blockingBars: [] });
    try {
      const { checkPlanExecutionReadiness } = await import('./plan-execution-guard');
      const stages: string[] = [];
      expect(await checkPlanExecutionReadiness(binding, WS, timing => {
        stages.push(timing.stage); throw Error('diagnostic sink unavailable');
      })).toEqual([]);
      expect(stages.sort()).toEqual(['scope', 'plan_row', 'activation', 'audit', 'start_gate', 'start_gate_snapshot_plan', 'spec_quality', 'admission', 'recheck'].sort());
      expect(policy.readLifecycle).toHaveBeenCalledTimes(1);
      expect(policy.readLifecycle).toHaveBeenLastCalledWith('draft-feature', 'pre-start', {
        harnessSlug: 'project', requireCompleteContractBeforeProof: true, proofMode: 'metadata',
        onRead: expect.any(Function),
      });
      expect(await checkPlanExecutionReadiness(binding, WS)).toEqual(['acceptance_bar_contract_not_ready']);
      expect(policy.readLifecycle).toHaveBeenCalledTimes(2);
    } finally {
      policy.realStartGate = false;
      policy.readLifecycle.mockReset();
    }
  });
  it('starts independent authority reads while BAR evaluation is pending and rejects revision drift', async () => {
    const content = '---\ntitle: Feature\nstatus: active\n---\n# Feature\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${content}, content_hash='current', status='active', op_status='started'`;
    await db.sql`INSERT INTO harness_shared.plan_audits VALUES (${WS},'project','draft-feature','activation',1,'current',NULL)`;
    policy.realStartGate = true;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: { satisfied: boolean; codes: string[]; blockingBars: never[] }) => void;
    const blocked = new Promise<{ satisfied: boolean; codes: string[]; blockingBars: never[] }>(resolve => { release = resolve; });
    policy.readLifecycle.mockImplementation(() => { entered(); return blocked; });
    const { checkPlanExecutionReadiness } = await import('./plan-execution-guard');
    const attempt = checkPlanExecutionReadiness(binding, WS);
    try {
      await started;
      expect(policy.readQuality).toHaveBeenCalledTimes(1);
      expect(policy.readAdmission).toHaveBeenCalledWith(expect.objectContaining({ door: 'run-now' }));
      // The policy reads began under 'current'; changing it before their join must deny.
      await db.sql`UPDATE harness_shared.harness_plans SET content_hash='changed-during-read'`;
      release({ satisfied: true, codes: [], blockingBars: [] });
      expect(await attempt).toEqual(['plan_revision_changed']);
    } finally {
      release({ satisfied: true, codes: [], blockingBars: [] });
      await attempt.catch(() => {});
      policy.realStartGate = false;
      policy.readLifecycle.mockReset();
    }
  });
  it('preserves refusal precedence when a concurrent later policy read rejects', async () => {
    const content = '---\ntitle: Feature\nstatus: active\n---\n# Feature\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${content}, content_hash='current', status='active', op_status='started'`;
    await db.sql`INSERT INTO harness_shared.plan_audits VALUES (${WS},'project','draft-feature','activation',1,'current',NULL)`;
    policy.realStartGate = true;
    policy.readLifecycle.mockResolvedValue({ satisfied: false, codes: ['bar-refused'], blockingBars: [] });
    policy.readQuality.mockRejectedValue(new Error('quality unavailable'));
    policy.readAdmission.mockRejectedValue(new Error('admission unavailable'));
    const { checkPlanExecutionReadiness } = await import('./plan-execution-guard');
    try {
      expect(await checkPlanExecutionReadiness(binding, WS)).toEqual(['acceptance_bar_contract_not_ready']);
      policy.readLifecycle.mockResolvedValue({ satisfied: true, codes: [], blockingBars: [] });
      policy.readQuality.mockResolvedValue({ satisfied: false, code: 'spec_quality_failed', applicable: true, mode: 'enforced' });
      expect(await checkPlanExecutionReadiness(binding, WS)).toEqual(['spec_quality_failed']);
      policy.readQuality.mockResolvedValue({ satisfied: true, applicable: false, mode: 'enforced' });
      expect(await checkPlanExecutionGuard({ ownerId: OWNER, workspaceId: WS, toolName: 'apply_patch', args: {} }, {
        readBindings: async () => [binding], checkPlan: checkPlanExecutionReadiness,
      })).toMatchObject({ blockers: ['plan_authority_unavailable'] });
    } finally {
      policy.realStartGate = false;
      policy.readLifecycle.mockReset();
    }
  });
  it('skips legacy diagnostic critique histories and freshly enforces the cutoff on the next invocation', async () => {
    const content = '---\ntitle: Feature\nstatus: active\n---\n# Feature\n';
    await db.sql`UPDATE harness_shared.harness_plans SET content=${content}, content_hash='current',
      status='active', op_status='started', created_at='2026-10-08T23:42:05Z'`;
    await db.sql`INSERT INTO harness_shared.plan_audits VALUES (${WS},'project','draft-feature','activation',1,'current',NULL)`;
    policy.realStartGate = true;
    policy.qualityApplicable = true;
    policy.readLifecycle.mockResolvedValue({ satisfied: true, codes: [], blockingBars: [] });
    policy.critique.mockResolvedValue({ mode: 'enforced', verdict: { satisfied: false, code: 'critique_missing' } });
    try {
      const { checkPlanExecutionReadiness } = await import('./plan-execution-guard');
      expect(await checkPlanExecutionReadiness(binding, WS)).toEqual([]);
      expect(policy.critique).not.toHaveBeenCalled();

      await db.sql`UPDATE harness_shared.harness_plans SET created_at='2026-10-11T03:00:00Z'`;
      expect(await checkPlanExecutionReadiness(binding, WS)).toEqual(['critique_missing']);
      expect(policy.critique).toHaveBeenCalledTimes(1);

      await db.sql`UPDATE harness_shared.harness_plans SET created_at=NULL`;
      expect(await checkPlanExecutionReadiness(binding, WS)).toEqual(['critique_missing']);
      expect(policy.critique).toHaveBeenCalledTimes(2);
    } finally {
      policy.realStartGate = false;
      policy.qualityApplicable = false;
      policy.readLifecycle.mockReset();
    }
  });
  it('does not treat ready status as completion of the standard start process', async () => {
    await db.sql`UPDATE harness_shared.harness_plans SET content=${'---\ntitle: Draft\nstatus: ready\n---\n# Draft\n'}, status='ready'`;
    expect(await checkExecutionPlan(binding, WS)).toEqual(['plan_not_started']);
  });
});
