import { describe, expect, it, vi } from 'vitest';
import {
  findReviewerRelaunchConflict,
  renderReviewerRelaunchRefusal,
  type ReviewerRelaunchGuardDeps,
  type ReviewerReservationRef,
} from './acceptance-reviewer-relaunch-guard';

/**
 * EI-25876555362728602: an implementer that resumes (or gives a successor to) an
 * acceptance reviewer becomes the reviewer's recorded launcher, a permanent lineage
 * edge that voids every later independent grade. These pin the launch-time refusal.
 *
 * Lineage used throughout (edges are launcher → launched):
 *   leader → impl → impl-child
 *   leader → reviewer-peer
 */
const PARENTS: Record<string, string[]> = {
  impl: ['leader'],
  'impl-child': ['impl', 'leader'],
  'reviewer-peer': ['leader'],
};

function deps(over: {
  reservations?: ReviewerReservationRef[];
  firstLauncher?: string | null;
  implementers?: Record<string, string[]>;
} = {}): ReviewerRelaunchGuardDeps & { calls: Record<string, number> } {
  const calls: Record<string, number> = { reservations: 0, firstLauncher: 0, ancestors: 0, implementers: 0 };
  return {
    calls,
    async reviewerReservations() {
      calls.reservations++;
      return over.reservations ?? [];
    },
    async firstLauncher() {
      calls.firstLauncher++;
      return over.firstLauncher === undefined ? 'su-someone' : over.firstLauncher;
    },
    async ancestors(ownerId) {
      calls.ancestors++;
      return new Set([ownerId, ...(PARENTS[ownerId] ?? [])]);
    },
    async implementers(planSlug) {
      calls.implementers++;
      return over.implementers?.[planSlug] ?? [];
    },
  };
}

const reservation = { reservationId: 'WI-9956', planSlug: 'plan-a' };

