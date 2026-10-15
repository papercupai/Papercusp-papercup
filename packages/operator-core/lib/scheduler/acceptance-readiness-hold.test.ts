import { describe, expect, it, vi } from 'vitest';
import {
  acceptanceReadinessHold,
  findOrFileAcceptanceRepairTask,
  incompleteAcceptanceBarsForItems,
  type AcceptanceReadinessHoldDeps,
  type AcceptanceRepairTaskInput,
  type RepairTaskTx,
  type RepairWorkItemInput,
} from './acceptance-readiness-hold';

type Bar = {
  barKey: string;
  mappings: Array<{ planItemId: string; lifecycleStatus?: string }>;
  readiness: { codes: string[] };
};

const bar = (barKey: string, items: Array<[string, string?]>, codes: string[]): Bar => ({
  barKey,
  mappings: items.map(([planItemId, lifecycleStatus]) => ({ planItemId, ...(lifecycleStatus ? { lifecycleStatus } : {}) })),
  readiness: { codes },
});

const snapshot = (...bars: Bar[]) => ({ bars }) as unknown as Parameters<typeof incompleteAcceptanceBarsForItems>[0];

const PLAN = 'demo-plan-2026-10-01';

/** In-memory repair-task store: the find-or-file contract the default PG impl implements under its advisory lock. */
function fakeRepairStore() {
  const tasks: Array<{ id: string; planSlug: string; terminal: boolean }> = [];
  const filed: AcceptanceRepairTaskInput[] = [];
  const findOrFileRepairTask = vi.fn(async (input: AcceptanceRepairTaskInput) => {
    const open = tasks.find((t) => t.planSlug === input.planSlug && !t.terminal);
    if (open) return { id: open.id, filed: false };
    const id = `EI-REPAIR-${tasks.length + 1}`;
    tasks.push({ id, planSlug: input.planSlug, terminal: false });
    filed.push(input);
    return { id, filed: true };
  });
  const edges = new Set<string>();
  const linkHold = vi.fn(async (input: { repairId: string; heldId: string }) => {
    edges.add(`${input.repairId}->${input.heldId}`);
    return null;
  });
  return { tasks, filed, edges, findOrFileRepairTask, linkHold };
}

function depsFor(snap: ReturnType<typeof snapshot>, store = fakeRepairStore()) {
  const deps: Partial<AcceptanceReadinessHoldDeps> = {
    resolveStamp: async (wi) =>
      wi.sourcePlanSlug && wi.sourcePlanItemIds ? { plan_slug: wi.sourcePlanSlug, item_ids: wi.sourcePlanItemIds } : null,
    readSnapshot: async () => snap,
    findOrFileRepairTask: store.findOrFileRepairTask,
    linkHold: store.linkHold,
  };
  return { deps, store };
}

const item = (id: string, itemIds: string[] | null) => ({
  id,
  harness: 'papercusp',
  payload: {},
  family: 'feature' as const,
  sourcePlanSlug: itemIds ? PLAN : null,
  sourcePlanItemIds: itemIds,
});

const ctx = { by: 'su-test', workspaceId: 'ws-test' };

describe('acceptance repair task admission', () => {
  it('creates a reviewed repair already admitted, without making it depend on its own plan contract', async () => {
    const createWorkItem = vi.fn(async (_input: RepairWorkItemInput) => ({ id: 'WI-REPAIR' }));
    const tx = vi.fn(async () => []) as unknown as RepairTaskTx;
    const result = await findOrFileAcceptanceRepairTask(
      {
        planSlug: PLAN, harness: 'papercusp', workspaceId: ctx.workspaceId, by: ctx.by,
        heldBars: [{ barKey: 'R-1', itemIds: ['P-001'], codes: ['bar_snapshot_check_missing'] }],
      },
      { workspaceId: ctx.workspaceId, begin: (fn) => fn(tx), isTerminal: () => false, createWorkItem },
    );
    expect(result).toEqual({ id: 'WI-REPAIR', filed: true });
    expect(createWorkItem).toHaveBeenCalledOnce();
    expect(createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      admission: 'auto', admittedBy: 'bypass:acceptance-contract-repair',
      payload: expect.objectContaining({ acceptanceContractRepairFor: PLAN }),
    }));
    const created = createWorkItem.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(created).not.toHaveProperty('sourcePlanSlug');
    expect(created).not.toHaveProperty('sourcePlanItemIds');
  });
});

