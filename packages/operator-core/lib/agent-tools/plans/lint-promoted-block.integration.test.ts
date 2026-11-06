import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeWorkspaceId } from '../../workspace-registry';
import { setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { lintParsed } from './lint';
import { parsePlan } from './parser';

const run = Math.random().toString(36).slice(2);
const harness = `lint-promotion-${run}`;
const slug = `lint-promotion-${run}`;
let fixture: PlanPgFixture;

const body = (created = '2026-11-05') => `---
title: Promotion receipt regression
slug: ${slug}
status: draft
created: ${created}
---
# Promotion receipt regression
## Phase 1
- **P-001** \`todo\` Prepare the draft
## Decisions
## Now
**State:** Draft
**Next:** Review
`;

beforeAll(async () => { fixture = await setupPlanPgFixture(); }, 120_000);
afterAll(async () => {
  if (!fixture) return;
  await fixture.admin`DELETE FROM harness_shared.work_items WHERE harness_slug = ${harness}`;
  await fixture.dispose();
});

async function findings() {
  const report = await lintParsed(parsePlan(body()), slug, false);
  return [...report.errors, ...report.warnings].filter(f => f.code === 'missing_promoted_block');
}

describe('promotion receipts distinguish draft nodes from promoted work', () => {
  it('does not require promotion for a canonical draft node, but retains real promotion proof', async () => {
    const workspace = activeWorkspaceId();
    await fixture.admin`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind,
         source_plan_slug, source_plan_item_ids, plan_slug, plan_line_id)
      VALUES (${workspace}, ${harness}, ${`WI-${Date.now()}`}, 'Draft node', 'open', 'feature',
        ${slug}, ARRAY['P-001'], ${slug}, 'P-001')`;
    expect(await findings()).toEqual([]);

    // Migration can adopt an already-promoted feature as a canonical line.
    await fixture.admin`UPDATE harness_shared.work_items
      SET metadata = jsonb_build_object('source_plan', ${slug}::text)
      WHERE harness_slug = ${harness}`;
    const proof = await fixture.admin<{ n: number }[]>`SELECT COUNT(*)::int AS n
      FROM harness_shared.work_items WHERE workspace_id = ${workspace}
      AND source_plan_slug = ${slug} AND metadata ->> 'source_plan' = source_plan_slug`;
    expect(proof[0]?.n).toBe(1);
    expect(await findings()).toMatchObject([{ level: 'error', code: 'missing_promoted_block' }]);

    await fixture.admin`UPDATE harness_shared.work_items
      SET metadata = '{}'::jsonb, payload = '{"plan_item":{"item_id":"P-001"}}'::jsonb
      WHERE harness_slug = ${harness}`;
    // Draft item-text reconciliation also stamps plan_item; it is not promotion proof.
    expect(await findings()).toEqual([]);

    // Historical promoted features without a canonical line still require a receipt.
    await fixture.admin`UPDATE harness_shared.work_items
      SET plan_slug = NULL, plan_line_id = NULL, payload = '{}'::jsonb
      WHERE harness_slug = ${harness}`;
    expect(await findings()).toHaveLength(1);
    const old = await lintParsed(parsePlan(body('2026-05-01')), slug, false);
    expect(old.warnings.some(f => f.code === 'missing_promoted_block')).toBe(true);
    const recorded = await lintParsed(parsePlan(`${body()}\n## Promoted\nRecorded\n`), slug, false);
    expect([...recorded.errors, ...recorded.warnings].some(f => f.code === 'missing_promoted_block')).toBe(false);
  });
});
