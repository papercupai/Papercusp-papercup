import { describe, expect, it, vi } from 'vitest';
import {
  buildWallPlanStateWarning,
  detectWallPlanStateGap,
  extractWalledPlanItemRefs,
  placeableWalledItems,
  type WalledItemStatusReader,
} from './wall-plan-state';

// WI-10005685: the wall body measured on 2026-10-02 (agent_facts key
// wall:hud-orders-p003-protected-solo, asserted 15:04:47Z by goal steward su-90a3e85e).
const MEASURED_WALL_BODY =
  'hud-orders-instant-load-2026-09-13 P-003 is PROTECTED-SOLO (plan D-001 owner route A + D-004 + ' +
  'feature-change-reconciliation#D-027): NO fleet/member/drain claim and NO fleet:launch-on-plan on it ' +
  "without Avi's literal route-change turn recorded via plans:add-decision. goal-plan-placement " +
  'reminders for it are NOT a mandate. Report as owner-walled. [goal steward su-90a3e 2026-10-02]';

const HUD = 'hud-orders-instant-load-2026-09-13';

describe('extractWalledPlanItemRefs', () => {
  it('binds the measured wall to its plan item and ignores decision anchors', () => {
    expect(extractWalledPlanItemRefs(MEASURED_WALL_BODY)).toEqual([{ planSlug: HUD, itemId: 'P-003' }]);
  });

  it('binds each item to the nearest preceding plan slug', () => {
    const body = 'alpha-plan-2026-01-02 P-001 and P-002; beta-plan-2026-03-04 P-001';
    expect(extractWalledPlanItemRefs(body)).toEqual([
      { planSlug: 'alpha-plan-2026-01-02', itemId: 'P-001' },
      { planSlug: 'alpha-plan-2026-01-02', itemId: 'P-002' },
      { planSlug: 'beta-plan-2026-03-04', itemId: 'P-001' },
    ]);
  });

  it('does not guess a plan for an item with no slug in range', () => {
    expect(extractWalledPlanItemRefs('P-003 is walled; see alpha-plan-2026-01-02 later')).toEqual([]);
    expect(extractWalledPlanItemRefs(`alpha-plan-2026-01-02 ${'x'.repeat(200)} P-003`)).toEqual([]);
    expect(extractWalledPlanItemRefs('no plan here at all')).toEqual([]);
    expect(extractWalledPlanItemRefs(null)).toEqual([]);
  });
});

describe('placeableWalledItems', () => {
  const refs = [{ planSlug: HUD, itemId: 'P-003' }];
  it('keeps an item plan state still admits (todo / wip)', () => {
    for (const status of ['todo', 'wip']) {
      expect(placeableWalledItems(refs, [{ planSlug: HUD, itemId: 'P-003', status }])).toHaveLength(1);
    }
  });
  it('drops an item already bound by plan state, and an item with no row', () => {
    for (const status of ['needs-human', 'blocked', 'done', 'dropped']) {
      expect(placeableWalledItems(refs, [{ planSlug: HUD, itemId: 'P-003', status }])).toEqual([]);
    }
    expect(placeableWalledItems(refs, [])).toEqual([]);
  });
});

describe('detectWallPlanStateGap', () => {
  const todoReader: WalledItemStatusReader = async () => [
    { planSlug: HUD, itemId: 'P-003', status: 'todo', harness: 'papercusp' },
  ];

  it('reproduces the 15:04Z incident: a wall over a todo item gets the plan-state repair', async () => {
    const w = await detectWallPlanStateGap(
      'wall:hud-orders-p003-protected-solo', MEASURED_WALL_BODY, 'papercusp-workspace', todoReader,
    );
    expect(w?.code).toBe('wall-names-placeable-plan-item');
    expect(w?.items).toEqual([{ planSlug: HUD, itemId: 'P-003', status: 'todo', harness: 'papercusp' }]);
    expect(w?.repair).toEqual([
      `plans:set-status { slug: '${HUD}', harness: 'papercusp', item: 'P-003', status: 'needs-human', ` +
        "note: '<the owner ask that clears this wall>' }",
    ]);
    expect(w?.note).toContain('read PLAN STATE');
  });

  it('is silent once plan state binds the item (the 20:53Z needs-human state)', async () => {
    const reader: WalledItemStatusReader = async () => [
      { planSlug: HUD, itemId: 'P-003', status: 'needs-human', harness: 'papercusp' },
    ];
    expect(
      await detectWallPlanStateGap('wall:hud-orders-p003-protected-solo', MEASURED_WALL_BODY, 'ws', reader),
    ).toBeNull();
  });

  it('never reads plan state for a non-wall key or without a workspace', async () => {
    const reader = vi.fn(todoReader);
    expect(await detectWallPlanStateGap('guard-rail:x', MEASURED_WALL_BODY, 'ws', reader)).toBeNull();
    expect(await detectWallPlanStateGap('wall:x', MEASURED_WALL_BODY, null, reader)).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it('is fail-soft: a read error yields no field, never a thrown assert', async () => {
    const reader: WalledItemStatusReader = async () => {
      throw new Error('statement timeout');
    };
    expect(await detectWallPlanStateGap('wall:x', MEASURED_WALL_BODY, 'ws', reader)).toBeNull();
  });
});

describe('buildWallPlanStateWarning', () => {
  it('returns null for nothing placeable and omits harness when unknown', () => {
    expect(buildWallPlanStateWarning([])).toBeNull();
    const w = buildWallPlanStateWarning([{ planSlug: HUD, itemId: 'P-003', status: 'wip' }]);
    expect(w?.repair[0]).not.toContain('harness:');
    expect(w?.note).toContain(`${HUD} P-003 (wip)`);
  });
});
