import { describe, expect, it, vi } from 'vitest';

import { readVettingWorkItemCritique } from './work-items';
import { readCurrentAcceptanceRubricCritique } from './acceptance-rubric-critique';
import type { Rubric } from './rubrics';

describe('readVettingWorkItemCritique (WI-41477)', () => {
  it('distinguishes a missing work-item from an existing item with no comments', async () => {
    const getWorkItemDetail = vi.fn().mockResolvedValue(null);

    await expect(
      readVettingWorkItemCritique('WI-missing', ['su-emitter'], 'papercusp', {
        getWorkItemDetail: getWorkItemDetail as never,
      }),
    ).resolves.toEqual({ exists: false, critiquePosts: 0, critics: [] });
    expect(getWorkItemDetail).toHaveBeenCalledWith('WI-missing', 'papercusp');

    getWorkItemDetail.mockResolvedValue({ posts: [] });
    await expect(
      readVettingWorkItemCritique('WI-silent', ['su-emitter'], 'papercusp', {
        getWorkItemDetail: getWorkItemDetail as never,
      }),
    ).resolves.toEqual({ exists: true, critiquePosts: 0, critics: [] });
  });

  it('counts only third-party authored comments and returns distinct critics in stable order', async () => {
    const getWorkItemDetail = vi.fn().mockResolvedValue({
      posts: [
        { author_id: null },
        { author_id: '' },
        { author_id: 'su-emitter' },
        { author_id: 'su-rubric-author' },
        { author_id: 'su-reviewer-b', body: 'The detector misses a stale source fingerprint.' },
        { author_id: 'su-reviewer-a', body: 'The positive control distinguishes that failure.' },
        { author_id: 'su-reviewer-b', body: 'Require the current rubric revision in the replay.' },
      ],
    });

    await expect(
      readVettingWorkItemCritique(
        'WI-review',
        ['su-emitter', 'su-rubric-author', null, undefined],
        'papercusp',
        { getWorkItemDetail: getWorkItemDetail as never },
      ),
    ).resolves.toEqual({
      exists: true,
      critiquePosts: 3,
      critics: ['su-reviewer-a', 'su-reviewer-b'],
    });
  });

  it.each(['release-request-sweep', 'system:release-request-sweep', 'system-reconciler', 'substrate'])(
    'does not turn %s lifecycle comments into a critic', async author => {
      const getWorkItemDetail = vi.fn().mockResolvedValue({ posts: [{
        author_id: author,
        body: '⏰ Release request from su-author → su-reviewer EXPIRED unanswered; consequence-reclaim.',
      }] });
      await expect(readVettingWorkItemCritique('WI-review', ['su-author'], 'papercusp', {
        getWorkItemDetail: getWorkItemDetail as never,
      })).resolves.toEqual({ exists: true, critiquePosts: 0, critics: [] });
    },
  );

  it('requires review text and keeps genuine independent critique beside lifecycle posts', async () => {
    const getWorkItemDetail = vi.fn().mockResolvedValue({ posts: [
      { author_id: 'su-reviewer-empty', body: ' \n\t' },
      { author_id: 'su-reviewer-missing-body' },
      { author_id: 'release-request-sweep', body: 'Release request EXPIRED unanswered.' },
      { author_id: 'su-reviewer', body: 'R4 needs a runner assertion; its helper test cannot prove propagation.' },
    ] });
    await expect(readVettingWorkItemCritique('WI-review', ['su-author'], 'papercusp', {
      getWorkItemDetail: getWorkItemDetail as never,
    })).resolves.toEqual({ exists: true, critiquePosts: 1, critics: ['su-reviewer'] });
  });

  it('accepts an independent status-only comment under the content-blind vetting contract', async () => {
    const rubric = { rubricId: 'acceptance-plan', revision: 4, criteriaHash: 'current-hash',
      workspaceId: 'ws-test', createdBy: 'su-author', proposedBy: 'su-author' } as Rubric;
    const posts = [{ author_id: 'release-request-sweep', body: 'Release request EXPIRED unanswered.' }];
    const workItem = () => readVettingWorkItemCritique('WI-review', ['su-author'], 'papercusp', {
      getWorkItemDetail: vi.fn(async () => ({ posts })) as never,
    });
    const deps = { workItem, candidates: async () => [{ workItemId: 'WI-review',
      request: 'Vet acceptance-plan revision 4 criteriaHash current-hash', createdAt: '2026-10-23T08:00:00Z' }] };
    expect(await readCurrentAcceptanceRubricCritique(rubric, 4, deps)).toBeNull();

    posts.push({ author_id: 'su-reviewer', body: 'PICKUP: I will review this after my current task.' });
    expect(await readCurrentAcceptanceRubricCritique(rubric, 4, deps))
      .toMatchObject({ workItemId: 'WI-review', critics: ['su-reviewer'], criteriaHash: 'current-hash' });
  });
});
