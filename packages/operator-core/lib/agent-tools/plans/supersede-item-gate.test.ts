import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPlanItemStatuses,
  resolvePlanItemHomeHarness,
  type PlanItemStatus,
} from '../../plan-audits';
import {
  SUPERSEDE_ITEMS_UNFINISHED,
  evaluateSupersedeItemGate,
  shouldEvaluateSupersedeItemGate,
  unfinishedPlanItems,
} from './supersede-item-gate';

// Partial mock: the real UNFINISHED_ITEM_STATUSES constant must survive, because
// the whole point of this gate is that it reuses that ONE definition rather than
// keeping a second copy. A test that stubbed the constant could not catch drift.
vi.mock('../../plan-audits', async (orig) => ({
  ...(await orig<typeof import('../../plan-audits')>()),
  getPlanItemStatuses: vi.fn(),
  // The real helper reads harness_plans through getOrgPg; stub it so the gate's
  // home-harness resolution is observable and never touches a database.
  resolvePlanItemHomeHarness: vi.fn(),
}));

const mockItems = vi.mocked(getPlanItemStatuses);
const mockResolveHome = vi.mocked(resolvePlanItemHomeHarness);
const PLAN = 'dead-idea-2026-08-03';

const item = (itemId: string, status: string): PlanItemStatus => ({
  itemId,
  status,
  itemText: `${itemId} text`,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveHome.mockResolvedValue(null);
});

describe('shouldEvaluateSupersedeItemGate', () => {
  it('fires on a supersede', () => {
    expect(shouldEvaluateSupersedeItemGate('superseded', undefined)).toBe(true);
  });

  it('does NOT fire on ship, ready or draft — those are other gates', () => {
    for (const s of ['shipped', 'ready', 'draft', 'done', 'active']) {
      expect(shouldEvaluateSupersedeItemGate(s, undefined)).toBe(false);
    }
  });

  it('does NOT fire on the idempotent repair pass over an already-superseded plan', () => {
    // Mirrors shouldEvaluateAcceptanceGate's expectedCurrent carve-out: a repair
    // replay must not be refused for residue it did not create.
    expect(shouldEvaluateSupersedeItemGate('superseded', 'superseded')).toBe(false);
    // …but a supersede CASed against any other prior status is a real entry.
    expect(shouldEvaluateSupersedeItemGate('superseded', 'draft')).toBe(true);
  });
});

describe('unfinishedPlanItems', () => {
  it('counts todo/wip/blocked/needs-human and nothing else', () => {
    const items = [
      item('P-001', 'todo'),
      item('P-002', 'wip'),
      item('P-003', 'blocked'),
      item('P-004', 'needs-human'),
      item('P-005', 'done'),
      item('P-006', 'dropped'),
    ];
    expect(unfinishedPlanItems(items).map((i) => i.itemId)).toEqual([
      'P-001',
      'P-002',
      'P-003',
      'P-004',
    ]);
  });

  it('treats `dropped` as terminal — it is a recorded decision, not residue', () => {
    expect(unfinishedPlanItems([item('P-001', 'dropped')])).toEqual([]);
  });
});

describe('evaluateSupersedeItemGate', () => {
  it('refuses a deprecate that would strand non-terminal items, naming each one', async () => {
    mockItems.mockResolvedValue([
      item('P-001', 'todo'),
      item('P-002', 'blocked'),
      item('P-003', 'done'),
    ]);

    const gate = await evaluateSupersedeItemGate(PLAN);

    expect(gate.satisfied).toBe(false);
    expect(gate.code).toBe(SUPERSEDE_ITEMS_UNFINISHED);
    expect(gate.message).toContain('P-001 (todo)');
    expect(gate.message).toContain('P-002 (blocked)');
    // The offending count is against the plan's FULL item set, so the reader can
    // see how much of the plan is residue.
    expect(gate.message).toContain('2 of its 3 item(s)');
    expect(gate.message).not.toContain('P-003');
    expect(gate.forcedPast).toBeUndefined();
  });

  it('prescribes the cheap remedy — one bulk drop — and the waiver', async () => {
    mockItems.mockResolvedValue([item('P-001', 'todo'), item('P-002', 'wip')]);

    const { message } = await evaluateSupersedeItemGate(PLAN);

    // A refusal that does not say how to satisfy it is a wall, not a gate.
    expect(message).toContain(`plans:set-status { slug:'${PLAN}'`);
    expect(message).toContain("itemIds:['P-001', 'P-002']");
    expect(message).toContain("status:'dropped'");
    expect(message).toContain('force:{ reason }');
  });

  it('passes a plan whose items are all terminal', async () => {
    mockItems.mockResolvedValue([item('P-001', 'done'), item('P-002', 'dropped')]);

    const gate = await evaluateSupersedeItemGate(PLAN);

    expect(gate).toEqual({ satisfied: true });
  });

  it('FAILS OPEN on an unreadable item index — an infra blip must not wedge a deprecate', async () => {
    // getPlanItemStatuses returns [] both for "no items" and for a PG read
    // failure and its contract forbids distinguishing them, so an empty list can
    // never produce a refusal on a blocking write.
    mockItems.mockResolvedValue([]);

    const gate = await evaluateSupersedeItemGate(PLAN);

    expect(gate.satisfied).toBe(true);
    expect(gate.code).toBeUndefined();
  });

  it('force waives the refusal and returns a forcedPast record naming the waived check', async () => {
    mockItems.mockResolvedValue([item('P-001', 'todo')]);

    const gate = await evaluateSupersedeItemGate(PLAN, { force: { reason: 'whole line abandoned' } });

    expect(gate.satisfied).toBe(true);
    expect(gate.code).toBeUndefined();
    // A waived deprecate must be loud: the caller stamps this on the plan body.
    expect(gate.forcedPast).toEqual({
      reason: 'whole line abandoned',
      checks: [SUPERSEDE_ITEMS_UNFINISHED],
    });
  });

  it('does not manufacture a waiver when there was nothing to waive', async () => {
    mockItems.mockResolvedValue([item('P-001', 'done')]);

    const gate = await evaluateSupersedeItemGate(PLAN, { force: { reason: 'belt and braces' } });

    expect(gate.satisfied).toBe(true);
    // stampForcedPastWaiver drops an empty-checks record, but not producing one at
    // all keeps the plan body clean for a deprecate that never needed forcing.
    expect(gate.forcedPast).toBeUndefined();
  });

  // WI-10005174: plan_items is keyed by the plan's own harness, so an unscoped read
  // merges two harnesses' same-slug plans. The gate resolves the home from the
  // CANDIDATE harness and scopes the item read to that resolved home.
  it('scopes the item read to the home harness resolved from the candidate', async () => {
    mockResolveHome.mockResolvedValue('email');
    mockItems.mockResolvedValue([item('P-001', 'done')]);

    await evaluateSupersedeItemGate(PLAN, { harnessSlug: 'papercusp' });

    expect(mockResolveHome).toHaveBeenCalledWith(PLAN, 'papercusp');
    expect(mockItems).toHaveBeenCalledWith(PLAN, { harnessSlug: 'email' });
  });

  it('keeps the unscoped read when no home harness resolves', async () => {
    mockItems.mockResolvedValue([item('P-001', 'done')]);

    await evaluateSupersedeItemGate(PLAN);

    expect(mockResolveHome).toHaveBeenCalledWith(PLAN, undefined);
    expect(mockItems).toHaveBeenCalledWith(PLAN, { harnessSlug: null });
  });
});
