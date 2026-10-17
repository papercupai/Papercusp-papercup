/**
 * release.test.ts — plan_items:release must never OFFER a terminal lane for pickup
 * (EI-22073881694336970).
 *
 * The bug: releasing a plan item always built a coord:dispatch handle for every
 * successfully-released row, with no regard for the item's status. Its note reads
 * "the lane is free … Claim and continue", so for a done/dropped item that is an
 * invitation to reopen finished work — and a release is exactly when it happens,
 * because winding a plan down means force-releasing stale claims on items that are
 * ALREADY terminal. Reproduced twice live on P-008/WI-2008163 after wind-down: each
 * force release suggested handing the completed lane to an unrelated parked agent.
 *
 * These tests assert on the ITEMS PASSED TO buildDispatchHandle, not on the rendered
 * handle, because that is where the decision is made — a test that only asserted
 * "dispatch is null" would still pass if the filter were moved somewhere that
 * happened to blank the handle for an unrelated reason.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plan-items/release.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me' })),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async ({ harnessSlug }: { harnessSlug?: string }) => ({
    workspaceId: 'ws',
    harnessSlug: harnessSlug ?? 'papercusp',
  })),
}));
vi.mock('../../plan-items/claims', () => ({
  getClaim: vi.fn(),
  releaseClaim: vi.fn(),
  forceReleaseClaim: vi.fn(),
}));
vi.mock('../../plan-items/claim-discipline', () => ({
  releaseLinkedWorkItemForPlanItem: vi.fn(async () => false),
}));
vi.mock('../../plan-items/assignments', () => ({
  planItemEffectiveStatuses: vi.fn(),
}));
vi.mock('../work_items/release-force-guard', () => ({
  assessForceRelease: vi.fn(),
  forceRefusalHint: vi.fn(() => 'hint'),
  notifyForceTransition: vi.fn(),
  recordForceTransitionAudit: vi.fn(),
}));
vi.mock('../coordination/presence-snapshot', () => ({
  resolvePresenceScope: vi.fn(async () => ({})),
  assemblePresenceSnapshot: vi.fn(async () => ({ active: [{ ownerId: 'peer' }] })),
}));
vi.mock('../coordination/dispatch-handle', () => ({
  buildDispatchHandle: vi.fn(() => ({ target: 'peer' })),
}));

import { getClaim, releaseClaim } from '../../plan-items/claims';
import { releaseLinkedWorkItemForPlanItem } from '../../plan-items/claim-discipline';
import { planItemEffectiveStatuses } from '../../plan-items/assignments';
import { buildDispatchHandle } from '../coordination/dispatch-handle';

const getClaimM = vi.mocked(getClaim);
const releaseClaimM = vi.mocked(releaseClaim);
const releaseLinkedWorkItemM = vi.mocked(releaseLinkedWorkItemForPlanItem);
const statusesM = vi.mocked(planItemEffectiveStatuses);
const buildM = vi.mocked(buildDispatchHandle);

/**
 * The subject path is OVERRIDABLE so falsifiability can be proven without mutating
 * the tracked file (CLAUDE.md § "Proving a guard is falsifiable", tier 2). The copy
 * must be a SIBLING in this directory: the subject's own relative imports
 * ('../plans/source', '../../plan-items/assignments', …) and therefore every
 * vi.mock above resolve from the module's location, so a scratch copy under /tmp
 * would silently bypass the mocks instead of exercising them.
 */
const tool = (await import(process.env.PROBE_RELEASE_MODULE ?? './release')).default;
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<unknown>;

/** The caller holds a live claim on everything, and every release succeeds. */
function everythingReleasable() {
  (getClaimM as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    owner: 'me',
    claimId: '11111111-1111-4111-8111-111111111111',
    lastActivityTs: new Date('2026-01-01T00:00:00Z'),
  });
  (releaseClaimM as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(true);
}

/** The plan-item statuses the handler will read back for the released rows. */
const statuses = (m: Record<string, string | null>) =>
  (statusesM as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
    new Map(Object.entries(m)),
  );

/** The item ids actually offered for pickup, or null when no handle was built. */
function offeredItems(): string[] | null {
  if (buildM.mock.calls.length === 0) return null;
  return (buildM.mock.calls[0][0] as { items: string[] }).items;
}

beforeEach(() => {
  vi.clearAllMocks();
  everythingReleasable();
});

