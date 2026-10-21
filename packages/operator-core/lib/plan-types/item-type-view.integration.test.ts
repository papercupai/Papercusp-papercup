/**
 * plan-item-types-registry-cupboard-2026-10-20 P-007 (R-19, R-20, R-25), on real Postgres: the
 * server type view the Plans pane renders, and the completion form's submit.
 *
 * - Every item of a typed plan gets its resolved item type, revision, built-in flag and module
 *   set. An item that declares no type gets the plan type's default item type.
 * - An item type's completion schema reaches the view inline, or through an installed datatype's
 *   payload schema; a datatype nothing installs is reported as unresolved, not as "no fields".
 * - The view reads the plan's pinned revisions: after revision 2 of an item type is defined, a
 *   plan that pinned revision 1 still shows revision 1 and its schema, while an unpinned plan
 *   shows revision 2.
 * - `checkPlanItemTypeFields` refuses exactly what `checkTypeFields` refuses, against the same
 *   pinned contract, and names an unknown plan or item.
 *
 * Item types and plan types are stored through the authoring path `plan-types:define` uses;
 * datatypes through the datatype registry store.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: fixture.sql }),
  withWorkspace: async <T>(workspaceId: string, callback: (sql: postgres.Sql) => Promise<T>): Promise<T> =>
    fixture.sql.begin(async (transaction) => {
      await transaction`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return callback(transaction as unknown as postgres.Sql);
    }) as Promise<T>,
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { activeWorkspaceId } = await import('../workspace-registry');
const { upsertDatatype } = await import('../datatype-registry-store');
const { defineTypeDefinition } = await import('./authoring');
const { pinPlanTypes } = await import('./pins');
const { readPlanItemTypeView, checkPlanItemTypeFields } = await import('./item-type-view');

const OWNER = 'su-item-type-view-fixture';
const HARNESS = 'papercusp';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const NS = `zzz-itv-${RUN}`;

const REVIEW_DATATYPE = `zzz-itv-review-${RUN}`;
const MISSING_DATATYPE = `zzz-itv-missing-${RUN}`;

/** Inline completion schema; revision 2 changes the required field. */
const CLAUSE = `${NS}/clause`;
/** Completion schema by datatype reference. */
const REVIEWED = `${NS}/reviewed-memo`;
/** A datatype reference nothing installs. */
const DANGLING = `${NS}/dangling`;
/** The plan type's default item type: no completion fields, a criteria template. */
const STEP = `${NS}/step`;
const PLAN_TYPE = `${NS}/memo-plan`;

const CLAUSE_V1_SCHEMA = { type: 'object', required: ['clauseRef'], properties: { clauseRef: { type: 'string' } } };
const CLAUSE_V2_SCHEMA = { type: 'object', required: ['memoRef'], properties: { memoRef: { type: 'string' } } };
const REVIEW_SCHEMA = { type: 'object', required: ['reviewer'], properties: { reviewer: { type: 'string', minLength: 1 } } };

function itemType(id: string, extra: Record<string, unknown>, revision = 1) {
  return { schemaVersion: 1, id, revision, title: id, modules: ['generic-core'], ...extra };
}

let db: OrgTestDb;
let planSeq = 0;

/**
 * A plan of PLAN_TYPE: P-001 CLAUSE, P-002 REVIEWED, P-003 DANGLING, P-004 no type (the plan
 * type's default), P-005 the built-in `doc` kind.
 */
