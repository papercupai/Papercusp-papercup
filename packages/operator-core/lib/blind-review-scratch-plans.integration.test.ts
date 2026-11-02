/**
 * verification-system-improvements-2026-10-10#D-050 (5), WI-6554700010018458: the post-review
 * cleanup archives exactly the poster's own scratch plans in real PostgreSQL — never the
 * reviewed plan, another reviewer's scratch plans, or a slug that merely contains the prefix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { blindReviewerConfinement } from './blind-reviewer-mint';
import { archiveBlindReviewScratchPlans, archiveScratchPlansByPrefix, blindReviewScratchPrefix } from './blind-review-scratch-plans';

let fx: PlanPgFixture;
const HARNESS = `zzz-br-scratch-${Date.now().toString(36)}`;
const REVIEWED = 'reviewed-plan-2026-10-21';

beforeAll(async () => {
  fx = await setupPlanPgFixture();
});

afterAll(async () => {
  await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
  await fx.dispose();
});

describe('archiveBlindReviewScratchPlans — real archive SQL', () => {
  it('archives only an exact private benchmark prefix and refuses a broad cleanup', async () => {
    const prefix = 'benchmark-scratch-abc123def456-';
    const slugs = [`${prefix}solution`, 'benchmark-scratch-other123456-solution', `x${prefix}solution`, REVIEWED];
    for (const slug of slugs) await seedPlan(fx.admin, fx.workspaceId, HARNESS, slug, `# ${slug}\n`);
    await expect(archiveScratchPlansByPrefix(fx.workspaceId, 'benchmark-scratch-')).rejects.toThrow(/exact private namespace/);
    expect(await archiveScratchPlansByPrefix(fx.workspaceId, prefix)).toBe(1);
    const rows = await fx.admin<{ plan_slug: string; archived: boolean }[]>`
      SELECT plan_slug, archived FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS}
         AND plan_slug = ANY(${slugs})`;
    expect(Object.fromEntries(rows.map(r => [r.plan_slug, r.archived]))).toEqual({
      [`${prefix}solution`]: true, 'benchmark-scratch-other123456-solution': false, [`x${prefix}solution`]: false, [REVIEWED]: false,
    });
    expect(await archiveScratchPlansByPrefix(fx.workspaceId, prefix)).toBe(0);
  });
  it('archives only the poster\'s scratch plans and is idempotent', async () => {
    const prefix = blindReviewScratchPrefix();
    const otherReviewer = blindReviewScratchPrefix();
    const slugs = [`${prefix}one`, `${prefix}two`, `${otherReviewer}three`, REVIEWED, `x${prefix}four`];
    for (const slug of slugs) await seedPlan(fx.admin, fx.workspaceId, HARNESS, slug, `# ${slug}\n`);
    const confinement = blindReviewerConfinement(REVIEWED, undefined, { scratchPrefix: prefix, reviewedSlug: REVIEWED, harness: HARNESS });
    const run = () => archiveBlindReviewScratchPlans({ workspaceId: fx.workspaceId, ownerId: 'su-zzz-scratch-reviewer' },
      { readConfinement: async () => confinement });

    expect(await run()).toEqual({ prefix, archived: 2 });
    const rows = await fx.admin<{ plan_slug: string; archived: boolean }[]>`
      SELECT plan_slug, archived FROM harness_shared.harness_plans
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS}
         AND plan_slug = ANY(${slugs})`;
    expect(Object.fromEntries(rows.map(r => [r.plan_slug, r.archived]))).toEqual({
      [`${prefix}one`]: true, [`${prefix}two`]: true, [`${otherReviewer}three`]: false, [REVIEWED]: false, [`x${prefix}four`]: false,
    });
    expect(await run()).toEqual({ prefix, archived: 0 });
  });
});
