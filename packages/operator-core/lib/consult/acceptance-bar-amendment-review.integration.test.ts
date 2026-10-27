import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { previewThreadHasLaterPost, resolveAmendmentReviewEvidence } from './acceptance-bar-amendment-review';

describe('retained BAR re-review evidence custody (EI-25992283418918681)', () => {
  let db: OrgTestDb;
  const workspaceId = 'bar-rereview-evidence';
  const refs: Record<string, string> = {};
  const base = { workspaceId, applierId: 'applier' };

  beforeAll(async () => {
    db = await createOrgTestDb();
    for (const [key, author, body, thread, workspace, origin] of [
      ['before', 'applier', 'Old evidence', 'preview-thread', workspaceId, 'local'],
      ['preview', 'applier', 'Immutable approval JSON', 'preview-thread', workspaceId, 'local'],
      ['objection', 'judge-old', 'API timed out', 'preview-thread', workspaceId, 'local'],
      ['evidence', 'applier', 'Exact API delivered in 52.08s; verdict remains fail', 'preview-thread', workspaceId, 'local'],
      ['foreign-author', 'other', 'Not mine', 'preview-thread', workspaceId, 'local'],
      ['foreign-thread', 'applier', 'Wrong thread', 'other-thread', workspaceId, 'local'],
      ['foreign-workspace', 'applier', 'Wrong workspace', 'preview-thread', 'other-workspace', 'local'],
      ['remote', 'applier', 'Replicated evidence', 'preview-thread', workspaceId, 'remote'],
      ['empty', 'applier', '   ', 'preview-thread', workspaceId, 'local'],
      ['answer', 'judge-new', 'approve retained preview', 'preview-thread', workspaceId, 'local'],
    ]) {
      const [row] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
        VALUES (${workspace!}, ${thread!}, ${author!}, ${body!}, ${origin!}) RETURNING id`;
      refs[key!] = `thread-post:${row!.id}`;
    }
  });
  afterAll(async () => { await db?.cleanup(); });

  it('reads complete later evidence authored by the applier on the retained preview thread', async () => {
    expect(await resolveAmendmentReviewEvidence({ ...base, previewPostRef: refs.preview!, evidencePostRef: refs.evidence! }, db.adminSql))
      .toEqual({ postRef: refs.evidence, body: 'Exact API delivered in 52.08s; verdict remains fail' });
  });

  it.each(['before', 'preview', 'foreign-author', 'foreign-thread', 'foreign-workspace', 'remote', 'empty'])(
    'refuses evidence without the required custody: %s', async (key) => {
      await expect(resolveAmendmentReviewEvidence({ ...base, previewPostRef: refs.preview!, evidencePostRef: refs[key]! }, db.adminSql))
        .rejects.toThrow('reviewEvidencePost');
    },
  );

  it('distinguishes an old objection from an answer to the new evidence', async () => {
    const preview = { workspaceId, previewPostRef: refs.preview! };
    expect(await previewThreadHasLaterPost({ ...preview, authorId: 'judge-old' }, db.adminSql)).toBe(true);
    expect(await previewThreadHasLaterPost({ ...preview, authorId: 'judge-old', afterPostRef: refs.evidence! }, db.adminSql)).toBe(false);
    expect(await previewThreadHasLaterPost({ ...preview, authorId: 'judge-new', afterPostRef: refs.evidence! }, db.adminSql)).toBe(true);
    expect(await previewThreadHasLaterPost({ ...preview, authorId: 'other-workspace', afterPostRef: refs.evidence! }, db.adminSql)).toBe(false);
  });

  it('excludes requester artifact posts but preserves later reviewer activity', async () => {
    const [requesterPreview] = await db.adminSql<Array<{ id: number }>>`
      INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
      VALUES (${workspaceId}, 'requester-artifact-thread', 'applier', 'Preview approval JSON', 'local')
      RETURNING id`;
    await db.adminSql`
      INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
      VALUES (${workspaceId}, 'requester-artifact-thread', 'applier', 'Persisted request payload', 'local')`;

    const previewPostRef = `thread-post:${requesterPreview!.id}`;
    expect(await previewThreadHasLaterPost({ workspaceId, previewPostRef }, db.adminSql)).toBe(true);
    expect(await previewThreadHasLaterPost({ workspaceId, previewPostRef, excludeAuthorId: 'applier' }, db.adminSql)).toBe(false);
    expect(await previewThreadHasLaterPost({
      workspaceId,
      previewPostRef: refs.preview!,
      excludeAuthorId: 'applier',
    }, db.adminSql)).toBe(true);
  });
});
