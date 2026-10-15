/**
 * WI-10005785 — `scheduler:preview_spec_delta` and `scheduler:set_claim_spec` must return the SAME
 * goal-fence verdict for the same proposed filter ("the preview and the set door must agree",
 * ruling recorded on WI-10005683).
 *
 * Before the shared `evaluateGoalFenceGuardForIncumbent` helper only the write door ran the guard:
 * a fence-DROPPING revision previewed as clean counts and was then refused at the write, and the
 * fence-preserving widen shape previewed with none of the disclosure the write attaches. Both real
 * handlers are driven here with ONE incumbent and ONE candidate, and the refuse/warning verdicts are
 * compared directly — a test of the doors agreeing, not of either door in isolation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import setClaimSpecTool from './set_claim_spec';
import previewSpecDeltaTool from './preview_spec_delta';
import { fencePreservingWidenFilter } from '../../scheduler/fleet-scope-admission';

const getClaimSpecRecord = vi.hoisted(() => vi.fn());
const setClaimSpec = vi.hoisted(() => vi.fn());
const previewSpecPoolEffect = vi.hoisted(() => vi.fn());
const readClaimSpecDelta = vi.hoisted(() => vi.fn());
const previewSpecFilterPartition = vi.hoisted(() => vi.fn());

vi.mock('../../events/await/engine', () => ({
  wakeClaimableAwaitersForSubscribers: vi.fn().mockResolvedValue(0),
}));
vi.mock('../coordination/audience-host', () => ({
  hostAudienceResolvers: { listFleetMembers: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/claim-spec-store')>()),
  getClaimSpecRecord: (...args: unknown[]) => getClaimSpecRecord(...args),
  setClaimSpec: (...args: unknown[]) => setClaimSpec(...args),
}));
// Only the DB-backed pool COUNT is stubbed; the goal-fence guard stays REAL on both doors.
vi.mock('../../scheduler/spec-pool-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/spec-pool-preview')>()),
  previewSpecPoolEffect: (...args: unknown[]) => previewSpecPoolEffect(...args),
}));
vi.mock('../../scheduler/get-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/get-next')>()),
  readClaimSpecDelta: (...args: unknown[]) => readClaimSpecDelta(...args),
}));
vi.mock('../../scheduler/spec-predicate-partition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/spec-predicate-partition')>()),
  previewSpecFilterPartition: (...args: unknown[]) => previewSpecFilterPartition(...args),
}));

const goalFilter = {
  all: [
    { field: 'goal', op: '=', value: 'goal-813959' },
    { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] },
  ],
};
const incumbent = {
  source: 'cup' as const,
  spec: {
    specVersion: '1.0',
    specId: 'goal-lane',
    revision: 2,
    view: { filter: goalFilter },
    rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
  },
  revision: 2,
  updatedBy: 'su-leader',
  updatedAt: '2026-10-03T00:00:00.000Z',
  harnessSlug: 'papercusp',
};
const ctx = { isSuperuser: true, uiClientId: 'su-door-agreement', workspaceId: 'ws-test', harnessSlug: 'papercusp' };

function proposed(filter: unknown) {
  return {
    specVersion: '1.0',
    specId: 'candidate',
    revision: 3,
    view: { filter },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };
}

/** Run the SAME candidate through both real handlers and return each door's goal-fence verdict. */
async function bothDoors(candidateFilter: unknown) {
  getClaimSpecRecord.mockResolvedValue(incumbent);
  previewSpecPoolEffect.mockResolvedValue({ matched: 10, pool: 100, states: ['open'], harness: 'papercusp' });
  setClaimSpec.mockResolvedValue({ ok: true, revision: 3 });
  readClaimSpecDelta.mockResolvedValue({
    currentClaimable: 10,
    proposedClaimable: 10,
    retained: 10,
    newlyExcludedCount: 0,
    newlyAdmittedCount: 0,
    newlyExcluded: [],
    newlyAdmitted: [],
    truncated: { newlyExcluded: false, newlyAdmitted: false },
  });
  previewSpecFilterPartition.mockResolvedValue(null);

  const set = (await (setClaimSpecTool as any).handler({ cupId: 'su-target', spec: proposed(candidateFilter) }, ctx)) as {
    data: Record<string, any>;
  };
  const preview = (await (previewSpecDeltaTool as any).handler(
    { cupId: 'su-target', harness: 'papercusp', proposed: proposed(candidateFilter) },
    ctx,
  )) as { data: Record<string, any> };
  return { set: set.data, preview: preview.data };
}

describe('goal-fence verdict — preview_spec_delta agrees with set_claim_spec (WI-10005785)', () => {
  beforeEach(() => {
    for (const m of [getClaimSpecRecord, setClaimSpec, previewSpecPoolEffect, readClaimSpecDelta, previewSpecFilterPartition]) {
      m.mockReset();
    }
  });

  it('a fence-DROPPING revision is refused by the write door AND flagged by the preview with the same reason', async () => {
    const { set, preview } = await bothDoors({ field: 'kind', op: 'in', value: ['bug', 'change', 'task'] });

    expect(set.ok).toBe(false);
    expect(set.errors[0]).toContain('DROPS the incumbent positive goal fence');
    expect(setClaimSpec).not.toHaveBeenCalled();

    expect(preview.ok).toBe(true);
    expect(preview.goalFenceWouldRefuse).toBe(true);
    // Leads the warnings (a leader must not miss it in a wall of counts) and carries the write
    // door's own refusal text rather than a paraphrase of it.
    expect(preview.warnings[0]).toContain('set_claim_spec would REFUSE');
    expect(preview.warnings[0]).toContain(set.errors[0]);
  });

  it('the fence-PRESERVING widen shape is accepted by both doors and disclosed identically', async () => {
    const widened = fencePreservingWidenFilter(goalFilter as never, 'WI-10005785');
    const { set, preview } = await bothDoors(widened);

    expect(setClaimSpec).toHaveBeenCalled();
    expect(set.warning).toContain('RETAINS the incumbent positive goal fence');

    expect(preview.goalFenceWouldRefuse).toBe(false);
    expect(preview.warnings.join('\n')).toContain('RETAINS the incumbent positive goal fence');
    // Same sentence on both doors: the preview reuses the guard's own verdict text.
    const guardSentence = 'RETAINS the incumbent positive goal fence and admits 1 explicitly named row(s)';
    expect(set.warning).toContain(guardSentence);
    expect(preview.warnings.join('\n')).toContain(guardSentence);
  });

  it('a revision that keeps the goal fence draws no goal-fence verdict from either door', async () => {
    const { set, preview } = await bothDoors({
      all: [
        { field: 'goal', op: '=', value: 'goal-813959' },
        { field: 'kind', op: 'in', value: ['bug', 'change'] },
      ],
    });

    expect(set.ok).not.toBe(false);
    expect(String(set.warning ?? '')).not.toContain('goal fence');
    expect(preview.goalFenceWouldRefuse).toBe(false);
    expect((preview.warnings ?? []).join('\n')).not.toContain('GOAL FENCE');
  });
});
