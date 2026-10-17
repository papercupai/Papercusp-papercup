import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { withPlanLock } from '../with-plan-lock';
import { hashPlanContent } from '../content-hash';
import { evaluateConversationActivationGate } from '../plan-activation-gate';
import {
  cleanupPlans,
  registerHarnessProject,
  seedPlan,
  setupPlanPgFixture,
  type PlanPgFixture,
} from './_pg-tool-fixture';

const HARNESS = 'zzz-activation-audit-gate';
const SLUG = 'activation-gate-plan';
const DRAFT = `---
title: Activation gate
slug: ${SLUG}
status: draft
created: 2026-08-24
updated: 2026-08-24
---

# Activation gate

## Phase 1

- **P-001** \`todo\` prove the gate
`;

let fx: PlanPgFixture;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  await registerHarnessProject(fx.admin, fx.workspaceId, HARNESS);
}, 90_000);

afterAll(async () => {
  await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
  await fx.dispose();
});

beforeEach(async () => {
  await fx.admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
  await registerHarnessProject(fx.admin, fx.workspaceId, HARNESS);
});

async function activationAudit(sql: postgres.Sql, planSlug = SLUG) {
  await sql`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${planSlug}, 1, 'su-test', 'activation',
       ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
       1, 1, ${'a'.repeat(64)}, '[]'::jsonb, '[]'::jsonb)`;
}

async function appendPlanRevision(sql: postgres.Sql, body: string) {
  const contentHash = hashPlanContent(body);
  const rows = await sql<Array<{ id: number | string; seq: number }>>`
    INSERT INTO harness_shared.plan_revisions
      (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
       rationale, author_kind, author_id, session_id, session_kind, created_at)
    SELECT ${fx.workspaceId}, ${HARNESS}, ${SLUG}, COALESCE(MAX(seq), 0) + 1,
           ${contentHash}, ${body}, 'activation notice regression', 'agent', 'su-test',
           'session-test', 'codex', ${Date.now()}
      FROM harness_shared.plan_revisions
     WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    RETURNING id, seq`;
  return { id: Number(rows[0]!.id), seq: Number(rows[0]!.seq), contentHash };
}

async function activationAuditAt(
  sql: postgres.Sql,
  anchor: { id: number; seq: number; contentHash: string },
) {
  await sql`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${SLUG}, 1, 'su-test', 'activation',
       ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
       ${anchor.id}, ${anchor.seq}, ${anchor.contentHash}, '[]'::jsonb, '[]'::jsonb)`;
}

const flipReady = (body: string) => body.replace('status: draft', 'status: ready');

const RUBRIC_DRAFT = `---
title: Rubric activation
slug: rubric-activation
status: draft
template: rubric
created: 2026-08-24
updated: 2026-08-24
---

# Rubric activation
`;

const activate = (body: string) => body.replace('status: draft', 'status: active');

const MATERIAL_CHANGE_TAXONOMY = [
  'requirements',
  'scope',
  'constraints',
  'decisions',
  'dependencies',
  'sequencing',
  'acceptance criteria',
  'open questions',
  'promised follow-ups',
] as const;

const COSMETIC_CHANGE_TAXONOMY = [
  'spelling',
  'formatting',
  'cosmetic-only wording',
] as const;

