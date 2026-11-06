import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  inspectFreshAmendmentReviewer, openAcceptanceBarAmendmentReview, previewThreadHasLaterPost, resolveAmendmentReviewEvidence,
  verifyAmendmentReviewCandidate, type OpenAmendmentReviewInput,
} from './acceptance-bar-amendment-review';
import { validateAcceptanceBarRevisionProjectionPreview } from '../acceptance-bar-amendment';
import { buildAcceptanceBarSeed } from '../acceptance-bar-seed';
import type { AcceptanceBarAmendmentPreview } from '../rubrics';
import { rubricTemplateDataAuthoringSchema } from '../agent-tools/plans/rubric-template';

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

  async function candidateFixture() {
    const plan = `---
title: Candidate
slug: candidate
status: active
created: 2026-11-06
updated: 2026-11-06
---
# Candidate
## Requirements
**R-1 — Canonical outcome.** The writer persists one canonical BAR.
## Design
### Bar-to-work map for this plan
| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
## Phase 1 — Build
- **P-001** \`todo\` persist the canonical BAR
`;
    const seeded = buildAcceptanceBarSeed({
      planSlug: 'candidate', planContent: plan, actorId: 'applier',
      declaredAt: '2026-11-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 1, planStatus: 'active', rubricSlug: 'acceptance-candidate', rubricRevision: 1,
    });
    if (!seeded.ok) throw new Error('fixture seed failed');
    const data = rubricTemplateDataAuthoringSchema.parse(seeded.templateData);
    await db.adminSql`DELETE FROM harness_shared.harness_plans
      WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp' AND plan_slug = 'candidate'`;
    await db.adminSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, content)
      VALUES (${workspaceId}, 'papercusp', 'candidate', ${plan})`;
    const validate = (templateData: unknown) => validateAcceptanceBarRevisionProjectionPreview(db.adminSql as never, {
      workspaceId, harnessSlug: 'papercusp', rubricSlug: 'acceptance-candidate', rubricRevision: 2,
      templateData, previousTemplateData: data,
    });
    const candidateValidation = await validate(data);
    expect(candidateValidation).toMatchObject({ generatedSpecCount: 1 });
    const approval = {
      rubricRef: 'acceptance-candidate', subjectPlan: 'candidate', proposedPatchHash: 'patch',
    } as AcceptanceBarAmendmentPreview['approval'];
    const preview = { candidateValidation, approval, approvalRequired: true, changes: [],
      rubricRevision: 1, subjectPlanRevision: 1 } as unknown as AcceptanceBarAmendmentPreview;
    const input: OpenAmendmentReviewInput = {
      rubricRef: 'acceptance-candidate', previewPostRef: refs.preview!, preview,
      identity: { ownerId: 'applier', workspaceId } as OpenAmendmentReviewInput['identity'], workspaceId,
      patch: { criteria: data.criteria },
      reviewSources: {
        rubric: { ref: 'acceptance-candidate', revision: 1, changedCriteria: [] },
        subjectPlan: { slug: 'candidate', harnessSlug: 'papercusp', revision: 1, contentHash: 'source', requirements: plan },
      },
    };
    const route = vi.fn(async () => ({ state: 'routed' as const, conversationId: 'candidate-review',
      responderId: 'independent-reviewer', screenedOut: [] }));
    // Recruitment is the counted boundary; preflight reads real migrated PG.
    const deps = { route, verifyPreviewPost: vi.fn(), verifyCandidate: (next: OpenAmendmentReviewInput) =>
      verifyAmendmentReviewCandidate(next, async (amendment) => ({
        ...preview, candidateValidation: await validate({ ...data, criteria: amendment.criteria ?? data.criteria }),
      })) };
    return { input, deps, route, data, plan, preview };
  }

  it('rejects invalid or missing observables with consolidated defects before review', async () => {
    const { input, deps, route, data } = await candidateFixture();
    for (const observation of ['', undefined]) {
      const criteria = structuredClone(data.criteria);
      Object.assign(criteria[0]!, { model: observation, driftMarkers: '', method: '', requiredScope: [''] });
      const failure = await openAcceptanceBarAmendmentReview({ ...input, patch: { criteria } }, deps)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      for (const field of ['model', 'driftMarkers', 'method', 'requiredScope']) {
        expect((failure as Error).message).toContain(field);
      }
    }
    expect(route).not.toHaveBeenCalled();
  });

  it('rejects invalid evidence plane and runtime before review', async () => {
    const { input, deps, route, data } = await candidateFixture();
    const criteria = structuredClone(data.criteria);
    Object.assign(criteria[0]!, { evidencePlane: 'invalid', evidenceRuntime: 'invalid' });
    const failure = await openAcceptanceBarAmendmentReview({ ...input, patch: { criteria } }, deps)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('evidencePlane');
    expect((failure as Error).message).toContain('evidenceRuntime');
    expect(route).not.toHaveBeenCalled();
  });

  it('binds whole candidate preflight and review dispatch to one identity', async () => {
    const { input, deps, route, data, plan, preview } = await candidateFixture();
    const invalidCriteria = structuredClone(data.criteria);
    Object.assign(invalidCriteria[0]!, { method: '', requiredScope: [''], evidencePlane: 'invalid', evidenceRuntime: 'invalid' });
    const invalid = await openAcceptanceBarAmendmentReview({ ...input, patch: { criteria: invalidCriteria } }, deps)
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(Error);
    for (const field of ['method', 'requiredScope', 'evidencePlane', 'evidenceRuntime']) {
      expect((invalid as Error).message).toContain(field);
    }
    expect(route).not.toHaveBeenCalled();

    const changedCriteria = structuredClone(data.criteria);
    changedCriteria[0]!.method = 'Read the entire canonical BAR history.';
    await expect(openAcceptanceBarAmendmentReview({ ...input, patch: { criteria: changedCriteria } }, deps))
      .rejects.toThrow('candidate_stale');
    expect(route).not.toHaveBeenCalled();
    await expect(openAcceptanceBarAmendmentReview(input, deps)).resolves.toMatchObject({ state: 'routed' });
    expect(route).toHaveBeenCalledTimes(1);

    await db.adminSql`UPDATE harness_shared.harness_plans SET content = ${plan + '\nSource changed after preflight.'}
      WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp' AND plan_slug = 'candidate'`;
    await expect(openAcceptanceBarAmendmentReview(input, deps)).rejects.toThrow('candidate_stale');
    expect(route).toHaveBeenCalledTimes(1);
    await expect(openAcceptanceBarAmendmentReview({ ...input, preview: { ...preview, candidateValidation: undefined } }, deps))
      .rejects.toThrow('candidate_missing');
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('dispatches a corrected exact candidate once', async () => {
    const { input, deps, route, data } = await candidateFixture();
    const invalid = structuredClone(data.criteria);
    Object.assign(invalid[0]!, { model: '', driftMarkers: '' });
    await expect(openAcceptanceBarAmendmentReview({ ...input, patch: { criteria: invalid } }, deps))
      .rejects.toThrow('candidate_invalid');
    expect(route).not.toHaveBeenCalled();
    const changed = structuredClone(data.criteria);
    changed[0]!.method = 'Inspect the complete canonical BAR history.';
    await expect(openAcceptanceBarAmendmentReview({ ...input, patch: { criteria: changed } }, deps))
      .rejects.toThrow('candidate_stale');
    expect(route).not.toHaveBeenCalled();
    await expect(openAcceptanceBarAmendmentReview(input, deps)).resolves.toMatchObject({ state: 'routed' });
    expect(route).toHaveBeenCalledTimes(1);
  });

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

  it('reclaims an ended re-review despite the old objection and requester evidence, then preserves a fresh answer', async () => {
    const records: string[] = [];
    for (const [author, body] of [['applier', 'Retained preview'], ['judge-old', 'Old objection'],
      ['applier', 'New verification evidence'], ['another-agent', 'Unrelated later note']]) {
      const [row] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
        VALUES (${workspaceId}, 're-review-recovery', ${author!}, ${body!}, 'local') RETURNING id`;
      records.push(`thread-post:${row!.id}`);
    }
    const request = { workspaceId, previewPostRef: records[0]!, reviewEvidencePost: records[2]!,
      reviewer: { state: 'launched', taskId: 'ended-reviewer', ownerId: 'judge-old' } };
    const deps = { readTaskState: async () => 'ended_unobserved' as const,
      hasLaterPost: (args: Parameters<typeof previewThreadHasLaterPost>[0]) => previewThreadHasLaterPost(args, db.adminSql) };
    expect(await inspectFreshAmendmentReviewer(request, deps)).toMatchObject({ state: 'reclaimable' });

    await db.adminSql`
      INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body, origin)
      VALUES (${workspaceId}, 're-review-recovery', 'judge-old', 'approve retained preview', 'local')`;
    expect(await inspectFreshAmendmentReviewer(request, deps)).toMatchObject({ state: 'later-post' });
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