describe('plan_items:release — never offers a TERMINAL lane for pickup (EI-22073881694336970)', () => {
  it('a DONE item is released but NOT offered for pickup — no dispatch handle at all', async () => {
    statuses({ 'P-008': 'done' });

    const out = (await call({ plan: 'wind-down-plan', item: 'P-008' })) as { data?: { dispatch?: unknown } };

    // The release itself must still happen — the guard withholds the suggestion,
    // never the write.
    expect(releaseClaimM).toHaveBeenCalledTimes(1);
    expect(buildDispatchHandle).not.toHaveBeenCalled();
    expect(out.data?.dispatch).toBeUndefined();
  });

  it('a DROPPED item is withheld too — terminal is not just "done"', async () => {
    statuses({ 'P-009': 'dropped' });

    await call({ plan: 'wind-down-plan', item: 'P-009' });

    expect(releaseClaimM).toHaveBeenCalledTimes(1);
    expect(buildDispatchHandle).not.toHaveBeenCalled();
  });

  it('a live (wip) item IS still offered — the affordance is intact for real work', async () => {
    statuses({ 'P-010': 'wip' });

    await call({ plan: 'live-plan', item: 'P-010' });

    expect(offeredItems()).toEqual(['P-010']);
  });

  it('releases a linked work item with the same owner as the plan claim', async () => {
    statuses({ 'P-010': 'wip' });

    await call({ plan: 'live-plan', item: 'P-010' });

    expect(releaseLinkedWorkItemM).toHaveBeenCalledWith('live-plan', 'P-010', 'me');
  });

  it('a MIXED batch offers ONLY the non-terminal items', async () => {
    statuses({ 'P-001': 'todo', 'P-002': 'done', 'P-003': 'wip', 'P-004': 'dropped' });

    await call({ plan: 'mixed-plan', itemIds: ['P-001', 'P-002', 'P-003', 'P-004'] });

    // All four were released; only the two live ones are offered.
    expect(releaseClaimM).toHaveBeenCalledTimes(4);
    expect(offeredItems()).toEqual(['P-001', 'P-003']);
  });

  it('a batch that is ENTIRELY terminal produces no handle, not an empty one', async () => {
    statuses({ 'P-001': 'done', 'P-002': 'dropped' });

    const out = (await call({ plan: 'finished-plan', itemIds: ['P-001', 'P-002'] })) as {
      data?: { dispatch?: unknown };
    };

    expect(buildDispatchHandle).not.toHaveBeenCalled();
    expect(out.data?.dispatch).toBeUndefined();
  });

  it('FAIL-OPEN: an undeterminable status is still offered, matching planItemEffectiveStatus’s contract', async () => {
    // A null status (un-normalized row) and an item missing from the map entirely
    // both mean "could not determine" — neither may be treated as terminal.
    statuses({ 'P-005': null });

    await call({ plan: 'unknown-plan', itemIds: ['P-005', 'P-006'] });

    expect(offeredItems()).toEqual(['P-005', 'P-006']);
  });

  it('FAIL-OPEN: a THROWING status read still offers the lane and never fails the release', async () => {
    (statusesM as unknown as { mockRejectedValue: (v: unknown) => void }).mockRejectedValue(
      new Error('plan read hiccup'),
    );

    await call({ plan: 'flaky-plan', itemIds: ['P-007', 'P-008'] });

    expect(releaseClaimM).toHaveBeenCalledTimes(2);
    expect(offeredItems()).toEqual(['P-007', 'P-008']);
  });

  it('reads each plan ONCE for the whole batch, not once per item', async () => {
    statuses({ 'P-001': 'wip', 'P-002': 'wip', 'P-003': 'wip' });

    await call({ plan: 'one-plan', itemIds: ['P-001', 'P-002', 'P-003'] });

    // The serial per-item plan read is the anti-pattern this bulk call avoids.
    expect(statusesM).toHaveBeenCalledTimes(1);
    expect(statusesM.mock.calls[0][2]).toEqual(['P-001', 'P-002', 'P-003']);
  });

  it('uses each row’s OWN harness, so a heterogeneous items:[…] release is scoped correctly', async () => {
    statuses({ 'P-100': 'wip', 'P-200': 'wip' });

    await call({
      items: [
        { plan: 'plan-a', item: 'P-100', harness: 'harness-a' },
        { plan: 'plan-b', item: 'P-200', harness: 'harness-b' },
      ],
    });

    // Two distinct (harness, plan) buckets ⇒ two scoped reads, each with its own
    // harness. Deriving from the batch-level args.harness would have sent both to
    // the same (wrong) harness and silently read the wrong plan's statuses.
    expect(statusesM).toHaveBeenCalledTimes(2);
    const seen = statusesM.mock.calls.map((c) => [c[0], c[1]]).sort();
    expect(seen).toEqual([
      ['harness-a', 'plan-a'],
      ['harness-b', 'plan-b'],
    ]);
  });
});
