/**
 * Slug-guard coverage for `withPlanLock`.
 *
 * Regression test for the path-traversal gap found in the 2026-05-21
 * audit: `path.join` normalises `..` segments away before the lock
 * store's `validatePath` runs, so a slug like `../../../CLAUDE` would
 * write `<repo>/apps/CLAUDE.md` — outside `docs/plans/`. The guard at
 * the top of `withPlanLock` rejects any slug that isn't `VALID_PLAN_
 * SLUG` (notably: anything containing `/`).
 *
 * The guard is the first statement in `withPlanLock` — it throws
 * before `ensureBootstrap()` / the lock acquire — so these tests need
 * neither the SU-lock side-database nor a real plans directory.
 */

import { describe, expect, it, vi } from 'vitest';
import { withPlanLock } from '../with-plan-lock';
import { VALID_PLAN_SLUG } from '../source';
import * as planSource from '../source';

// A mutator that must never run for a rejected slug.
const neverMutator = vi.fn(async () => ({ newBody: null, value: null }));

const TRAVERSAL_SLUGS = [
  '../../../CLAUDE',
  '../../../../etc/passwd',
  '../../../../../../../../etc/passwd',
  'foo/bar',
  'a/../../b',
  '..\\..\\windows',
];

describe('withPlanLock — slug guard', () => {
  it('throws on every traversal-shaped slug, without invoking the mutator', async () => {
    for (const slug of TRAVERSAL_SLUGS) {
      neverMutator.mockClear();
      await expect(
        withPlanLock({} as never, { slug, intent: 'test' }, neverMutator),
      ).rejects.toThrow(/invalid plan slug/);
      expect(neverMutator).not.toHaveBeenCalled();
    }
  });

  it('throws on a non-string slug', async () => {
    await expect(
      withPlanLock({} as never, { slug: undefined as never, intent: 'test' }, neverMutator),
    ).rejects.toThrow(/invalid plan slug/);
  });

  it('the guard regex accepts canonical plan slugs', () => {
    expect(VALID_PLAN_SLUG.test('plans-admin-ui-2026-05-20')).toBe(true);
    expect(VALID_PLAN_SLUG.test('agent-plan-tracking-2026-05-20')).toBe(true);
    expect(VALID_PLAN_SLUG.test('__p5-ui-edit__')).toBe(true);
  });

  it('the guard regex accepts generated per-run instance slugs', () => {
    expect(VALID_PLAN_SLUG.test('meeting-prep-brief-2026-08-22@run-353457600772108178')).toBe(true);
    expect(VALID_PLAN_SLUG.test('meeting-prep-brief@run-')).toBe(false);
    expect(VALID_PLAN_SLUG.test('meeting-prep-brief@run-token')).toBe(false);
    expect(VALID_PLAN_SLUG.test('@run-353457600772108178')).toBe(false);
  });

  it('the guard regex rejects any slug containing a slash', () => {
    expect(VALID_PLAN_SLUG.test('foo/bar')).toBe(false);
    expect(VALID_PLAN_SLUG.test('../x')).toBe(false);
    expect(VALID_PLAN_SLUG.test('meeting-prep-brief@run-1/../../x')).toBe(false);
  });
});

describe('withPlanLock — admitted workspace scope', () => {
  it('keeps a home-harness write in the caller workspace before opening a transaction', async () => {
    const stop = new Error('scope observed before database access');
    const scope = vi.spyOn(planSource, 'resolvePlanScope').mockRejectedValueOnce(stop);
    try {
      await expect(withPlanLock(
        { workspaceId: 'private-plan-workspace', harnessSlug: 'papercusp' },
        { slug: 'private-plan-scope', intent: 'scope regression', harnessSlug: 'papercusp' },
        neverMutator,
      )).rejects.toBe(stop);
      expect(scope).toHaveBeenCalledWith({ workspaceId: 'private-plan-workspace', harnessSlug: 'papercusp' });
    } finally { scope.mockRestore(); }
  });

  it('preserves an explicitly resolved workspace override', async () => {
    const stop = new Error('scope observed before database access');
    const scope = vi.spyOn(planSource, 'resolvePlanScope').mockRejectedValueOnce(stop);
    try {
      await expect(withPlanLock(
        { workspaceId: 'caller-workspace', harnessSlug: 'papercusp' },
        { slug: 'explicit-plan-scope', intent: 'scope regression',
          workspaceId: 'explicit-workspace', harnessSlug: 'papercusp' },
        neverMutator,
      )).rejects.toBe(stop);
      expect(scope).toHaveBeenCalledWith({ workspaceId: 'explicit-workspace', harnessSlug: 'papercusp' });
    } finally { scope.mockRestore(); }
  });
});