/** Hold verdict, then the post-release routing the caller runs; returns the routing note. */
async function route(wi: ReturnType<typeof item>, deps: Partial<AcceptanceReadinessHoldDeps>): Promise<string> {
  const block = await acceptanceReadinessHold(wi, ctx, deps);
  if (!block) throw new Error(`expected ${wi.id} to be held`);
  return block.routeAfterRelease();
}

describe('incompleteAcceptanceBarsForItems (pure verdict)', () => {
  it('holds an item bound to a draft (not-accepted), method-less, or check-less BAR (R-3)', () => {
    const snap = snapshot(
      bar('R-1', [['P-001', 'draft']], ['bar_snapshot_clause_not_accepted']),
      bar('R-2', [['P-002']], ['bar_snapshot_method_missing', 'bar_snapshot_proof_missing']),
      bar('R-3', [['P-003', 'active']], ['bar_snapshot_check_missing']),
    );
    expect(incompleteAcceptanceBarsForItems(snap, ['P-001']).map((b) => b.codes)).toEqual([
      ['bar_snapshot_clause_not_accepted'],
    ]);
    // Only the HOLD codes are reported; proof/grading gaps are normal pre-ship state, not a hold.
    expect(incompleteAcceptanceBarsForItems(snap, ['p-002'])).toEqual([
      { barKey: 'R-2', itemIds: ['P-002'], codes: ['bar_snapshot_method_missing'] },
    ]);
    expect(incompleteAcceptanceBarsForItems(snap, ['P-003'])).toHaveLength(1);
  });

  it('does not hold a COMPLETE contract or an INDEPENDENT item while a sibling is held (R-18)', () => {
    const snap = snapshot(
      bar('R-1', [['P-001', 'draft']], ['bar_snapshot_clause_not_accepted']),
      // Complete contract: only proof/grading still owed — must stay claimable.
      bar('R-2', [['P-002', 'active']], ['bar_snapshot_proof_missing', 'bar_snapshot_grading_missing']),
    );
    expect(incompleteAcceptanceBarsForItems(snap, ['P-002'])).toEqual([]);
    expect(incompleteAcceptanceBarsForItems(snap, ['P-009'])).toEqual([]); // no BAR maps it
  });

  it('ignores retired / superseded / exempt mappings — a dead clause never binds an item', () => {
    const snap = snapshot(
      bar('R-1', [['P-001', 'retired']], ['bar_snapshot_clause_not_accepted']),
      bar('R-2', [['P-001', 'superseded'], ['P-001', 'exempt']], ['bar_snapshot_method_missing']),
    );
    expect(incompleteAcceptanceBarsForItems(snap, ['P-001'])).toEqual([]);
  });

  it('a multi-item work-item is held when ANY of its items is bound to an incomplete BAR', () => {
    const snap = snapshot(bar('R-4', [['P-004'], ['P-005']], ['bar_snapshot_check_missing']));
    expect(incompleteAcceptanceBarsForItems(snap, ['P-001', 'P-005'])).toEqual([
      { barKey: 'R-4', itemIds: ['P-005'], codes: ['bar_snapshot_check_missing'] },
    ]);
  });
});

