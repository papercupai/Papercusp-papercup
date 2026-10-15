import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readScoutDraftCandidates, readScoutDraftReviewRecovery } from './draft-review-watchdog';

describe('draft review exact recovery (real migrated PostgreSQL)', () => {
  let db: OrgTestDb;
  beforeAll(async () => { db = await createOrgTestDb(); });
  afterAll(async () => { await db?.cleanup(); });

  async function insert(workspace: string, harness: string, slug: string, status = 'draft', decisions: object[] = []) {
    const content = '---\norigin: scout\n---\n';
    await db.adminSql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items, decisions, updated_at)
      VALUES (${workspace}, ${harness}, ${slug}, ${slug}, ${status}, ${content}, md5(${content}),
        '[]'::jsonb, ${JSON.stringify(decisions)}::jsonb, now() - interval '48 hours')`;
  }

  it('keeps exact workspace, storage slug and plan identity independent of the 50-row candidate page', async () => {
    const ws = 'draft-review-exact';
    for (let i = 0; i < 51; i++) await insert(ws, 'portal', `idea-${i.toString().padStart(2, '0')}`);
    await insert(ws, 'portal', 'reviewed', 'draft', [{ id: 'D-001', body: 'Needs revision' }]);
    await insert(ws, 'sidestage', 'reviewed');
    await insert(ws + '-other', 'portal', 'reviewed');
    const now = Date.now(), threshold = 12 * 3600_000;
    const page = await readScoutDraftCandidates(db.adminSql, ws, 'portal');
    expect(page).toHaveLength(50);
    const missed = Array.from({ length: 51 }, (_, i) => `idea-${i.toString().padStart(2, '0')}`)
      .find(slug => !page.some(row => row.planSlug === slug))!;
    expect(missed).toBeDefined();
    expect(await readScoutDraftReviewRecovery(db.adminSql,
      { workspaceId: ws, planStorageSlug: 'portal', planSlug: missed }, now, threshold)).toBe(false);
    expect(await readScoutDraftReviewRecovery(db.adminSql,
      { workspaceId: ws, planStorageSlug: 'portal', planSlug: 'reviewed' }, now, threshold)).toBe(true);
    for (const [workspaceId, planStorageSlug] of [[ws, 'sidestage'], [ws + '-other', 'portal']]) {
      expect(await readScoutDraftReviewRecovery(db.adminSql,
        { workspaceId, planStorageSlug, planSlug: 'reviewed' }, now, threshold)).toBe(false);
    }
    expect(await readScoutDraftReviewRecovery(db.adminSql,
      { workspaceId: ws, planStorageSlug: 'portal', planSlug: 'absent' }, now, threshold)).toBeNull();
  });

  it('observes a matching non-draft row as recovered and preserves a malformed draft index', async () => {
    const ws = 'draft-review-state';
    await insert(ws, 'portal', 'ratified', 'ready');
    await insert(ws, 'portal', 'malformed');
    await db.adminSql`UPDATE harness_shared.harness_plans SET decisions = '{"broken":true}'::jsonb
      WHERE workspace_id = ${ws} AND harness_slug = 'portal' AND plan_slug = 'malformed'`;
    const now = Date.now(), threshold = 12 * 3600_000;
    expect(await readScoutDraftReviewRecovery(db.adminSql,
      { workspaceId: ws, planStorageSlug: 'portal', planSlug: 'ratified' }, now, threshold)).toBe(true);
    expect(await readScoutDraftReviewRecovery(db.adminSql,
      { workspaceId: ws, planStorageSlug: 'portal', planSlug: 'malformed' }, now, threshold)).toBeNull();
  });
});
