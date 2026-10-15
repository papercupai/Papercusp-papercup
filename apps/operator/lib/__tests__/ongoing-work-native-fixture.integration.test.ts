import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../../packages/operator-core/test/_org-test-db';
import { insertNativeCollectionGoal, insertNativeCollectionPlan, nativeCollectionDeclaration, setNativeCollectionPlanArchived } from '../../e2e/_ongoing-work-native-fixture';
import { isWorkOnEverything } from '../../app/adv/hud/ongoing-work-draft';
import type { GoalDetailInput } from '../../app/adv/hud/goal-detail-model';
import { readGoalPortfolioBrief } from '../../../../packages/operator-core/lib/goal-launch-settings';
import { applyGoalPropertyWrite } from '../../../../packages/operator-core/lib/typed-properties-db';
import { ensureOrderedSelectionPolicyDatatype, ensurePlanRefListDatatype } from '../../../../packages/operator-core/lib/goals/package-property-datatypes';

let sql: ReturnType<typeof postgres>;
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql }),
}));

describe('native collection fixture against migrated private PG', () => {
  let db: OrgTestDb;
  const schema = {
    tea_choices: { datatype: 'string-list', editable_by: 'both', default: ['mint', 'rooibos'],
      collection: { source: 'manual', policy: 'tea_policy', order: 'display', selectable: true, defaultSelected: true } },
    tea_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } },
  };

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Use the native fixture's DEFAULT driver, rather than the org fixture's
    // restored raw JSONB serializer, which would hide this defect.
    sql = postgres(db.adminDsn, { max: 1, connect_timeout: 5 });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.cleanup();
  });

  it('persists the actual native seed as a JSONB object with the original declaration', async () => {
    await insertNativeCollectionGoal(sql, { workspaceId: 'native-seed-test', goalId: 'native-seed-positive',
      title: 'Native tea collection', schema });
    const [row] = await sql`SELECT jsonb_typeof(property_schema) AS kind, property_schema
      FROM harness_shared.goals WHERE workspace_id='native-seed-test' AND id='native-seed-positive'`;
    expect(row.kind).toBe('object');
    expect(row.property_schema).toEqual(schema);
  });

  it('distinguishes default-driver double encoding from an invalid declaration', async () => {
    const [row] = await sql`SELECT jsonb_typeof(${JSON.stringify(schema)}::jsonb) AS kind`;
    expect(row.kind).toBe('string');
    await expect(sql`INSERT INTO harness_shared.goals
      (workspace_id,id,install_slug,title,status,property_schema)
      VALUES ('native-seed-test','native-seed-negative','native-seed-negative','Native tea collection','active',
              ${JSON.stringify(schema)}::jsonb)`).rejects.toMatchObject({
        code: '23514', constraint_name: 'goals_property_schema_object',
      });
  });

  it('keeps the actual generic native declaration on the generic presentation and applies its named policy to admission', async () => {
    const workspaceId = 'native-admission-test', goalId = 'native-admission-positive', harness = 'native-admission';
    const ids = ['alpha', 'beta', 'blocked'].map(slug => `plan:${harness}/${slug}`);
    const { property, policyName, schema } = nativeCollectionDeclaration('plans', ids,
      { order: [ids[1], ids[0], ids[2]], excluded: [] });
    await ensureOrderedSelectionPolicyDatatype(sql, workspaceId);
    await ensurePlanRefListDatatype(sql, workspaceId);
    await insertNativeCollectionGoal(sql, { workspaceId, goalId, title: 'Native admission', schema });
    for (const slug of ['alpha', 'beta', 'blocked']) {
      await insertNativeCollectionPlan(sql, { workspaceId, harness, slug, title: slug,
        status: slug === 'blocked' ? 'draft' : 'active' });
    }
    const read = () => readGoalPortfolioBrief({ workspaceId, goalId, sql, claimability: 'skip' });
    const { resolveGoalDetail } = await import('../../../../packages/operator-core/lib/sync-resolver/goals');
    const detail = await resolveGoalDetail({ workspaceId, goalId }) as unknown as GoalDetailInput;
    expect(detail.goal?.goalPackage).toBeNull();
    expect(isWorkOnEverything(detail)).toBe(false);
    expect(detail.goalData?.collections[property].selection).toMatchObject({
      ok: true, configured: true, collection: { policy: policyName },
    });
    // The same read with the legacy declaration is the opposing presentation control.
    const worklistDeclaration = detail.goalData?.propertySchema?.worklist;
    expect(worklistDeclaration).toBeDefined();
    if (!worklistDeclaration) throw new Error('Fixture did not return its worklist declaration');
    expect(isWorkOnEverything({ ...detail, goalData: { ...detail.goalData!, propertySchema: {
      ...detail.goalData!.propertySchema, worklist: { ...worklistDeclaration,
        collection: { ...worklistDeclaration.collection!, policy: 'worklist_policy' } },
    } } })).toBe(true);
    const brief = await read();
    expect(brief?.worklist.map(plan => plan.slug)).toEqual(['beta', 'alpha', 'blocked']);
    expect(brief?.worklist.find(plan => plan.slug === 'beta')).toMatchObject({
      next: { id: 'P-001' }, counts: { todo: 1 },
      placement: { state: 'unplaced', reconciliation: { toolCall: { tool: 'fleet:launch-on-plan' } } },
    });
    expect(brief?.worklist.find(plan => plan.placement.reconciliation.toolCall !== null)?.slug).toBe('beta');
    expect(brief?.worklist.find(plan => plan.slug === 'blocked')?.placement.reconciliation.toolCall).toBeNull();

    // Keep the legacy metadata intact while removing the canonical source.
    // This distinguishes a fixture-source defect from ordering/admission logic.
    await sql`DELETE FROM harness_shared.plan_items
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`;
    const [metadata] = await sql`SELECT jsonb_array_length(items) AS count FROM harness_shared.harness_plans
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`;
    expect(metadata.count).toBe(1);
    expect((await read())?.worklist.find(plan => plan.slug === 'beta')).toMatchObject({
      next: null, counts: { todo: 0 },
      placement: { state: 'blocked', reconciliation: { toolCall: null } },
    });

    const written = await sql.begin(tx => applyGoalPropertyWrite(tx as unknown as typeof sql, {
      workspaceId, goalId, property: policyName, value: { order: ids, excluded: [ids[1]] },
      expectedVersion: 0, provenance: 'owner-edit', actorId: 'native-generic-owner',
    }));
    expect(written).toMatchObject({ ok: true });
    const persisted = await resolveGoalDetail({ workspaceId, goalId }) as unknown as GoalDetailInput;
    expect(isWorkOnEverything(persisted)).toBe(false);
    expect(persisted.goalData?.properties?.[policyName]).toMatchObject({
      version: 1, provenance: 'owner-edit', value: { order: ids, excluded: [ids[1]] },
    });
    expect(persisted.goalData?.properties?.worklist_policy).toBeUndefined();
    const reordered = await read();
    expect(reordered?.worklist.map(plan => plan.ref)).toEqual(ids);
    expect(reordered?.worklist.find(plan => plan.slug === 'beta')).toMatchObject({
      selected: false, placement: { reconciliation: { toolCall: null } },
    });
    expect(reordered?.worklist.find(plan => plan.placement.reconciliation.toolCall !== null)?.slug).toBe('alpha');
  });

  it('preserves owner order, exclusion and attribution through native archive, agent refresh and rediscovery', async () => {
    const workspaceId = 'native-lifecycle-test', goalId = 'native-lifecycle-positive', harness = 'native-lifecycle';
    const ids = ['alpha', 'beta', 'blocked'].map(slug => `plan:${harness}/${slug}`);
    const dormant = `plan:${harness}/dormant`;
    const order = [ids[1], ids[0], ids[2], dormant];
    await ensureOrderedSelectionPolicyDatatype(sql, workspaceId);
    await ensurePlanRefListDatatype(sql, workspaceId);
    await insertNativeCollectionGoal(sql, { workspaceId, goalId, title: 'Native lifecycle', schema: {
      worklist: { datatype: 'plan-ref-list', editable_by: 'both', default: ids,
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
          selectable: true, defaultSelected: true } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: [], excluded: [] } },
    } });
    for (const slug of ['alpha', 'beta', 'blocked']) {
      await insertNativeCollectionPlan(sql, { workspaceId, harness, slug, title: slug,
        status: slug === 'blocked' ? 'draft' : 'active' });
    }
    const write = (property: string, value: unknown, provenance: 'owner-edit' | 'agent-edit', confirmShrink = false) =>
      sql.begin(tx => applyGoalPropertyWrite(tx as unknown as typeof sql, { workspaceId, goalId,
        property, value, expectedVersion: 0, provenance, confirmShrink, actorId: `native-fixture-${provenance}` }));
    expect(await write('worklist_policy', { order, excluded: [dormant, ids[1]] }, 'owner-edit')).toMatchObject({ ok: true });
    const policy = async () => (await sql`SELECT properties->'worklist_policy' AS policy
      FROM harness_shared.goals WHERE workspace_id=${workspaceId} AND id=${goalId}`)[0].policy;
    const savedPolicy = await policy();
    const read = () => readGoalPortfolioBrief({ workspaceId, goalId, sql, claimability: 'skip' });
    const { resolveGoalDetail } = await import('../../../../packages/operator-core/lib/sync-resolver/goals');
    const detail = async () => (await resolveGoalDetail({ workspaceId, goalId }) as {
      goalData: { collections: { worklist: { rows: Array<{ id: string; selected: boolean }> } } };
    }).goalData.collections.worklist;
    expect((await read())?.worklist.map(plan => plan.ref)).toEqual(order.slice(0, 3));
    expect((await read())?.worklist.find(plan => plan.slug === 'beta')?.selected).toBe(false);
    expect((await detail()).rows.find(row => row.id === ids[1])).toMatchObject({ selected: false });

    await setNativeCollectionPlanArchived(sql, { workspaceId, harness, slug: 'beta', archived: true });
    const lifecycle = async () => (await sql`SELECT status,archived FROM harness_shared.harness_plans
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`)[0];
    expect(await lifecycle()).toMatchObject({ status: 'active', archived: true });
    expect(await write('worklist', [ids[0], ids[2]], 'agent-edit')).toMatchObject({
      ok: false, code: 'shrink_blocked', priorLength: 3, proposedLength: 2, actualVersion: 0,
    });
    expect(await policy()).toEqual(savedPolicy);
    expect(await write('worklist', [ids[0], ids[2]], 'agent-edit', true)).toMatchObject({ ok: true });
    expect((await read())?.worklist.map(plan => plan.ref)).toEqual([ids[0], ids[2]]);
    expect((await detail()).rows.map(row => row.id)).toEqual([ids[0], ids[2]]);
    expect(await policy()).toEqual(savedPolicy);

    await setNativeCollectionPlanArchived(sql, { workspaceId, harness, slug: 'beta', archived: false });
    expect(await lifecycle()).toMatchObject({ status: 'active', archived: false });
    const rediscovered = await read();
    expect(rediscovered?.worklist.map(plan => plan.ref)).toEqual(order.slice(0, 3));
    expect(rediscovered?.worklist.find(plan => plan.slug === 'beta')).toMatchObject({ selected: false, next: { id: 'P-001' } });
    const rediscoveredDetail = await detail();
    expect(rediscoveredDetail.rows.map(row => row.id)).toEqual(order.slice(0, 3));
    expect(rediscoveredDetail.rows.find(row => row.id === ids[1])).toMatchObject({ selected: false });
    expect(await policy()).toEqual(savedPolicy);
    expect(savedPolicy).toMatchObject({ version: 1, provenance: 'owner-edit', value: { order, excluded: [dormant, ids[1]] } });
  });

  it('rejects the item-status alias done before a native lifecycle assertion can run', async () => {
    const workspaceId = 'native-invalid-lifecycle-test', harness = 'native-invalid-lifecycle';
    await insertNativeCollectionPlan(sql, { workspaceId, harness, slug: 'beta', title: 'beta', status: 'active' });
    await expect(sql`UPDATE harness_shared.harness_plans SET archived=true,status='done'
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'harness_plans_status_check' });
    const [row] = await sql`SELECT status,archived FROM harness_shared.harness_plans
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`;
    expect(row).toMatchObject({ status: 'active', archived: false });
    await expect(sql`UPDATE harness_shared.harness_plans SET status='shipped'
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`)
      .rejects.toThrow(/requires a matching acceptance gate receipt/);
  });
});
