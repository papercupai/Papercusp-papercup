import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-omitted-review';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', async (orig) => ({
  ...await orig<typeof import('../workspace-registry')>(), activeWorkspaceId: () => WS,
}));
const { sweepOmittedReviews, OMITTED_REVIEW_AGE_MS } = await import('./review-stall-reaper');
const { trackAmendRun, getAmendReceipt } = await import('../agent-tools/rubrics/amend-receipts');
let db: OrgTestDb;
const now = Date.now();
const ownerId = 'su-omitted-review-fixture';
const plan = 'omitted-review-plan';
const rubric = `acceptance-${plan}`;
const retryArgs = { rubricRef: rubric, dryRun: true, criterion: { key: 'r-1', field: 'model', mode: 'replace', text: 'An answer reaches its asking session.' } };
beforeAll(async () => { db = await createOrgTestDb(); h.sql = db.adminSql; }, 180_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await h.sql`DELETE FROM harness_shared.rubric_amend_receipts WHERE workspace_id = ${WS}`;
  await h.sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
});

async function seed(key: string, options: { age?: number; state?: string; owner?: string; approvalRequired?: boolean; reviewState?: string } = {}) {
  await h.sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, source_plan_slug, created_ts, updated_ts, payload)
    VALUES (${WS}, 'papercusp', ${`WI-${key}`}, 'change', 'omitted review fixture', ${options.state ?? 'blocked'},
      ${ownerId}, ${`${plan}-${key}`}, 100, 0, '{}'::jsonb)`;
  await trackAmendRun(key, rubric, async () => ({ ok: true, dryRun: true,
    preview: { approvalRequired: options.approvalRequired ?? true, approval: { subjectPlan: `${plan}-${key}` } },
    review: { state: options.reviewState ?? 'not-requested' },
  }), { omittedReviewRecovery: { ownerId, retryArgs } });
  await h.sql`UPDATE harness_shared.rubric_amend_receipts
    SET finished_at = ${new Date(now - (options.age ?? OMITTED_REVIEW_AGE_MS + 1)).toISOString()}::timestamptz
    WHERE workspace_id = ${WS} AND idempotency_key = ${key}`;
  if (options.owner) await h.sql`UPDATE harness_shared.work_items SET taken_by = ${options.owner}
    WHERE workspace_id = ${WS} AND feature_id = ${`WI-${key}`}`;
}

describe('omitted review recovery — real receipt and carrier stores', () => {
  it('persists the exact retry and emits one nudge across repeated and concurrent ticks', async () => {
    await seed('exact');
    expect((await getAmendReceipt(rubric, 'exact'))?.result?._reviewRecovery).toEqual({ ownerId, retryArgs,
      carrier: { workItemId: 'WI-exact', harness: 'papercusp' } });
    const send = vi.fn(async () => {});
    const wake = vi.fn(async () => {});
    const clearWall = vi.fn(async () => {});
    const results = await Promise.all([sweepOmittedReviews({ now, send, wake, clearWall }), sweepOmittedReviews({ now, send, wake, clearWall })]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(results.reduce((n, r) => n + r.nudged, 0)).toBe(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ownerId, workItemId: 'WI-exact', harness: 'papercusp', msgId: expect.stringMatching(/^coord-send-[a-f0-9]{64}$/),
      retry: { tool: 'rubrics:amend', args: { ...retryArgs, requestReview: { workItemId: 'WI-exact', harness: 'papercusp' } } },
    }));
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await sweepOmittedReviews({ now, send, wake, clearWall })).nudged).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('leaves a delivery failure eligible for retry', async () => {
    await seed('retry');
    const failed = await sweepOmittedReviews({ now, send: async () => { throw new Error('delivery unavailable'); } });
    expect(failed.nudged).toBe(0);
    expect(failed.errors[0]).toContain('delivery unavailable');
    expect((await getAmendReceipt(rubric, 'retry'))?.result?._reviewRecovery).not.toHaveProperty('nudgedAt');
    const next = await sweepOmittedReviews({ now, send: async () => {}, wake: async () => {}, clearWall: async () => {} });
    expect(next.nudged).toBe(1);
  });

  it('retries wall cleanup after delivery without sending a second nudge', async () => {
    await seed('cleanup-retry');
    const send = vi.fn(async () => {});
    const first = await sweepOmittedReviews({ now, send, clearWall: async () => { throw new Error('wall store unavailable'); } });
    expect(first.errors[0]).toContain('wall store unavailable');
    expect(first.nudged).toBe(1);
    // Ordinary receipt GC must not drop the remaining cleanup after a durable
    // nudge. A later unrelated amendment is the production GC trigger.
    await h.sql`UPDATE harness_shared.rubric_amend_receipts
      SET finished_at = ${new Date(now - 2 * 60 * 60 * 1000).toISOString()}::timestamptz
      WHERE workspace_id = ${WS} AND idempotency_key = 'cleanup-retry'`;
    await trackAmendRun('gc-trigger', 'unrelated-rubric', async () => ({ ok: true }));
    expect(await getAmendReceipt(rubric, 'cleanup-retry')).toBeDefined();
    const clearWall = vi.fn(async () => {});
    const second = await sweepOmittedReviews({ now, send, clearWall, wake: async () => {} });
    expect(second.errors).toEqual([]);
    expect(clearWall).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await sweepOmittedReviews({ now, send, clearWall, wake: async () => {} })).examined).toBe(0);
    await trackAmendRun('gc-after-completion', 'unrelated-rubric', async () => ({ ok: true }));
    expect(await getAmendReceipt(rubric, 'cleanup-retry')).toBeUndefined();
  });

  it('ignores recent, already-requested, approval-free, active and reassigned cases', async () => {
    await seed('recent', { age: OMITTED_REVIEW_AGE_MS - 1 });
    await seed('routed', { reviewState: 'routed' });
    await seed('approval-free', { approvalRequired: false });
    await seed('active', { state: 'open' });
    await seed('reassigned', { owner: 'another-agent' });
    const send = vi.fn(async () => {});
    expect(await sweepOmittedReviews({ now, send })).toEqual({ examined: 0, nudged: 0, errors: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves unrelated owner questions when recording an omitted-review nudge', async () => {
    await seed('owner-wall', { state: 'needs-human' });
    const blocker = { kind: 'human', capability: 'product-decision', capabilitySource: 'explicit', ref: 'unrelated-owner-choice',
      summary: 'Choose the commercial terms', status: 'active', createdBy: ownerId,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), nextVerb: 'coord:ask-owner' };
    const payload = { needsOwnerAction: true, externalBlockers: [blocker], sibling: 'preserved' };
    await h.sql`UPDATE harness_shared.work_items SET payload = ${JSON.stringify(payload)}::jsonb WHERE workspace_id = ${WS} AND feature_id = 'WI-owner-wall'`;
    const result = await sweepOmittedReviews({ now, send: async () => {}, wake: async () => {} });
    expect(result.errors).toEqual([]);
    expect(result.nudged).toBe(1);
    const [row] = await h.sql<{ status: string; payload: unknown }[]>`SELECT status, payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'WI-owner-wall'`;
    expect(row).toEqual({ status: 'needs-human', payload });
  });

  it('retains an unnudged omitted review beyond ordinary receipt garbage collection', async () => {
    await seed('retained', { age: 2 * 60 * 60 * 1000 });
    await trackAmendRun('another-amend', 'another-rubric', async () => ({ ok: true }));
    expect(await getAmendReceipt(rubric, 'retained')).toBeDefined();
    expect((await sweepOmittedReviews({ now, send: async () => {}, wake: async () => {}, clearWall: async () => {} })).nudged).toBe(1);
  });
});