describe('conversation activation audit gate', () => {
  it('grandfathers an already-ready plan with no audit, but not a stored draft', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, flipReady(DRAFT));
    await expect(
      evaluateConversationActivationGate(fx.admin as never, {
        workspaceId: fx.workspaceId,
        harnessSlug: HARNESS,
        planSlug: SLUG,
      }),
    ).resolves.toMatchObject({
      satisfied: true,
      grandfathered: true,
      message: expect.stringContaining('already ready with no activation audit'),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already ready with no activation audit'));
    warn.mockRestore();

    await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);
    await expect(
      evaluateConversationActivationGate(fx.admin as never, {
        workspaceId: fx.workspaceId,
        harnessSlug: HARNESS,
        planSlug: SLUG,
      }),
    ).resolves.toMatchObject({ satisfied: false, code: 'conversation_audit_required' });
  });

  it('blocks a raw draft→ready content transition and leaves the row unchanged', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);

    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test activation gate' },
      async (current) => ({ newBody: flipReady(current!), value: { ok: true } }),
    );

    expect(result).toMatchObject({
      kind: 'refused',
      value: { ok: false, code: 'conversation_audit_required', message: expect.stringContaining("plans:audit { phase:'activation'") },
    });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    expect(rows[0]?.content).toContain('status: draft');
  });

  it('admits the same transition after an activation audit exists', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);
    await activationAudit(fx.admin);

    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test activation gate' },
      async (current) => ({ newBody: flipReady(current!), value: { ok: true } }),
    );

    expect(result).toMatchObject({ kind: 'applied', value: { ok: true } });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    expect(rows[0]?.content).toContain('status: ready');
  });

  it('allows the internal awaiting-acceptance→ready lifecycle repair without a fresh audit', async () => {
    const awaiting = flipReady(DRAFT).replace('status: ready', 'status: awaiting-acceptance');
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, awaiting);

    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      {
        slug: SLUG,
        harnessSlug: HARNESS,
        workspaceId: fx.workspaceId,
        intent: 'test awaiting-acceptance lifecycle repair',
        allowAwaitingAcceptanceRestore: true,
      },
      async (current) => ({ newBody: current!.replace('status: awaiting-acceptance', 'status: ready'), value: { ok: true } }),
    );

    expect(result).toMatchObject({ kind: 'applied', value: { ok: true } });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    expect(rows[0]?.content).toContain('status: ready');
  });

  it('blocks direct creation as ready but allows later cosmetic edits of an already-ready plan', async () => {
    const direct = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test direct ready' },
      async () => ({ newBody: flipReady(DRAFT), value: { ok: true } }),
    );
    expect(direct).toMatchObject({ kind: 'refused', value: { code: 'conversation_audit_required' } });

    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, flipReady(DRAFT));
    const cosmetic = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test cosmetic edit' },
      async (current) => ({ newBody: current!.replace('prove the gate', 'prove the shared gate'), value: { ok: true } }),
    );
    expect(cosmetic).toMatchObject({ kind: 'applied', value: { ok: true } });
  });

  it('exempts a new rubric-template plan entering active without an activation audit', async () => {
    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: 'rubric-activation', harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test rubric activation' },
      async () => ({ newBody: activate(RUBRIC_DRAFT), value: { ok: true } }),
    );

    expect(result).toMatchObject({ kind: 'applied', value: { ok: true } });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = 'rubric-activation'`;
    expect(rows[0]?.content).toContain('status: active');
  });

  it('exempts an existing proposed rubric-template plan promoted to active', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, 'rubric-activation', RUBRIC_DRAFT);
    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: 'rubric-activation', harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test rubric ratification' },
      async (current) => ({ newBody: activate(current!), value: { ok: true } }),
    );

    expect(result).toMatchObject({ kind: 'applied', value: { ok: true } });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = 'rubric-activation'`;
    expect(rows[0]?.content).toContain('status: active');
  });

  // D-038 (verification-system-improvements-2026-10-10): the child-seed template exempts
  // a spawn_child seed plan from the audit, and only spawn_child may introduce it.
  const CHILD_SEED_ACTIVE = activate(RUBRIC_DRAFT)
    .replace('template: rubric', 'template: child-seed')
    .replaceAll('rubric-activation', 'child-seed-activation');

  it('refuses a write that self-serves the child-seed template and leaves no row', async () => {
    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: 'child-seed-activation', harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test self-serve child-seed' },
      async () => ({ newBody: CHILD_SEED_ACTIVE, value: { ok: true } }),
    );

    expect(result).toMatchObject({
      kind: 'refused',
      value: { ok: false, code: 'child_seed_template_reserved' },
    });
    const rows = await fx.admin`
      SELECT 1 FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = 'child-seed-activation'`;
    expect(rows).toHaveLength(0);
  });

  it('refuses adding the child-seed template to an existing ordinary plan', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);
    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test template swap' },
      async (current) => ({
        newBody: flipReady(current!).replace('status: ready', 'status: ready\ntemplate: child-seed'),
        value: { ok: true },
      }),
    );
    expect(result).toMatchObject({ kind: 'refused', value: { code: 'child_seed_template_reserved' } });
  });

  it('exempts the spawn_child writer, and a later edit that keeps the template passes', async () => {
    const created = await withPlanLock<{ ok: true }>(
      {} as never,
      {
        slug: 'child-seed-activation',
        harnessSlug: HARNESS,
        workspaceId: fx.workspaceId,
        intent: 'test spawn_child seed',
        allowChildSeedTemplate: true,
      },
      async () => ({ newBody: CHILD_SEED_ACTIVE, value: { ok: true } }),
    );
    expect(created).toMatchObject({ kind: 'applied', value: { ok: true } });

    const edited = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: 'child-seed-activation', harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test later edit' },
      async (current) => ({ newBody: current!.replace('# Rubric activation', '# Child seed'), value: { ok: true } }),
    );
    expect(edited).toMatchObject({ kind: 'applied', value: { ok: true } });
    const rows = await fx.admin<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = 'child-seed-activation'`;
    expect(rows[0]?.content).toContain('status: active');
    expect(rows[0]?.content).toContain('# Child seed');
  });

  it('keeps the activation audit requirement for ordinary plans', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);
    const result = await withPlanLock<{ ok: true }>(
      {} as never,
      { slug: SLUG, harnessSlug: HARNESS, workspaceId: fx.workspaceId, intent: 'test ordinary activation' },
      async (current) => ({ newBody: flipReady(current!), value: { ok: true } }),
    );

    expect(result).toMatchObject({
      kind: 'refused',
      value: { ok: false, code: 'conversation_audit_required' },
    });
  });

  it('preserves the audit after cosmetic and substantive edits while surfacing exact revision/materiality guidance', async () => {
    await seedPlan(fx.admin, fx.workspaceId, HARNESS, SLUG, DRAFT);
    const audited = await appendPlanRevision(fx.admin, DRAFT);
    await activationAuditAt(fx.admin, audited);

    const cosmetic = await withPlanLock<{ ok: true }>(
      {} as never,
      {
        slug: SLUG,
        harnessSlug: HARNESS,
        workspaceId: fx.workspaceId,
        intent: 'test cosmetic post-audit edit notice',
        afterWrite: async (body) => { await appendPlanRevision(fx.admin, body); },
      },
      async (current) => ({
        newBody: current!.replace('# Activation gate', '# Activation gate '),
        value: { ok: true },
      }),
    );

    expect(cosmetic).toMatchObject({
      kind: 'applied',
      activationAudit: {
        status: 'preserved',
        auditedPlanRevision: { id: audited.id, seq: 1, contentHash: audited.contentHash },
        currentPlanRevision: {
          id: expect.any(Number),
          seq: 2,
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          recorded: true,
        },
        changedSinceAudit: true,
        revisionGap: 1,
        reAudit: {
          decision: 'editing_agent',
          requiredWhen: MATERIAL_CHANGE_TAXONOMY,
          notRequiredWhen: COSMETIC_CHANGE_TAXONOMY,
        },
      },
      value: { ok: true, activationAudit: { status: 'preserved' } },
    });

    const substantive = await withPlanLock<{ ok: true }>(
      {} as never,
      {
        slug: SLUG,
        harnessSlug: HARNESS,
        workspaceId: fx.workspaceId,
        intent: 'test substantive post-audit edit notice',
        afterWrite: async (body) => { await appendPlanRevision(fx.admin, body); },
      },
      async (current) => ({
        newBody: current!.replace('prove the gate', 'prove the gate and preserve backward compatibility'),
        value: { ok: true },
      }),
    );

    expect(substantive).toMatchObject({
      kind: 'applied',
      activationAudit: {
        status: 'preserved',
        auditedPlanRevision: { id: audited.id, seq: 1, contentHash: audited.contentHash },
        currentPlanRevision: {
          id: expect.any(Number),
          seq: 3,
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          recorded: true,
        },
        revisionGap: 2,
        reAudit: {
          decision: 'editing_agent',
          requiredWhen: MATERIAL_CHANGE_TAXONOMY,
          notRequiredWhen: COSMETIC_CHANGE_TAXONOMY,
          instruction: expect.stringContaining("Re-run plans:audit { phase:'activation' }"),
        },
      },
    });

    const auditRows = await fx.admin<Array<{ n: number; audited_seq: number }>>`
      SELECT count(*)::int AS n, max(audited_plan_revision_seq)::int AS audited_seq
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${fx.workspaceId} AND plan_slug = ${SLUG} AND audit_kind = 'activation'`;
    expect(auditRows).toEqual([{ n: 1, audited_seq: 1 }]);
  });
});
