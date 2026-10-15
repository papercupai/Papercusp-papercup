import { describe, expect, it, vi } from 'vitest';

import type { Sql } from 'postgres';

import {
  GOAL_EDIT_CLAIM_SWEEP_ROW_CAP,
  advanceHighWaterMark,
  groupEditClaims,
  runGoalEditClaimSweepOnce,
  type EditClaimRowLike,
  type GoalEditClaimAlert,
  type GoalEditClaimSweepDeps,
} from './goal-edit-claim-watchdog';

const NOW = 1_800_000_000_000;

function makeRow(over: Partial<EditClaimRowLike> = {}): EditClaimRowLike {
  return {
    ledgerId: 100,
    agentId: 'su-goal-owner',
    workspaceId: 'ws',
    goalId: 'g-1',
    file: 'packages/x/a.ts',
    repo: 'papercusp',
    tsMs: NOW,
    ...over,
  };
}

// The default deps hit PG/flags — every sweep test injects the full surface.
const sqlNever = ((..._args: unknown[]) => {
  throw new Error('sql must not be called when all deps are injected');
}) as unknown as Sql;

function makeDeps(over: Partial<GoalEditClaimSweepDeps> = {}): GoalEditClaimSweepDeps &
  Required<Pick<GoalEditClaimSweepDeps, 'readNewEditClaims'>> {
  return {
    readNewEditClaims: vi.fn(async () => ({ rows: [] as EditClaimRowLike[], ledgerMaxId: 0 })),
    resolveGraders: vi.fn(async () => new Map<string, string[]>()),
    escalate: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    emitEditClaim: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    rail: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) },
    readOpenConditionKeys: vi.fn(async () => []),
    readGoalState: vi.fn(async () => null),
    ...over,
  };
}

describe('groupEditClaims (pure)', () => {
  it('keeps delimiter-containing workspace and goal identities independent', () => {
    expect(groupEditClaims([
      makeRow({ workspaceId: 'ws:other', goalId: 'g-1' }),
      makeRow({ workspaceId: 'ws', goalId: 'other:g-1' }),
    ])).toHaveLength(2);
  });

  it('groups rows into one alert per (workspace, goal, owner)', () => {
    const alerts = groupEditClaims([
      makeRow({ ledgerId: 1, agentId: 'su-a' }),
      makeRow({ ledgerId: 2, agentId: 'su-a', file: 'packages/x/b.ts' }),
      makeRow({ ledgerId: 3, agentId: 'su-b' }),
      makeRow({ ledgerId: 4, agentId: 'su-a', goalId: 'g-2' }),
    ]);
    expect(alerts).toHaveLength(3);
    const a = alerts.find((x) => x.agentId === 'su-a' && x.goalId === 'g-1')!;
    expect(a.claimCount).toBe(2);
    expect(a.files).toEqual(['packages/x/a.ts', 'packages/x/b.ts']);
    expect(a.maxLedgerId).toBe(2);
  });

  it('CONTROL (falsifiability): a per-goal-only grouping would under-report the two-owner fixture', () => {
    // A deliberately-wrong grouping — key by goal alone, the way a first-draft
    // implementation might — collapses two different owners editing under one goal
    // into ONE alert. The fixture below distinguishes it from the real grouping, so
    // this suite CAN fail if the per-owner axis is ever dropped.
    const wrongGroupByGoalOnly = (rows: readonly EditClaimRowLike[]) =>
      new Set(rows.map((r) => `${r.workspaceId}:${r.goalId}`)).size;
    const rows = [makeRow({ ledgerId: 1, agentId: 'su-a' }), makeRow({ ledgerId: 2, agentId: 'su-b' })];
    expect(wrongGroupByGoalOnly(rows)).toBe(1); // the wrong shape
    expect(groupEditClaims(rows)).toHaveLength(2); // the real one keeps both owners
  });

  it('dedups repeated files and caps the inline sample while counting every claim', () => {
    const rows = [
      makeRow({ ledgerId: 1, file: 'f1' }),
      makeRow({ ledgerId: 2, file: 'f1' }),
      makeRow({ ledgerId: 3, file: 'f2' }),
      makeRow({ ledgerId: 4, file: 'f3' }),
      makeRow({ ledgerId: 5, file: 'f4' }),
      makeRow({ ledgerId: 6, file: 'f5' }),
      makeRow({ ledgerId: 7, file: 'f6' }),
    ];
    const [alert] = groupEditClaims(rows);
    expect(alert.claimCount).toBe(7);
    expect(alert.files).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']); // sample capped at 5
    expect(alert.maxLedgerId).toBe(7);
    expect(alert.firstTsMs).toBe(NOW);
  });
});