async function seedPlan(): Promise<string> {
  planSeq += 1;
  const slug = `zzz-item-type-view-${RUN}-${planSeq}`;
  const content = `---
title: Item type view fixture ${planSeq}
slug: ${slug}
type: ${PLAN_TYPE}
status: active
---

## Work

- **P-001** \`todo\` Draft the clause. deliverable: ${CLAUSE}
- **P-002** \`todo\` Write the reviewed memo. deliverable: ${REVIEWED}
- **P-003** \`todo\` Write the dangling memo. deliverable: ${DANGLING}
- **P-004** \`todo\` Take the next step.
- **P-005** \`todo\` Write the guide. deliverable: doc
`;
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, origin,
       verification_profile, verification_profile_source)
    VALUES (${activeWorkspaceId()}, ${HARNESS}, ${slug}, ${content}, md5(${content}), 1,
            ${`Item type view fixture ${planSeq}`}, 'active', '2026-10-21', '2026-10-21',
            ${OWNER}, false, NULL, 'local', 'general', 'declared')`;
  return slug;
}

function scope(planSlug: string) {
  return { workspaceId: activeWorkspaceId(), harnessSlug: HARNESS, planSlug };
}

async function view(planSlug: string) {
  const result = await readPlanItemTypeView(scope(planSlug));
  expect(result, `view of ${planSlug}`).not.toBeNull();
  return new Map(result!.items.map((item) => [item.itemId, item]));
}

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture.sql = db.adminSql;
  const workspaceId = activeWorkspaceId();
  await upsertDatatype(db.adminSql, {
    id: REVIEW_DATATYPE,
    workspaceId,
    title: 'Reviewed memo',
    description: 'a memo with the name of its reviewer',
    tier: 'generic-kind',
    nature: 'work',
    audience: 'agent',
    payloadSchema: REVIEW_SCHEMA,
  });
  const itemTypes = [
    itemType(CLAUSE, { completion: { schema: CLAUSE_V1_SCHEMA } }),
    itemType(REVIEWED, { completion: { datatypeRef: REVIEW_DATATYPE }, rubricRef: `${NS}-memo-rubric` }),
    itemType(DANGLING, { completion: { datatypeRef: MISSING_DATATYPE } }),
    itemType(STEP, { criteriaTemplate: [{ key: 'dated', title: 'Dated', description: 'States the date its facts were read.' }] }),
  ];
  for (const definition of itemTypes) {
    const stored = await defineTypeDefinition(db.adminSql, { workspaceId, kind: 'item-type', definition, createdBy: OWNER });
    expect(stored, JSON.stringify(stored)).toMatchObject({ ok: true, typeId: definition.id, revision: 1 });
  }
  const planType = {
    schemaVersion: 1,
    id: PLAN_TYPE,
    revision: 1,
    title: 'Memo plan',
    base: 'general',
    classes: ['plan-class-feature-ship'],
    defaultItemType: { id: STEP },
    itemTypes: [{ id: CLAUSE }, { id: REVIEWED }, { id: DANGLING }, { id: STEP }, { id: 'papercusp/doc' }],
  };
  const storedPlanType = await defineTypeDefinition(db.adminSql, { workspaceId, kind: 'plan-type', definition: planType, createdBy: OWNER });
  expect(storedPlanType, JSON.stringify(storedPlanType)).toMatchObject({ ok: true, typeId: PLAN_TYPE, revision: 1 });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('readPlanItemTypeView', () => {
  it('resolves every item: type, revision, built-in flag, modules, completion source and schema', async () => {
    const slug = await seedPlan();
    const result = await readPlanItemTypeView(scope(slug));
    expect(result).toMatchObject({ planSlug: slug, planType: PLAN_TYPE });
    const items = new Map(result!.items.map((item) => [item.itemId, item]));
    expect([...items.keys()]).toEqual(['P-001', 'P-002', 'P-003', 'P-004', 'P-005']);

    expect(items.get('P-001')).toMatchObject({
      itemType: CLAUSE,
      revision: 1,
      builtIn: false,
      modules: ['generic-core'],
      completion: { kind: 'schema' },
      completionSchema: CLAUSE_V1_SCHEMA,
      completionUnresolved: false,
    });
    expect(items.get('P-002')).toMatchObject({
      itemType: REVIEWED,
      completion: { kind: 'datatype', datatypeRef: REVIEW_DATATYPE },
      completionSchema: REVIEW_SCHEMA,
      completionUnresolved: false,
      rubricRef: `${NS}-memo-rubric`,
    });
    // A reference nothing installs is unresolved, never shown as "this type asks for nothing".
    expect(items.get('P-003')).toMatchObject({
      itemType: DANGLING,
      completion: { kind: 'datatype', datatypeRef: MISSING_DATATYPE },
      completionSchema: null,
      completionUnresolved: true,
    });
    // No `deliverable:` -> the plan type's default item type, with its criteria template.
    expect(items.get('P-004')).toMatchObject({
      itemType: STEP,
      builtIn: false,
      completion: null,
      completionSchema: null,
      completionUnresolved: false,
      criteria: [{ key: 'dated', title: 'Dated' }],
    });
    const builtIn = items.get('P-005')!;
    expect(builtIn).toMatchObject({ itemType: 'papercusp/doc', builtIn: true, completion: null });
    expect(builtIn.modules.length).toBeGreaterThan(0);
  });

  it('reads the pinned revision: a pinned plan keeps revision 1 after revision 2 is defined', async () => {
    const pinned = await seedPlan();
    const pinnedCount = await db.adminSql.begin((tx) => pinPlanTypes(
      tx as never,
      scope(pinned) as never,
      {
        verificationProfile: 'general',
        planType: PLAN_TYPE,
        deliverables: [CLAUSE, REVIEWED, DANGLING, 'doc'],
      },
      OWNER,
      'item-type-view fixture activation',
    ));
    expect(pinnedCount).toBeGreaterThan(0);

    const v2 = itemType(CLAUSE, { completion: { schema: CLAUSE_V2_SCHEMA } }, 2);
    const stored = await defineTypeDefinition(db.adminSql, {
      workspaceId: activeWorkspaceId(),
      kind: 'item-type',
      definition: v2,
      createdBy: OWNER,
    });
    expect(stored, JSON.stringify(stored)).toMatchObject({ ok: true, typeId: CLAUSE, revision: 2 });

    expect((await view(pinned)).get('P-001')).toMatchObject({ revision: 1, completionSchema: CLAUSE_V1_SCHEMA });
    const unpinned = await seedPlan();
    expect((await view(unpinned)).get('P-001')).toMatchObject({ revision: 2, completionSchema: CLAUSE_V2_SCHEMA });

    // The submit holds each plan to the contract its view shows.
    expect(await checkPlanItemTypeFields({ ...scope(pinned), itemId: 'P-001', typeFields: { clauseRef: 'C-1' } }))
      .toEqual({ ok: true });
    expect(await checkPlanItemTypeFields({ ...scope(unpinned), itemId: 'P-001', typeFields: { clauseRef: 'C-1' } }))
      .toMatchObject({ ok: false, code: 'item_type_fields_invalid' });
    expect(await checkPlanItemTypeFields({ ...scope(unpinned), itemId: 'P-001', typeFields: { memoRef: 'M-1' } }))
      .toEqual({ ok: true });
  });

  it('returns null for a plan that does not exist', async () => {
    expect(await readPlanItemTypeView(scope(`zzz-item-type-view-${RUN}-absent`))).toBeNull();
  });
});

describe('checkPlanItemTypeFields', () => {
  it('accepts fields that satisfy the datatype schema and refuses ones that do not', async () => {
    const slug = await seedPlan();
    expect(await checkPlanItemTypeFields({ ...scope(slug), itemId: 'P-002', typeFields: { reviewer: 'ana' } }))
      .toEqual({ ok: true });
    const refused = await checkPlanItemTypeFields({ ...scope(slug), itemId: 'P-002', typeFields: { reviewer: '' } });
    expect(refused).toMatchObject({ ok: false, code: 'item_type_fields_invalid' });
    expect((refused as { errors: string[] }).errors.length).toBeGreaterThan(0);
  });

  it('refuses an unresolved datatype, and accepts anything for a type that asks for no fields', async () => {
    const slug = await seedPlan();
    expect(await checkPlanItemTypeFields({ ...scope(slug), itemId: 'P-003', typeFields: {} }))
      .toMatchObject({ ok: false, code: 'item_type_datatype_unresolved' });
    expect(await checkPlanItemTypeFields({ ...scope(slug), itemId: 'P-004', typeFields: {} })).toEqual({ ok: true });
    expect(await checkPlanItemTypeFields({ ...scope(slug), itemId: 'P-005', typeFields: {} })).toEqual({ ok: true });
  });

  it('names an unknown plan item and an unknown plan', async () => {
    const slug = await seedPlan();
    expect(await checkPlanItemTypeFields({ ...scope(slug), itemId: 'P-099', typeFields: {} }))
      .toMatchObject({ ok: false, code: 'plan_item_not_found' });
    expect(await checkPlanItemTypeFields({ ...scope(`zzz-item-type-view-${RUN}-absent`), itemId: 'P-001', typeFields: {} }))
      .toMatchObject({ ok: false, code: 'plan_not_found' });
  });
});
