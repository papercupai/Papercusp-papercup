/**
 * typed-properties-db.integration.test.ts — the typed-property DB cycle
 * against real Postgres (work-on-everything-goal-2026-08-23 P-023 / WI-41047,
 * migration 923).
 *
 * Mirrors datatype-registry.integration.test.ts: the module is
 * transport-agnostic (every fn takes the `sql` handle), so the org-fixture's
 * admin client is passed directly, scoped by explicit workspaceId args. This
 * ALSO verifies migration 923 applied on the real baseline (the
 * property_schema/properties columns + their jsonb_typeof CHECKs on BOTH
 * harness_shared.goals and harness_shared.harness_plans).
 *
 * Validates: declaration validation (unknown datatype ref, invalid default,
 * ok); the goal write cycle (ok envelope persisted, CAS stale, editable_by
 * forbidden, datatype-invalid value, unknown property, not_found); the plan
 * write cycle (same core on the harness_plans PK); and derivePropertySurface
 * (effective = stored else declaration default).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { getDatatype, upsertDatatype } from './datatype-registry-store';
import { canonicalWorklistDeclaration } from './goals/package-property-datatypes';
import { ADMIN_COORD_UI_OWNER } from './agent-tools/coordination/identity';
import setGoalProperty from './agent-tools/goals/set-property';
import { readGoalPortfolioBrief } from './goal-launch-settings';
import { setInheritedGoalContext, stampPlanGoalProvenance } from './modes/goal-context';
import { readTypedPropertyCollection } from './typed-properties';
import { setupBaselineCoordFixture } from './_baseline-coord-fixture';
import { gatherCleanupInputs } from './plan-cleanup/gather';
import { scanForCleanupFindings } from './plan-cleanup/scanner';
import { cleanupAutomationEligibility } from './plan-cleanup/automation-policy';
import {
  applyGoalPropertyWrite,
  extendGoalPropertySchema,
  applyPlanPropertyWrite,
  derivePropertySurface,
  validatePropertySchemaDeclaration,
} from './typed-properties-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

// Keep test notifications out of the live coordination log. The tool's authority
// check, typed property writer, and portfolio reader use the real fixture DB.
vi.mock('./agent-tools/coordination/plan-events', () => ({
  emitPlanEventForCaller: vi.fn().mockResolvedValue(undefined),
}));

const WS = 'ws-typed-props';
const HARNESS = 'tp-harness';

describe('typed-properties-db (real PG, migration 923)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // A datatype WITH a payload_schema (values + defaults validate against it)…
    await upsertDatatype(db.adminSql, {
      id: 'string-list',
      workspaceId: WS,
      title: 'String list',
      description: 'A list of strings',
      tier: 'first-class', nature: 'record',
      payloadSchema: { type: 'array', items: { type: 'string' } },
    });
    // …and one WITHOUT (constrains nothing).
    await upsertDatatype(db.adminSql, {
      id: 'freeform',
      workspaceId: WS,
      title: 'Freeform',
      description: 'Unconstrained value',
      tier: 'first-class', nature: 'record',
    });
    // Owning rows: one goal, one plan.
    await db.adminSql`
      INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status, property_schema)
      VALUES
        ('g-tp-1', ${HARNESS}, ${WS}, 'typed props goal', 'active',
         ${JSON.stringify({
           worklist: { datatype: 'string-list', default: ['perf'], editable_by: 'both' },
           budget: { datatype: 'freeform', editable_by: 'owner' },
         })}::text::jsonb),
        ('g-tp-shrink', ${HARNESS}, ${WS}, 'typed props shrink guard', 'active',
         ${JSON.stringify({
           worklist: { datatype: 'string-list', editable_by: 'both' },
         })}::text::jsonb)`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, property_schema)
      VALUES (${WS}, ${HARNESS}, 'tp-plan-2026-08-23', 'typed props plan', 'draft',
              ${JSON.stringify({
                focus: { datatype: 'string-list', editable_by: 'agent' },
              })}::text::jsonb)`;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it.each([false, true])('plan attribution honors the worklist defaultSelected=%s declaration (real PG)', async (defaultSelected) => {
    const sql = db.adminSql;
    // Enrollment seeds built-in datatypes; keep the legacy suite's unseeded
    // workspace independent of these cases and each selection mode.
    const workspaceId = `${WS}-auto-selection-${defaultSelected}`;
    const goalId = `g-tp-auto-selection-${defaultSelected}`;
    const planSlug = `tp-agent-authored-${defaultSelected}`;
    const actorId = `tp-author-${defaultSelected}`;
    const pickedRef = `plan:${HARNESS}/owner-picked`;
    const authoredRef = `plan:${HARNESS}/${planSlug}`;
    const schema = {
      worklist: { ...canonicalWorklistDeclaration(), collection: {
        source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
        selectable: true, defaultSelected,
      } },
      worklist_policy: { datatype: 'ordered-selection-policy', default: { order: [], excluded: [] }, editable_by: 'owner' },
    };
    const original = { worklist: { value: [pickedRef], version: 16,
      edited_by: 'owner', edited_at: '2026-10-11T00:00:00.000Z', provenance: 'owner-edit' } };
    await sql`INSERT INTO harness_shared.goals
      (id, install_slug, workspace_id, title, status, standing, metadata, property_schema, properties)
      VALUES (${goalId}, ${HARNESS}, ${workspaceId}, 'Automatic enrollment fixture', 'active', true,
        ${sql.json({ goalPackageRef: 'work-on-everything' })}, ${JSON.stringify(schema)}::text::jsonb, ${sql.json(original)})`;
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status)
      VALUES (${workspaceId}, ${HARNESS}, ${planSlug}, 'Agent-authored plan', 'active')`;
    expect(await setInheritedGoalContext(workspaceId, actorId, goalId, sql)).toBe(true);
    const globalPg = await setupBaselineCoordFixture({ dsn: db.adminDsn });
    try {
      const inputs = await gatherCleanupInputs({ workspaceId, harnessSlug: HARNESS, planSlugs: [planSlug] });
      expect(inputs.goalWorklist).toMatchObject({ goalId, ownerSelectionRequired: !defaultSelected });
      const enlist = scanForCleanupFindings(inputs, { nowMs: Date.now() }).find((finding) => finding.kind === 'enlist-plan');
      expect(enlist).toBeDefined();
      expect(cleanupAutomationEligibility({ mode: 'safe-high', minConfidence: 'high',
        riskLevels: { low: 'automatic', medium: 'automatic', high: 'automatic' } }, enlist!).allowed)
        .toBe(defaultSelected);
    } finally {
      await globalPg.dispose();
    }
    expect(await stampPlanGoalProvenance({ workspaceId, harnessSlug: HARNESS, planSlug, ownerId: actorId, sql }))
      .toBe(goalId);
    const [plan] = await sql`SELECT goal_id FROM harness_shared.harness_plans
      WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${planSlug}`;
    expect(plan.goal_id).toBe(goalId);
    const [goal] = await sql`SELECT property_schema, properties FROM harness_shared.goals
      WHERE workspace_id = ${workspaceId} AND id = ${goalId}`;
    const expectedRefs = defaultSelected ? [pickedRef, authoredRef] : [pickedRef];
    if (defaultSelected) expect(goal.properties.worklist).toMatchObject({ value: expectedRefs, version: 17,
      edited_by: actorId, provenance: 'agent-edit' });
    else expect(goal.properties).toEqual(original);
    expect(goal.property_schema).toEqual(schema);
    expect(readTypedPropertyCollection({ propertySchema: goal.property_schema, properties: goal.properties,
      property: 'worklist', source: { ok: true, items: [pickedRef, authoredRef] } }))
      .toMatchObject({ ok: true, configured: true, selected: expectedRefs });
  });

  it('persists draft-apply reasons in the same CAS write and rejects an obsolete edit', async () => {
    const schema = { plans: { datatype: 'list', default: ['plan:h/a', 'plan:h/b'], editable_by: 'both',
      collection: { source: 'manual', policy: 'policy', order: 'priority', selectable: true, defaultSelected: true } },
      policy: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } } };
    await db.adminSql.unsafe("INSERT INTO harness_shared.goals (id,install_slug,workspace_id,title,status,property_schema) VALUES ('g-draft-reason',$1,$2,'Draft reason','active',$3::jsonb)",
      [HARNESS, WS, JSON.stringify(schema)]);
    const args = { workspaceId: WS, goalId: 'g-draft-reason', property: 'policy', expectedVersion: 0,
      provenance: 'owner-edit' as const, actorId: 'human', reason: 'Friday demo',
      value: { order: ['plan:h/b', 'plan:h/a'], excluded: [] } };
    const result = await applyGoalPropertyWrite(db.adminSql, args);
    expect(result).toMatchObject({ ok: true, entry: { version: 1, reason: 'Friday demo' } });
    expect(await applyGoalPropertyWrite(db.adminSql, { ...args, reason: 'stale reason' }))
      .toMatchObject({ ok: false, code: 'stale', actualVersion: 1 });
    const [row] = await db.adminSql.unsafe("SELECT properties FROM harness_shared.goals WHERE id='g-draft-reason' AND workspace_id=$1", [WS]);
    expect(row.properties.policy).toMatchObject({ reason: 'Friday demo', version: 1,
      value: { order: ['plan:h/b', 'plan:h/a'], excluded: [] } });
  });

  it('declaration validation: unknown datatype ref and invalid default are refused; a valid doc passes', async () => {
    const unknownRef = await validatePropertySchemaDeclaration(db.adminSql, WS, {
      x: { datatype: 'no-such-datatype', editable_by: 'both' },
    });
    expect(unknownRef.ok).toBe(false);
    if (!unknownRef.ok) expect(unknownRef.issues[0]).toContain("unknown datatype 'no-such-datatype'");

    const badDefault = await validatePropertySchemaDeclaration(db.adminSql, WS, {
      x: { datatype: 'string-list', default: [1, 2], editable_by: 'both' },
    });
    expect(badDefault.ok).toBe(false);
    if (!badDefault.ok) expect(badDefault.issues[0]).toContain('default does not satisfy');

    const good = await validatePropertySchemaDeclaration(db.adminSql, WS, {
      x: { datatype: 'string-list', default: ['a'], editable_by: 'both' },
      y: { datatype: 'freeform', editable_by: 'agent' },
    });
    expect(good).toEqual({ ok: true, declared: ['x', 'y'] });
  });

  it('repairs a legacy goal worklist through the normal writer and preserves its other properties', async () => {
    const budget = {
      value: 50000,
      version: 1,
      edited_at: '2026-09-19T23:59:35.692Z',
      edited_by: 'owner',
      provenance: 'owner-edit',
    };
    const declaration = { budget: { datatype: 'freeform', editable_by: 'owner' } };
    await db.adminSql`
      INSERT INTO harness_shared.goals
        (id, install_slug, workspace_id, title, status, property_schema, properties)
      VALUES ('g-tp-legacy', ${HARNESS}, ${WS}, 'legacy goal', 'active',
              ${JSON.stringify(declaration)}::text::jsonb,
              ${JSON.stringify({ budget })}::text::jsonb)`;
    expect(await getDatatype(db.adminSql, WS, 'plan-ref-list')).toBeNull();

    const write = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-legacy',
      property: 'worklist',
      value: ['plan:tp-harness/tp-plan-2026-08-23'],
      expectedVersion: 0,
      provenance: 'agent-edit',
      actorId: 'goal-holder',
    });
    expect(write).toMatchObject({ ok: true, entry: { version: 1 } });
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-legacy' AND workspace_id = ${WS}`;
    const surface = derivePropertySurface(row!);
    expect(surface.propertySchema).toEqual({ ...declaration, worklist: canonicalWorklistDeclaration() });
    expect(surface.properties.budget).toEqual(budget);
    expect(surface.effective.worklist).toEqual(['plan:tp-harness/tp-plan-2026-08-23']);
    expect(await getDatatype(db.adminSql, WS, 'plan-ref-list')).toMatchObject({ id: 'plan-ref-list' });
  });

  it('repairs a legacy stored worklist without resetting its value or version checks', async () => {
    const worklist = {
      value: ['plan:tp-harness/tp-plan-2026-08-23', 'plan:second'],
      version: 7,
      edited_at: '2026-09-19T23:59:35.692Z',
      edited_by: 'original-holder',
      provenance: 'agent-edit',
    };
    await db.adminSql`
      INSERT INTO harness_shared.goals
        (id, install_slug, workspace_id, title, status, properties)
      VALUES ('g-tp-legacy-stored', ${HARNESS}, ${WS}, 'legacy stored worklist', 'active',
              ${JSON.stringify({ worklist })}::text::jsonb)`;
    const args = {
      workspaceId: WS,
      goalId: 'g-tp-legacy-stored',
      property: 'worklist',
      expectedVersion: 7,
      provenance: 'agent-edit' as const,
      actorId: 'successor-holder',
    };
    expect(await applyGoalPropertyWrite(db.adminSql, {
      ...args, value: worklist.value, expectedVersion: 0,
    })).toMatchObject({ ok: false, code: 'stale', actualVersion: 7 });
    expect(await applyGoalPropertyWrite(db.adminSql, { ...args, value: [] }))
      .toMatchObject({ ok: false, code: 'shrink_blocked', actualVersion: 7 });
    const [before] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-legacy-stored' AND workspace_id = ${WS}`;
    expect(derivePropertySurface(before!).propertySchema).toEqual({});
    expect(derivePropertySurface(before!).properties.worklist).toEqual(worklist);

    const repaired = await applyGoalPropertyWrite(db.adminSql, { ...args, value: worklist.value });
    expect(repaired).toMatchObject({
      ok: true,
      priorValue: worklist.value,
      priorVersion: 7,
      entry: { value: worklist.value, version: 8, edited_by: 'successor-holder' },
    });
    const [after] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-legacy-stored' AND workspace_id = ${WS}`;
    const surface = derivePropertySurface(after!);
    expect(surface.propertySchema.worklist).toEqual(canonicalWorklistDeclaration());
    expect(surface.effective.worklist).toEqual(worklist.value);
    expect(surface.properties.worklist).toMatchObject({ value: worklist.value, version: 8 });
  });

  it('makes an existing goal worklist visible through the property tool and canonical portfolio reader', async () => {
    const value = ['plan:tp-harness/tp-plan-2026-08-23'];
    await db.adminSql`
      INSERT INTO harness_shared.goals
        (id, install_slug, workspace_id, title, status, properties)
      VALUES ('g-tp-tool', ${HARNESS}, ${WS}, 'tool worklist regression', 'active',
              ${JSON.stringify({ worklist: {
                value,
                version: 1,
                edited_at: '2026-09-19T23:59:35.692Z',
                edited_by: 'original-holder',
                provenance: 'agent-edit',
              } })}::text::jsonb)`;
    const result = await db.adminSql.begin(async (tx) => setGoalProperty.handler({
      goalId: 'g-tp-tool',
      property: 'worklist',
      value,
      expectedVersion: 1,
    } as never, {
      workspaceId: WS,
      isSuperuser: true,
      uiClientId: 'su-worklist-integration',
      tx,
    } as never)) as unknown as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: true, goalId: 'g-tp-tool', property: 'worklist', version: 2,
    });
    const portfolio = await readGoalPortfolioBrief({
      workspaceId: WS,
      goalId: 'g-tp-tool',
      sql: db.adminSql,
    });
    expect(portfolio).not.toBeNull();
    expect(portfolio!.worklist).toEqual([
      expect.objectContaining({
        ref: value[0],
        slug: 'tp-plan-2026-08-23',
        title: 'typed props plan',
      }),
    ]);
  });

  it('a worklist edit stamps the goal on NULL-goal rows of the listed plan only (WI-10005246)', async () => {
    const planRef = 'plan:tp-harness/tp-plan-backfill';
    await db.adminSql`
      INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status, properties)
      VALUES ('g-tp-backfill', ${HARNESS}, ${WS}, 'backfill goal', 'active',
              ${JSON.stringify({ worklist: {
                value: [],
                version: 1,
                edited_at: '2026-09-19T23:59:35.692Z',
                edited_by: 'original-holder',
                provenance: 'agent-edit',
              } })}::text::jsonb)`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status)
      VALUES (${WS}, ${HARNESS}, 'tp-plan-backfill', 'backfill plan', 'draft'),
             (${WS}, ${HARNESS}, 'tp-plan-unlisted', 'unlisted plan', 'draft')`;
    const item = (id: string, plan: string, goal: string | null, origin: string) => db.adminSql`
      INSERT INTO harness_shared.work_items (feature_id, workspace_id, harness_slug, nature, source_plan_slug, goal_id, origin)
      VALUES (${id}, ${WS}, ${HARNESS}, 'issue', ${plan}, ${goal}, ${origin})`;
    await item('WI-bf-null', 'tp-plan-backfill', null, 'local');
    await item('WI-bf-owned', 'tp-plan-backfill', 'g-tp-1', 'local');
    await item('WI-bf-remote', 'tp-plan-backfill', null, 'remote');
    await item('WI-bf-unlisted', 'tp-plan-unlisted', null, 'local');

    const result = await db.adminSql.begin(async (tx) => setGoalProperty.handler({
      goalId: 'g-tp-backfill',
      property: 'worklist',
      value: [planRef],
      expectedVersion: 1,
    } as never, {
      workspaceId: WS,
      isSuperuser: true,
      uiClientId: 'su-worklist-backfill',
      tx,
    } as never)) as unknown as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: true,
      attributionBackfill: {
        refs: 1,
        plansStamped: ['tp-plan-backfill'],
        workItemsStamped: ['WI-bf-null'],
      },
    });

    const items = await db.adminSql<Array<{ feature_id: string; goal_id: string | null }>>`
      SELECT feature_id, goal_id FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id LIKE 'WI-bf-%' ORDER BY feature_id`;
    expect(Object.fromEntries(items.map((r) => [r.feature_id, r.goal_id]))).toEqual({
      'WI-bf-null': 'g-tp-backfill', // NULL-goal local row of the listed plan: stamped
      'WI-bf-owned': 'g-tp-1', // already owned by another goal: never reparented
      'WI-bf-remote': null, // federation-owned: left as reported residue
      'WI-bf-unlisted': null, // a plan outside the worklist: untouched
    });
    const plans = await db.adminSql<Array<{ plan_slug: string; goal_id: string | null }>>`
      SELECT plan_slug, goal_id FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND plan_slug IN ('tp-plan-backfill', 'tp-plan-unlisted') ORDER BY plan_slug`;
    expect(Object.fromEntries(plans.map((r) => [r.plan_slug, r.goal_id]))).toEqual({
      'tp-plan-backfill': 'g-tp-backfill',
      'tp-plan-unlisted': null,
    });
  });

  it('does not persist a legacy declaration for an invalid or stale worklist write', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status)
      VALUES ('g-tp-legacy-refused', ${HARNESS}, ${WS}, 'legacy refused goal', 'active')`;
    const args = {
      workspaceId: WS,
      goalId: 'g-tp-legacy-refused',
      property: 'worklist',
      expectedVersion: 0,
      provenance: 'agent-edit' as const,
      actorId: 'goal-holder',
    };
    expect(await applyGoalPropertyWrite(db.adminSql, { ...args, value: ['bare-plan-slug'] }))
      .toMatchObject({ ok: false, code: 'invalid_value', datatype: 'plan-ref-list' });
    expect(await applyGoalPropertyWrite(db.adminSql, {
      ...args, value: ['plan:valid'], expectedVersion: 4,
    })).toMatchObject({ ok: false, code: 'stale', actualVersion: 0 });
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-legacy-refused' AND workspace_id = ${WS}`;
    expect(derivePropertySurface(row!)).toEqual({ propertySchema: {}, properties: {}, effective: {} });
  });

  it('never replaces a custom owner-only worklist declaration with the canonical one', async () => {
    const declaration = { worklist: { datatype: 'string-list', default: ['custom'], editable_by: 'owner' } };
    await db.adminSql`
      INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status, property_schema)
      VALUES ('g-tp-custom-owner', ${HARNESS}, ${WS}, 'custom owner worklist', 'active',
              ${JSON.stringify(declaration)}::text::jsonb)`;
    expect(await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-custom-owner',
      property: 'worklist',
      value: ['plan:valid'],
      expectedVersion: 0,
      provenance: 'agent-edit',
      actorId: 'goal-holder',
    })).toMatchObject({ ok: false, code: 'forbidden', editableBy: 'owner' });
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-custom-owner' AND workspace_id = ${WS}`;
    expect(derivePropertySurface(row!).propertySchema).toEqual(declaration);
  });

  it('preserves a populated legacy worklist and version through stale and invalid writes', async () => {
    const prior = { worklist: { value: ['plan:existing'], version: 7,
      edited_at: '2026-09-19T23:59:35.692Z', edited_by: 'prior-holder', provenance: 'agent-edit' } };
    await db.adminSql`INSERT INTO harness_shared.goals
      (id, install_slug, workspace_id, title, status, properties)
      VALUES ('g-tp-legacy-populated-refused', ${HARNESS}, ${WS}, 'populated legacy refusal', 'active',
        ${JSON.stringify(prior)}::text::jsonb)`;
    const args = { workspaceId: WS, goalId: 'g-tp-legacy-populated-refused', property: 'worklist',
      provenance: 'agent-edit' as const, actorId: 'goal-holder' };
    for (const attempt of [
      { expectedVersion: 6, value: ['plan:replacement'], code: 'stale' },
      { expectedVersion: 7, value: ['bare-plan-slug'], code: 'invalid_value' },
    ]) {
      const result = await db.adminSql.begin((tx) => applyGoalPropertyWrite(tx as unknown as typeof db.adminSql,
        { ...args, expectedVersion: attempt.expectedVersion, value: attempt.value }));
      expect(result).toMatchObject({ ok: false, code: attempt.code });
      const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`SELECT property_schema, properties FROM harness_shared.goals
        WHERE workspace_id = ${WS} AND id = ${args.goalId}`;
      const surface = derivePropertySurface(row!);
      expect(surface.propertySchema).toEqual({});
      expect(surface.properties).toEqual(prior);
    }
    const valid = await db.adminSql.begin((tx) => applyGoalPropertyWrite(tx as unknown as typeof db.adminSql,
      { ...args, expectedVersion: 7, value: ['plan:replacement'] }));
    expect(valid).toMatchObject({ ok: true, entry: { version: 8, value: ['plan:replacement'] } });
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`SELECT property_schema, properties FROM harness_shared.goals
      WHERE workspace_id = ${WS} AND id = ${args.goalId}`;
    expect(derivePropertySurface(row!)).toMatchObject({
      propertySchema: { worklist: canonicalWorklistDeclaration() },
      properties: { worklist: { version: 8, value: ['plan:replacement'] } },
    });
  });

  it('goal write cycle: ok persists the envelope; the follow-up CAS write sees it', async () => {
    const first = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'worklist',
      value: ['docs sweeps'],
      expectedVersion: 0,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.entry.version).toBe(1);
    expect(first.priorValue).toEqual(['perf']); // declaration default

    // Persisted: read the raw column back.
    const rows = await db.adminSql<Array<{ properties: unknown }>>`
      SELECT properties FROM harness_shared.goals WHERE id = 'g-tp-1' AND workspace_id = ${WS}`;
    const doc =
      typeof rows[0]!.properties === 'string'
        ? (JSON.parse(rows[0]!.properties as string) as Record<string, unknown>)
        : (rows[0]!.properties as Record<string, unknown>);
    expect((doc.worklist as { value: unknown; version: number }).value).toEqual(['docs sweeps']);
    expect((doc.worklist as { version: number }).version).toBe(1);
    expect((doc.worklist as { provenance: string }).provenance).toBe('owner-edit');

    // Stale CAS: re-claiming version 0 now refuses with the actual version.
    const stale = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'worklist',
      value: ['x'],
      expectedVersion: 0,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(stale).toMatchObject({ ok: false, code: 'stale', actualVersion: 1 });
  });

  it('goal write cycle: forbidden, invalid value, unknown property, not_found', async () => {
    const forbidden = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'budget',
      value: 5,
      expectedVersion: 0,
      provenance: 'agent-edit', // budget is owner-only
      actorId: 'su-1',
    });
    expect(forbidden).toMatchObject({ ok: false, code: 'forbidden', editableBy: 'owner' });

    const invalid = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'worklist',
      value: [1, 2], // not strings
      expectedVersion: 1,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_value', datatype: 'string-list' });

    const unknown = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'nope',
      value: 1,
      expectedVersion: 0,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(unknown).toMatchObject({ ok: false, code: 'unknown_property' });

    const missing = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-absent',
      property: 'worklist',
      value: [],
      expectedVersion: 0,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(missing).toEqual({ ok: false, code: 'not_found' });
  });

  it('goal write cycle: a rejected array shrink preserves the stored value; explicit confirmation writes it', async () => {
    const initial = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-shrink',
      property: 'worklist',
      value: ['first', 'second', 'third'],
      expectedVersion: 0,
      provenance: 'agent-edit',
      actorId: 'su-1',
    });
    expect(initial.ok).toBe(true);

    const blocked = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-shrink',
      property: 'worklist',
      value: ['first'],
      expectedVersion: 1,
      provenance: 'agent-edit',
      actorId: 'su-1',
    });
    expect(blocked).toMatchObject({
      ok: false,
      code: 'shrink_blocked',
      priorLength: 3,
      proposedLength: 1,
      actualVersion: 1,
      recovery: { confirmShrink: true },
    });

    const afterBlocked = await db.adminSql<Array<{ value: unknown; version: number }>>`
      SELECT properties->'worklist'->'value' AS value,
             (properties->'worklist'->>'version')::int AS version
        FROM harness_shared.goals
       WHERE id = 'g-tp-shrink' AND workspace_id = ${WS}`;
    expect(afterBlocked[0]).toMatchObject({
      value: ['first', 'second', 'third'],
      version: 1,
    });

    const confirmed = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-shrink',
      property: 'worklist',
      value: ['first'],
      expectedVersion: 1,
      confirmShrink: true,
      provenance: 'agent-edit',
      actorId: 'su-1',
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.entry.value).toEqual(['first']);
    expect(confirmed.entry.version).toBe(2);
  });

  it('plan write cycle: same core on the harness_plans PK', async () => {
    const write = await applyPlanPropertyWrite(db.adminSql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: 'tp-plan-2026-08-23',
      property: 'focus',
      value: ['gate triage'],
      expectedVersion: 0,
      provenance: 'agent-edit',
      actorId: 'su-1',
    });
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.entry.version).toBe(1);

    const rows = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'tp-plan-2026-08-23'`;
    const surface = derivePropertySurface(rows[0]!);
    expect(surface.effective.focus).toEqual(['gate triage']);

    // An owner-edit on the agent-only property refuses.
    const forbidden = await applyPlanPropertyWrite(db.adminSql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: 'tp-plan-2026-08-23',
      property: 'focus',
      value: [],
      expectedVersion: 1,
      provenance: 'owner-edit',
      actorId: 'admin',
    });
    expect(forbidden).toMatchObject({ ok: false, code: 'forbidden', editableBy: 'agent' });
  });

  it('derivePropertySurface: effective falls back to the declaration default when unset', () => {
    const surface = derivePropertySurface({
      property_schema: {
        a: { datatype: 'freeform', default: 42, editable_by: 'both' },
        b: { datatype: 'freeform', editable_by: 'both' },
      },
      properties: {},
    });
    expect(surface.effective).toEqual({ a: 42, b: undefined });
  });

  const teaSchema = {
    tea_choices: { datatype: 'string-list', default: ['mint', 'chamomile', 'rooibos'], editable_by: 'both',
      collection: { source: 'manual', policy: 'tea_policy', order: 'display', selectable: true, defaultSelected: true } },
    tea_policy: { datatype: 'ordered-selection-policy', default: { order: [], excluded: [] }, editable_by: 'owner' },
  };

  it('declares and persists a non-plan collection through the same registry and goal CAS writer', async () => {
    const declaration = await validatePropertySchemaDeclaration(db.adminSql, WS, teaSchema);
    expect(declaration).toEqual({ ok: true, declared: ['tea_choices', 'tea_policy'] });
    const datatype = await getDatatype(db.adminSql, WS, 'ordered-selection-policy');
    expect(datatype).toMatchObject({ nature: 'record', payloadSchema: {
      required: ['order', 'excluded'], additionalProperties: false,
      properties: { order: { uniqueItems: true }, excluded: { uniqueItems: true } },
    } });
    await db.adminSql`INSERT INTO harness_shared.goals
      (id, install_slug, workspace_id, title, status, property_schema)
      VALUES ('g-tp-tea', ${HARNESS}, ${WS}, 'Private tea tasting', 'active',
        ${JSON.stringify(teaSchema)}::text::jsonb)`;
    const write = (property: string, value: unknown, expectedVersion: number, provenance: 'owner-edit' | 'agent-edit') =>
      db.adminSql.begin((tx) => applyGoalPropertyWrite(tx as unknown as typeof db.adminSql, {
        workspaceId: WS, goalId: 'g-tp-tea', property, value, expectedVersion, provenance,
        actorId: provenance === 'owner-edit' ? 'owner' : 'source-agent',
      }));
    const preferences = { order: ['rooibos', 'mint'], excluded: ['chamomile'] };
    expect(await write('tea_policy', preferences, 0, 'owner-edit'))
      .toMatchObject({ ok: true, entry: { version: 1, provenance: 'owner-edit' } });
    expect(await write('tea_choices', ['mint', 'chamomile', 'rooibos', 'hibiscus'], 0, 'agent-edit'))
      .toMatchObject({ ok: true });
    expect(await write('tea_policy', { order: [], excluded: [] }, 1, 'agent-edit'))
      .toMatchObject({ ok: false, code: 'forbidden' });
    expect(await write('tea_policy', { order: ['mint', 'mint'], excluded: [] }, 1, 'owner-edit'))
      .toMatchObject({ ok: false, code: 'invalid_value' });
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-tea' AND workspace_id = ${WS}`;
    const reloaded = derivePropertySurface(row!);
    expect(reloaded.propertySchema).toEqual(teaSchema);
    expect(reloaded.effective.tea_policy).toEqual(preferences);
    expect(reloaded.effective.tea_choices).toEqual(['mint', 'chamomile', 'rooibos', 'hibiscus']);
    expect(reloaded.properties.tea_policy).toMatchObject({ version: 1, edited_by: 'owner', provenance: 'owner-edit' });
    expect(await applyGoalPropertyWrite(db.adminSql, { workspaceId: 'other-workspace', goalId: 'g-tp-tea',
      property: 'tea_policy', value: preferences, expectedVersion: 1, provenance: 'owner-edit', actorId: 'owner' }))
      .toEqual({ ok: false, code: 'not_found' });
  });

  it('serializes concurrent owner policy replacements instead of losing either save silently', async () => {
    await validatePropertySchemaDeclaration(db.adminSql, WS, teaSchema);
    await db.adminSql`INSERT INTO harness_shared.goals
      (id, install_slug, workspace_id, title, status, property_schema)
      VALUES ('g-tp-tea-race', ${HARNESS}, ${WS}, 'Private tea CAS race', 'active',
        ${JSON.stringify(teaSchema)}::text::jsonb)`;
    const options = [{ order: ['mint'], excluded: ['rooibos'] }, { order: ['rooibos'], excluded: ['mint'] }];
    const results = await Promise.all(options.map((value, index) => db.adminSql.begin((tx) =>
      applyGoalPropertyWrite(tx as unknown as typeof db.adminSql, { workspaceId: WS,
        goalId: 'g-tp-tea-race', property: 'tea_policy', value, expectedVersion: 0,
        provenance: 'owner-edit', actorId: `owner-${index}` }))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'stale', actualVersion: 1 });
    const winner = results.find((r) => r.ok)!;
    if (!winner.ok) throw new Error('no CAS winner');
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-tea-race' AND workspace_id = ${WS}`;
    expect(derivePropertySurface(row!).properties.tea_policy).toEqual(winner.entry);
  });

  it('enrolls an unpackaged goal through an additive schema CAS without changing saved properties', async () => {
    const legacy = { tea_choices: { datatype: 'string-list', default: ['mint', 'chamomile'], editable_by: 'both' } };
    const saved = { tea_choices: { value: ['rooibos', 'mint'], version: 7, edited_by: 'agent',
      edited_at: '2026-10-07T00:00:00Z', provenance: 'agent-edit' } };
    await db.adminSql`INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status,
      property_schema, properties) VALUES ('g-tp-legacy-collection', ${HARNESS}, ${WS}, 'Legacy tea goal', 'active',
        ${JSON.stringify(legacy)}::jsonb, ${JSON.stringify(saved)}::jsonb)`;
    const patch = { tea_choices: { ...legacy.tea_choices, collection: { source: 'manual', policy: 'tea_policy',
      order: 'display', selectable: true, defaultSelected: true } },
      tea_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } } };
    const applied = await db.adminSql.begin((tx) => extendGoalPropertySchema(tx as unknown as typeof db.adminSql,
      { workspaceId: WS, goalId: 'g-tp-legacy-collection', patch, expected: legacy }));
    expect(applied).toMatchObject({ ok: true });
    const [row] = await db.adminSql`SELECT properties, property_schema FROM harness_shared.goals
      WHERE workspace_id = ${WS} AND id = 'g-tp-legacy-collection'`;
    expect(row.properties).toEqual(saved);
    expect(row.property_schema).toEqual(patch);
    expect(await db.adminSql.begin((tx) => extendGoalPropertySchema(tx as unknown as typeof db.adminSql,
      { workspaceId: WS, goalId: 'g-tp-legacy-collection', patch, expected: legacy })))
      .toEqual({ ok: false, code: 'stale_schema' });
    const tampered = { tea_choices: { ...patch.tea_choices, collection: { ...patch.tea_choices.collection, defaultSelected: false } } };
    expect(await db.adminSql.begin((tx) => extendGoalPropertySchema(tx as unknown as typeof db.adminSql,
      { workspaceId: WS, goalId: 'g-tp-legacy-collection', patch: tampered, expected: patch })))
      .toEqual({ ok: false, code: 'owner_policy_declaration' });
    const invalid = { bad: { datatype: 'missing-registry-type', editable_by: 'both' } };
    expect(await db.adminSql.begin((tx) => extendGoalPropertySchema(tx as unknown as typeof db.adminSql,
      { workspaceId: WS, goalId: 'g-tp-legacy-collection', patch: invalid, expected: patch })))
      .toMatchObject({ ok: false, code: 'invalid_schema' });
  });

  it('the authenticated door protects owner policy and never attributes discovered worklist candidates', async () => {
    const planRef = 'plan:tp-harness/tp-discovered';
    const schema = {
      worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both',
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: true } },
      worklist_policy: teaSchema.tea_policy,
    };
    await db.adminSql`INSERT INTO harness_shared.goals
      (id, install_slug, workspace_id, title, status, property_schema)
      VALUES ('g-tp-discovered', ${HARNESS}, ${WS}, 'Private discovered work', 'active',
        ${JSON.stringify(schema)}::text::jsonb)`;
    await db.adminSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status)
      VALUES (${WS}, ${HARNESS}, 'tp-discovered', 'Private discoverable plan', 'active')`;
    await db.adminSql`INSERT INTO harness_shared.work_items
      (feature_id, workspace_id, harness_slug, nature, source_plan_slug, origin)
      VALUES ('WI-tp-discovered', ${WS}, ${HARNESS}, 'issue', 'tp-discovered', 'local')`;
    const call = async (property: string, value: unknown, ownerId: string) => {
      const r = await db.adminSql.begin((tx) => setGoalProperty.handler({
        goalId: 'g-tp-discovered', property, value, expectedVersion: 0,
      } as never, { workspaceId: WS, isSuperuser: true, uiClientId: ownerId, tx } as never)) as unknown as
        { isError?: boolean; content: Array<{ text: string }> };
      return JSON.parse(r.content[0]!.text);
    };
    expect(await call('worklist_policy', { order: [planRef], excluded: [] }, 'su-source-agent'))
      .toMatchObject({ error: 'forbidden' });
    expect(await call('worklist_policy', { order: ['plan:ambiguous'], excluded: [] }, ADMIN_COORD_UI_OWNER))
      .toMatchObject({ error: 'invalid_value' });
    expect(await call('worklist_policy', { order: [planRef], excluded: ['plan:other/dormant'] }, ADMIN_COORD_UI_OWNER))
      .toMatchObject({ ok: true, version: 1, provenance: 'owner-edit' });
    const updated = await call('worklist', [planRef], 'su-source-agent');
    expect(updated).toMatchObject({ ok: true, version: 1 });
    expect(updated).not.toHaveProperty('attributionBackfill');
    const [plan] = await db.adminSql<Array<{ goal_id: string | null }>>`SELECT goal_id FROM harness_shared.harness_plans
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'tp-discovered'`;
    const [item] = await db.adminSql<Array<{ goal_id: string | null }>>`SELECT goal_id FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND feature_id = 'WI-tp-discovered'`;
    expect(plan!.goal_id).toBeNull();
    expect(item!.goal_id).toBeNull();
  });
});