describe('advanceHighWaterMark (pure)', () => {
  it('advances to the ledger max on an uncapped batch (a claim-free tick still moves)', () => {
    expect(advanceHighWaterMark([], 42)).toBe(42);
    expect(advanceHighWaterMark([makeRow({ ledgerId: 10 })], 42)).toBe(42);
  });

  it('stops at the batch tail when the row cap was hit — the overflow drains next tick', () => {
    const rows = Array.from({ length: GOAL_EDIT_CLAIM_SWEEP_ROW_CAP }, (_, i) =>
      makeRow({ ledgerId: i + 1 }),
    );
    expect(advanceHighWaterMark(rows, 9_999)).toBe(GOAL_EDIT_CLAIM_SWEEP_ROW_CAP);
  });
});

describe('runGoalEditClaimSweepOnce', () => {
  const key = (workspace = 'ws', goal = 'g-1', owner = 'su-goal-owner') =>
    'alarm:goal-edit-claim:' + encodeURIComponent(JSON.stringify([workspace, goal, owner]));

  it('opens independent oneShot conditions before legacy escalation, even when legacy fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const broadcast = vi.fn(async (_event: { conditionKey?: string; oneShot?: boolean }) => { order.push('condition'); return true; });
    const deps = makeDeps({
      readNewEditClaims: async () => ({ rows: [makeRow(), makeRow({ agentId: 'su-other' }),
        makeRow({ workspaceId: 'other' }), makeRow({ goalId: 'g-2' })], ledgerMaxId: 100 }),
      rail: { broadcast, resolve: vi.fn(async () => true) },
      escalate: async () => { order.push('legacy'); throw new Error('legacy down'); },
    });
    try {
      await runGoalEditClaimSweepOnce(sqlNever, null, deps);
      expect(order).toEqual(['condition', 'legacy', 'condition', 'legacy', 'condition', 'legacy', 'condition', 'legacy']);
      expect(broadcast.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining([
        expect.objectContaining({ conditionKey: key(), oneShot: true }),
        expect.objectContaining({ conditionKey: key('ws', 'g-1', 'su-other'), oneShot: true }),
        expect.objectContaining({ conditionKey: key('other'), oneShot: true }),
        expect.objectContaining({ conditionKey: key('ws', 'g-2'), oneShot: true }),
      ]));
      expect(deps.notify).toHaveBeenCalledTimes(4);
      expect(deps.emitEditClaim).toHaveBeenCalledTimes(4);
    } finally { warn.mockRestore(); }
  });

  it.each(['active', 'paused', 'draft', 'unknown'])('preserves a durable violation through an empty scan with goal status %s', async status => {
    const deps = makeDeps({ readOpenConditionKeys: async () => [key()],
      readGoalState: async () => ({ workspaceId: 'ws', goalId: 'g-1', status }) });
    await runGoalEditClaimSweepOnce(sqlNever, 100, deps);
    expect(deps.rail!.resolve).not.toHaveBeenCalled();
  });

  it.each(['achieved', 'killed'])('recovers a persisted episode after restart only from measured matching %s goal closure', async status => {
    const deps = makeDeps({ readOpenConditionKeys: async () => [key(), 'alarm:sibling', CONDITION_BAD],
      readGoalState: vi.fn(async () => ({ workspaceId: 'ws', goalId: 'g-1', status })) });
    await runGoalEditClaimSweepOnce(sqlNever, null, deps);
    expect(deps.readGoalState).toHaveBeenCalledExactlyOnceWith('ws', 'g-1');
    expect(deps.rail!.resolve).toHaveBeenCalledExactlyOnceWith({ conditionKey: key(), summary: 'goal-edit-claim-watchdog recovered' });
  });

  it('preserves missing, unreadable and sibling terminal goal readings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const readGoalState of [async () => null, async () => { throw new Error('store down'); },
        async () => ({ workspaceId: 'other', goalId: 'g-1', status: 'achieved' }),
        async () => ({ workspaceId: 'ws', goalId: 'other', status: 'achieved' })]) {
        const deps = makeDeps({ readOpenConditionKeys: async () => [key()], readGoalState });
        await runGoalEditClaimSweepOnce(sqlNever, 100, deps);
        expect(deps.rail!.resolve).not.toHaveBeenCalled();
      }
    } finally { warn.mockRestore(); }
  });

  it('uses the goal store exact workspace and goal status for durable recovery without needing a goal-mode row', async () => {
    const queries: unknown[][] = [];
    const sql = (async (_parts: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(values);
      return [{ workspace_id: 'ws', id: 'g-1', status: 'killed' }];
    }) as unknown as Sql;
    const deps = makeDeps({ readOpenConditionKeys: async () => [key()], readGoalState: undefined });
    delete (deps as Partial<GoalEditClaimSweepDeps>).readGoalState;
    await runGoalEditClaimSweepOnce(sql, 100, deps);
    expect(queries).toEqual([['ws', 'g-1']]);
    expect(deps.rail!.resolve).toHaveBeenCalledExactlyOnceWith({ conditionKey: key(), summary: 'goal-edit-claim-watchdog recovered' });
  });

  it('contains rail failures without suppressing the subject, graders or legacy alert', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ readNewEditClaims: async () => ({ rows: [makeRow()], ledgerMaxId: 100 }),
      rail: { broadcast: async () => { throw new Error('rail down'); } },
      readOpenConditionKeys: async () => { throw new Error('condition read down'); } });
    try {
      expect((await runGoalEditClaimSweepOnce(sqlNever, null, deps)).alerted).toBe(1);
      expect(deps.notify).toHaveBeenCalledTimes(1);
      expect(deps.emitEditClaim).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('escalates, notifies subject+graders, and emits the event for a goal-owner edit claim', async () => {
    const deps = makeDeps({
      readNewEditClaims: vi.fn(async () => ({
        rows: [makeRow({ ledgerId: 7 })],
        ledgerMaxId: 7,
      })),
      resolveGraders: vi.fn(async () => new Map([['ws', ['su-grader']]])),
    });
    const res = await runGoalEditClaimSweepOnce(sqlNever, null, deps);
    expect(res).toEqual({ scanned: 1, alerted: 1, skipped: false, nextSinceLedgerId: 7 });
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    const alert = (deps.escalate as ReturnType<typeof vi.fn>).mock.calls[0][0] as GoalEditClaimAlert;
    expect(alert.goalId).toBe('g-1');
    expect(alert.agentId).toBe('su-goal-owner');
    expect(deps.notify).toHaveBeenCalledWith(alert, ['su-grader']);
    expect(deps.emitEditClaim).toHaveBeenCalledWith(alert);
  });

  it('flag OFF: skips without reading and leaves the high-water mark unchanged', async () => {
    const deps = makeDeps({ flagEnabled: vi.fn(async () => false) });
    const res = await runGoalEditClaimSweepOnce(sqlNever, 55, deps);
    expect(res).toEqual({ scanned: 0, alerted: 0, skipped: true, nextSinceLedgerId: 55 });
    expect(deps.readNewEditClaims).not.toHaveBeenCalled();
    expect(deps.readOpenConditionKeys).not.toHaveBeenCalled();
    expect(deps.readGoalState).not.toHaveBeenCalled();
  });

  it('a claim-free tick alerts nothing but still advances the mark to the ledger max', async () => {
    const deps = makeDeps({
      readNewEditClaims: vi.fn(async () => ({ rows: [], ledgerMaxId: 123 })),
    });
    const res = await runGoalEditClaimSweepOnce(sqlNever, 100, deps);
    expect(res).toEqual({ scanned: 0, alerted: 0, skipped: false, nextSinceLedgerId: 123 });
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.resolveGraders).not.toHaveBeenCalled();
  });

  it('passes the high-water mark through to the reader (boot null vs steady-state id)', async () => {
    const deps = makeDeps();
    await runGoalEditClaimSweepOnce(sqlNever, null, deps);
    expect(deps.readNewEditClaims).toHaveBeenLastCalledWith(null);
    await runGoalEditClaimSweepOnce(sqlNever, 9, deps);
    expect(deps.readNewEditClaims).toHaveBeenLastCalledWith(9);
  });

  it('grader resolution failing suppresses nothing — the subject is still notified', async () => {
    const deps = makeDeps({
      readNewEditClaims: vi.fn(async () => ({ rows: [makeRow()], ledgerMaxId: 100 })),
      resolveGraders: vi.fn(async () => {
        throw new Error('liveness oracle degraded');
      }),
    });
    const res = await runGoalEditClaimSweepOnce(sqlNever, 1, deps);
    expect(res.alerted).toBe(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect((deps.notify as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([]);
  });

  it('one alert failing its escalation never starves the rest (per-alert containment)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const escalate = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error('coord log down'));
      const deps = makeDeps({
        readNewEditClaims: vi.fn(async () => ({
          rows: [makeRow({ ledgerId: 1, agentId: 'su-a' }), makeRow({ ledgerId: 2, agentId: 'su-b' })],
          ledgerMaxId: 2,
        })),
        escalate,
      });
      const res = await runGoalEditClaimSweepOnce(sqlNever, 0, deps);
      expect(res.alerted).toBe(1); // the surviving alert
      expect(deps.emitEditClaim).toHaveBeenCalledTimes(2); // both still emit
      expect(deps.notify).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

const CONDITION_BAD = 'alarm:goal-edit-claim:%broken';
