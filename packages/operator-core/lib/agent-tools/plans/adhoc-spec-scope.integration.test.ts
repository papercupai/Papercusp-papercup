/**
 * WI-10006321 — the ad-hoc spec scope's body matches its own plan_revisions row.
 *
 * The plan-parts reconcile sweep dates a body by joining plan_revisions on
 * `harness_plans.content_hash`. `resolveSpecScopeSlug` used to insert the scope with
 * `content` only, so `content_hash` kept its '' default. The revision recorded beside it
 * carried the real hash and could never match, and the live `adhoc-work-item-specs` row sat
 * with no content clock. This drives the real writer against a migrated database and asserts
 * the join the sweep relies on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { ADHOC_SCOPE_CONTENT, ADHOC_WORK_ITEM_SPEC_SCOPE, resolveSpecScopeSlug } from './adhoc-spec-scope';

const { createOrgTestDb } = await import('../../../test/_org-test-db');

const WS = 'adhoc-spec-scope-test';
const HARNESS = 'adhoc-scope-harness';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.adminSql`DELETE FROM harness_shared.plan_revisions WHERE workspace_id = ${WS}`;
  await db.adminSql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`;
});

describe('resolveSpecScopeSlug materialises a scope whose body has a content clock', () => {
  it('writes content_hash with the body, and the reconcile join finds the recorded revision', async () => {
    const slug = await db.adminSql.begin((tx) => resolveSpecScopeSlug(tx as never, WS, HARNESS, null));
    expect(slug).toBe(ADHOC_WORK_ITEM_SPEC_SCOPE);

    const [plan] = await db.adminSql<Array<{ content: string; content_hash: string }>>`
      SELECT content, content_hash FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
    expect(plan!.content).toBe(ADHOC_SCOPE_CONTENT);
    // Calibration: the stored hash is the canonical one, not the column's '' default.
    expect(plan!.content_hash).toBe(hashPlanContent(ADHOC_SCOPE_CONTENT));

    // The exact predicate plan-parts/reconcile.ts defaultLoadPlans joins on.
    const matched = await db.adminSql<Array<{ seq: number; author_id: string }>>`
      SELECT r.seq, r.author_id
        FROM harness_shared.harness_plans p
        JOIN harness_shared.plan_revisions r
          ON r.workspace_id = p.workspace_id AND r.harness_slug = p.harness_slug
         AND r.plan_slug = p.plan_slug AND r.content_hash = p.content_hash
       WHERE p.workspace_id = ${WS} AND p.harness_slug = ${HARNESS} AND p.plan_slug = ${slug}`;
    expect(matched).toEqual([{ seq: 1, author_id: 'plan-spec:adhoc-scope' }]);
  });

  it('is idempotent: a second call neither rewrites the body nor records a second revision', async () => {
    await db.adminSql.begin((tx) => resolveSpecScopeSlug(tx as never, WS, HARNESS, null));
    await db.adminSql.begin((tx) => resolveSpecScopeSlug(tx as never, WS, HARNESS, null));
    const [{ n }] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.plan_revisions
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC_WORK_ITEM_SPEC_SCOPE}`;
    expect(n).toBe(1);
  });

  it('a named plan slug is returned untouched and materialises nothing', async () => {
    const slug = await db.adminSql.begin((tx) => resolveSpecScopeSlug(tx as never, WS, HARNESS, 'some-plan'));
    expect(slug).toBe('some-plan');
    const [{ n }] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`;
    expect(n).toBe(0);
  });
});