describe('findReviewerRelaunchConflict (EI-25876555362728602)', () => {
  it('refuses the plan implementer relaunching its own reviewer', async () => {
    const d = deps({ reservations: [reservation], implementers: { 'plan-a': ['impl'] } });
    const conflict = await findReviewerRelaunchConflict(
      { workspaceId: 'ws', launcherOwnerId: 'impl', retainedOwnerId: 'reviewer' },
      d,
    );
    expect(conflict).toEqual({
      kind: 'implementer-relaunches-reviewer',
      reviewerOwnerId: 'reviewer',
      launcherOwnerId: 'impl',
      planSlug: 'plan-a',
      reservationId: 'WI-9956',
      implementer: 'impl',
    });
  });

  it("refuses a descendant of the implementer (the new edge reaches the implementer through the caller's ancestry)", async () => {
    const d = deps({ reservations: [reservation], implementers: { 'plan-a': ['impl'] } });
    const conflict = await findReviewerRelaunchConflict(
      { workspaceId: 'ws', launcherOwnerId: 'impl-child', retainedOwnerId: 'reviewer' },
      d,
    );
    expect(conflict).toMatchObject({ kind: 'implementer-relaunches-reviewer', implementer: 'impl' });
  });

  it('allows the fleet leader whose OTHER children implement the plan (siblings are not lineage)', async () => {
    const d = deps({ reservations: [reservation], implementers: { 'plan-a': ['impl'] } });
    const conflict = await findReviewerRelaunchConflict(
      { workspaceId: 'ws', launcherOwnerId: 'leader', retainedOwnerId: 'reviewer' },
      d,
    );
    expect(conflict).toBeNull();
  });

  it('allows a recruited reviewer whose reservation plan has no implementer in the caller ancestry', async () => {
    const d = deps({
      reservations: [reservation],
      firstLauncher: 'system:acceptance-grading-sweep',
      implementers: { 'plan-a': ['impl'] },
    });
    const conflict = await findReviewerRelaunchConflict(
      { workspaceId: 'ws', launcherOwnerId: 'reviewer-peer', retainedOwnerId: 'reviewer' },
      d,
    );
    expect(conflict).toBeNull();
  });

  it('fails closed on a recruited reviewer with no reservation naming its plan', async () => {
    const d = deps({ firstLauncher: 'system:acceptance-grading-sweep' });
    const conflict = await findReviewerRelaunchConflict(
      { workspaceId: 'ws', launcherOwnerId: 'impl', retainedOwnerId: 'reviewer' },
      d,
    );
    expect(conflict).toEqual({
      kind: 'recruited-reviewer-unprovable',
      reviewerOwnerId: 'reviewer',
      launcherOwnerId: 'impl',
      recruiter: 'system:acceptance-grading-sweep',
    });
    expect(d.calls.ancestors).toBe(0);
  });

  it('is a no-op for an identity that is not a reviewer', async () => {
    const d = deps({ firstLauncher: 'su-leader' });
    const conflict = await findReviewerRelaunchConflict(
      { workspaceId: 'ws', launcherOwnerId: 'impl', retainedOwnerId: 'worker' },
      d,
    );
    expect(conflict).toBeNull();
    expect(d.calls.ancestors).toBe(0);
    expect(d.calls.implementers).toBe(0);
  });

  it.each([
    ['self-resume', 'reviewer', 'reviewer'],
    ['system recruiter relaunch', 'system:acceptance-grader', 'reviewer'],
    ['no caller identity', null, 'reviewer'],
    ['fresh launch / fork (nothing retained)', 'impl', null],
  ])('skips the read entirely for %s', async (_label, launcher, retained) => {
    const d = deps({ reservations: [reservation], implementers: { 'plan-a': ['impl'] } });
    const conflict = await findReviewerRelaunchConflict(
      { workspaceId: 'ws', launcherOwnerId: launcher, retainedOwnerId: retained },
      d,
    );
    expect(conflict).toBeNull();
    expect(d.calls.reservations).toBe(0);
  });

  it('propagates a read failure instead of reading an unreadable population as empty', async () => {
    const d = deps();
    d.reviewerReservations = vi.fn(async () => {
      throw new Error('pg down');
    });
    await expect(
      findReviewerRelaunchConflict({ workspaceId: 'ws', launcherOwnerId: 'impl', retainedOwnerId: 'reviewer' }, d),
    ).rejects.toThrow('pg down');
  });

  it('checks every reviewed plan once and reports the one the caller implemented', async () => {
    const d = deps({
      reservations: [
        { reservationId: 'WI-1', planSlug: 'plan-b' },
        { reservationId: 'WI-2', planSlug: 'plan-b' },
        { reservationId: 'WI-3', planSlug: 'plan-a' },
      ],
      implementers: { 'plan-b': ['someone-else'], 'plan-a': ['impl'] },
    });
    const conflict = await findReviewerRelaunchConflict(
      { workspaceId: 'ws', launcherOwnerId: 'impl', retainedOwnerId: 'reviewer' },
      d,
    );
    expect(conflict).toMatchObject({ planSlug: 'plan-a', reservationId: 'WI-3' });
    expect(d.calls.implementers).toBe(2);
  });
});

describe('renderReviewerRelaunchRefusal', () => {
  it('names the reviewer, plan, implementer path and the recruiter recovery route', () => {
    const text = renderReviewerRelaunchRefusal({
      kind: 'implementer-relaunches-reviewer',
      reviewerOwnerId: 'reviewer',
      launcherOwnerId: 'impl-child',
      planSlug: 'plan-a',
      reservationId: 'WI-9956',
      implementer: 'impl',
    });
    expect(text).toMatch(/^reviewer_relaunch_breaks_independence: /);
    expect(text).toContain('plan plan-a');
    expect(text).toContain('impl-child descends from its implementer impl');
    expect(text).toContain("plans:set-plan-status { slug, status:'shipped' }");
  });

  it('explains the fail-closed recruited case', () => {
    const text = renderReviewerRelaunchRefusal({
      kind: 'recruited-reviewer-unprovable',
      reviewerOwnerId: 'reviewer',
      launcherOwnerId: 'impl',
      recruiter: 'system:acceptance-grading-sweep',
    });
    expect(text).toContain('recruited by system:acceptance-grading-sweep');
    expect(text).toContain('plans:set-plan-status');
  });
});
