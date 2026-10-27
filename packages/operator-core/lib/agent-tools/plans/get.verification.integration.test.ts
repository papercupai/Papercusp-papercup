import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { pinPlanTypes } from '../../plan-types/pins';
import { STRICTEST_MODULES } from '../../plan-types/resolve-verification';
import { parsePlanTypeDefinition } from '../../plan-types/definitions';
import type { PlanVerificationSummary } from '../../plan-verification-profile';
import tool from './get';

const HARNESS = 'zzz-get-verification';
const ITEM_TYPE = 'zzz-get-verification/review';
const PLAN_TYPE = 'zzz-get-verification/review-plan';
let fx: PlanPgFixture;

beforeAll(async () => { fx = await setupPlanPgFixture({ isolated: true }); }, 120_000);
afterAll(async () => { await fx?.dispose(); });

async function seed(slug: string, work: string, planType?: string) {
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, slug, `---
slug: ${slug}
title: Verification summary fixture
status: active
${planType ? `type: ${planType}\n` : ''}---

## Work

${work}
`);
}

async function read(slug: string): Promise<PlanVerificationSummary> {
  const result = await tool.handler(tool.args.parse({
    slug, harness: HARNESS, includeEnrichments: false, includeHistory: false,
  }), {
    workspaceId: fx.workspaceId, harnessSlug: HARNESS, role: 'su', isSuperuser: true,
    signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
  });
  expect(result).toHaveProperty('data.results');
  const row = (result as { data: { results: Array<{ ok: boolean; verification: PlanVerificationSummary }> } }).data.results[0]!;
  expect(row.ok).toBe(true);
  return row.verification;
}

describe('plans:get effective verification summary', () => {
  it('reports the same modules for a namespaced built-in and its short alias (review66 G-1)', async () => {
    await seed('builtin-aliases', '- **P-001** `todo` Write a guide. deliverable: papercusp/doc\n- **P-002** `todo` Write another guide. deliverable: doc');
    const summary = await read('builtin-aliases');
    expect(summary.defaultModules).toEqual(['generic-core', 'code']);
    expect(summary.overrides).toEqual([
      { id: 'P-001', deliverable: 'papercusp/doc', modules: ['generic-core'] },
      { id: 'P-002', deliverable: 'doc', modules: ['generic-core'] },
    ]);
    // This list describes additional completion requirements, not the module summary.
    expect(summary.itemTypes).toEqual([]);
  });

  it('uses the declared plan type and its pinned custom item revision for defaults and overrides', async () => {
    const definition = {
      schemaVersion: 1, id: ITEM_TYPE, revision: 1, title: 'Review',
      modules: ['generic-core', 'design-evidence'],
      completion: { schema: { type: 'object', required: ['reviewed'], properties: { reviewed: { type: 'boolean' } } } },
    };
    const planDefinition = {
      schemaVersion: 1, id: PLAN_TYPE, revision: 1, title: 'Review plan', base: 'general',
      classes: ['plan-class-investigation'],
      defaultItemType: { id: ITEM_TYPE }, itemTypes: [{ id: ITEM_TYPE }],
    };
    expect(parsePlanTypeDefinition(planDefinition).ok).toBe(true);
    await fx.admin`INSERT INTO harness_shared.plan_item_type_definitions
      (workspace_id, type_id, revision, definition, origin)
      VALUES (${fx.workspaceId}, ${ITEM_TYPE}, 1, ${fx.admin.json(definition)}, 'workspace')`;
    await fx.admin`INSERT INTO harness_shared.plan_type_definitions
      (workspace_id, type_id, revision, definition, origin)
      VALUES (${fx.workspaceId}, ${PLAN_TYPE}, 1, ${fx.admin.json(planDefinition)}, 'workspace')`;
    const work = '- **P-001** `todo` Review by default.\n- **P-002** `todo` Review explicitly. deliverable: ' + ITEM_TYPE;
    await seed('pinned-review', work, PLAN_TYPE);
    await fx.admin.begin((tx) => pinPlanTypes(tx, {
      workspaceId: fx.workspaceId, harnessSlug: HARNESS, planSlug: 'pinned-review',
    }, { verificationProfile: 'coding', planType: PLAN_TYPE, deliverables: [ITEM_TYPE] }, 'summary-test', 'Pin original review contract'));
    await fx.admin`INSERT INTO harness_shared.plan_item_type_definitions
      (workspace_id, type_id, revision, definition, origin)
      VALUES (${fx.workspaceId}, ${ITEM_TYPE}, 2, ${fx.admin.json({ ...definition, revision: 2, modules: ['generic-core', 'code'] })}, 'workspace')`;
    await seed('latest-review', work, PLAN_TYPE);

    const pinned = await read('pinned-review');
    expect(pinned.profile).toBe('general');
    expect(pinned.defaultDeliverable).toBe(ITEM_TYPE);
    expect(pinned.defaultModules).toEqual(['generic-core', 'design-evidence']);
    expect(pinned.overrides).toEqual([{ id: 'P-002', deliverable: ITEM_TYPE, modules: ['generic-core', 'design-evidence'] }]);
    expect(pinned.itemTypes).toMatchObject([
      { itemId: 'P-001', itemType: ITEM_TYPE, revision: 1, completion: { kind: 'schema' } },
      { itemId: 'P-002', itemType: ITEM_TYPE, revision: 1, completion: { kind: 'schema' } },
    ]);
    const latest = await read('latest-review');
    expect(latest.defaultModules).toEqual(['generic-core', 'code']);
    expect(latest.overrides[0]?.modules).toEqual(['generic-core', 'code']);
    expect(latest.itemTypes?.map(({ revision }) => revision)).toEqual([2, 2]);
  });

  it('shows the strictest module set for an unresolved namespaced item type', async () => {
    await seed('missing-type', '- **P-001** `todo` Review. deliverable: zzz-get-verification/missing');
    expect((await read('missing-type')).overrides).toEqual([
      { id: 'P-001', deliverable: 'zzz-get-verification/missing', modules: [...STRICTEST_MODULES] },
    ]);
  });
});