describe('acceptanceReadinessHold (routing)', () => {
  it('holds the item, files ONE repair task, and writes the blocks edge (R-3, R-16)', async () => {
    const { deps, store } = depsFor(snapshot(bar('R-1', [['P-001', 'draft']], ['bar_snapshot_clause_not_accepted'])));
    const block = await acceptanceReadinessHold(item('WI-1', ['P-001']), ctx, deps);
    expect(block).toMatchObject({ planSlug: PLAN, itemId: 'P-001', effectiveStatus: 'acceptance-incomplete', staleBlockedHint: null });
    expect(block!.reason).toContain('incomplete acceptance requirement');
    // The verdict itself has no side effects: routing waits for the caller's release, because
    // the dependency store refuses a blocker behind a still-claimed (active) dependant.
    expect(store.findOrFileRepairTask).not.toHaveBeenCalled();
    expect(store.linkHold).not.toHaveBeenCalled();
    expect(await block!.routeAfterRelease()).toBe('held behind repair task EI-REPAIR-1 (filed now)');
    expect(store.filed).toHaveLength(1);
    expect(store.filed[0]).toMatchObject({ planSlug: PLAN, harness: 'papercusp', workspaceId: 'ws-test', by: 'su-test' });
    expect([...store.edges]).toEqual(['EI-REPAIR-1->WI-1']);
  });

  it('a second held item in the same plan REUSES the open repair task — no duplicate (R-16)', async () => {
    const snap = snapshot(bar('R-1', [['P-001'], ['P-002']], ['bar_snapshot_method_missing']));
    const { deps, store } = depsFor(snap);
    await route(item('WI-1', ['P-001']), deps);
    const second = await route(item('WI-2', ['P-002']), deps);
    await route(item('WI-1', ['P-001']), deps); // re-bounce of the same item
    expect(store.filed).toHaveLength(1);
    expect(store.tasks).toHaveLength(1);
    expect(second).toBe('held behind repair task EI-REPAIR-1');
    expect([...store.edges].sort()).toEqual(['EI-REPAIR-1->WI-1', 'EI-REPAIR-1->WI-2']);
  });

  it('files a FRESH repair task when the previous one closed with the contract still incomplete', async () => {
    const { deps, store } = depsFor(snapshot(bar('R-1', [['P-001']], ['bar_snapshot_check_missing'])));
    await route(item('WI-1', ['P-001']), deps);
    store.tasks[0]!.terminal = true;
    const again = await route(item('WI-1', ['P-001']), deps);
    expect(store.filed).toHaveLength(2);
    expect(again).toBe('held behind repair task EI-REPAIR-2 (filed now)');
  });

  it('does not hold, file, or link for a complete-contract item, an independent item, or unplanned work (R-18)', async () => {
    const { deps, store } = depsFor(
      snapshot(
        bar('R-1', [['P-001', 'draft']], ['bar_snapshot_clause_not_accepted']),
        bar('R-2', [['P-002', 'active']], ['bar_snapshot_proof_missing']),
      ),
    );
    expect(await acceptanceReadinessHold(item('WI-2', ['P-002']), ctx, deps)).toBeNull();
    expect(await acceptanceReadinessHold(item('WI-3', ['P-003']), ctx, deps)).toBeNull();
    expect(await acceptanceReadinessHold(item('WI-4', null), ctx, deps)).toBeNull();
    expect(store.findOrFileRepairTask).not.toHaveBeenCalled();
    expect(store.linkHold).not.toHaveBeenCalled();
  });

  it('a plan with no acceptance rubric yet (no BARs) holds nothing — rubrics come after implementation', async () => {
    const { deps, store } = depsFor(snapshot());
    expect(await acceptanceReadinessHold(item('WI-1', ['P-001']), ctx, deps)).toBeNull();
    expect(store.findOrFileRepairTask).not.toHaveBeenCalled();
  });

  it('fails OPEN on a snapshot read failure — never wedges the claim path', async () => {
    const { deps, store } = depsFor(snapshot());
    deps.readSnapshot = async () => {
      throw new Error('pg blip');
    };
    expect(await acceptanceReadinessHold(item('WI-1', ['P-001']), ctx, deps)).toBeNull();
    expect(store.findOrFileRepairTask).not.toHaveBeenCalled();
  });

  it('still HOLDS when repair routing fails — a confirmed-incomplete contract is never handed out', async () => {
    const { deps } = depsFor(snapshot(bar('R-1', [['P-001']], ['bar_snapshot_method_missing'])));
    deps.findOrFileRepairTask = async () => {
      throw new Error('lock timeout');
    };
    const block = await acceptanceReadinessHold(item('WI-1', ['P-001']), ctx, deps);
    expect(block).not.toBeNull();
    // routeAfterRelease never throws: the failure becomes the audit's routing note.
    expect(await block!.routeAfterRelease()).toBe('repair routing failed (lock timeout)');
  });

  it('reports a refused edge instead of claiming the item is routed', async () => {
    const { deps } = depsFor(snapshot(bar('R-1', [['P-001']], ['bar_snapshot_method_missing'])));
    deps.linkHold = async () => 'cycle';
    expect(await route(item('WI-1', ['P-001']), deps)).toBe(
      'repair task EI-REPAIR-1 filed, but the blocks edge was not written (cycle)',
    );
  });
});
