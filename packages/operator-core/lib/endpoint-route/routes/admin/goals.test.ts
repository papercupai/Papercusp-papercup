import { describe, expect, it, vi } from 'vitest';
import { dispatchWrite, startExistingGoal, type StartExistingGoalDeps } from './goals';
import type { StartGoalByIdResult } from '../../../goals/start-goal-by-id';
import type { handleHttpToolRequest } from '@papercusp/agent-mcp';

function toolResult(payload: unknown, status = 200) {
  return {
    status,
    body: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
  } as Awaited<ReturnType<StartExistingGoalDeps['updateGoal']>>;
}

function deps(overrides: Partial<StartExistingGoalDeps> = {}): StartExistingGoalDeps {
  return {
    updateGoal: vi.fn(async () => toolResult({ data: { id: 'G-1', status: 'active' } })),
    startGoal: vi.fn(async (): Promise<StartGoalByIdResult> => ({
      ok: true,
      goalId: 'G-1',
      ownerId: 'su-holder',
      warnings: [],
      startBlockedOverride: null,
    })),
    sql: vi.fn(() => (async () => []) as never),
    workspaceId: vi.fn(() => 'ws-1'),
    invalidate: vi.fn(),
    ...overrides,
  };
}

describe('admin goals start-existing — status plus canonical holder activation', () => {
  it('forwards collection policy CAS writes as the owner and preserves canonical refusals', async () => {
    const dispatch = vi.fn(async (_request: Parameters<typeof handleHttpToolRequest>[0],
      _extras: Parameters<typeof handleHttpToolRequest>[1]) => toolResult({ error: 'stale', actualVersion: 8 }));
    const payload = { goalId: 'G-1', property: 'tea_policy', expectedVersion: 4,
      value: { order: ['mint'], excluded: ['rooibos'] } };
    const req = new Request('http://127.0.0.1/api/admin/goals/set-property', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const res = await dispatchWrite(req, { params: { verb: 'set-property' } } as never, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const forwarded = dispatch.mock.calls[0][0];
    expect(forwarded.pathname).toBe('/api/agent-tools/goals/set-property');
    expect(forwarded.searchParams.get('client')).toBe('pc-admin-coord-ui');
    expect(forwarded.body).toEqual(payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ error: 'stale', actualVersion: 8 });
  });

  it('is mounted as a real admin verb (missing id is its own 400, not unknown-verb 404)', async () => {
    const req = new Request('http://127.0.0.1/api/admin/goals/start-existing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const res = await dispatchWrite(req, { params: { verb: 'start-existing' } } as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'goal_id_required' } });
  });

  it('reactivates first, then launches and attaches through startGoalById', async () => {
    const d = deps();
    const res = await startExistingGoal({ id: 'G-1' }, d);

    expect(res.status).toBe(200);
    expect(d.updateGoal).toHaveBeenCalledWith({
      id: 'G-1',
      status: 'active',
      reason: expect.stringContaining('HUD existing-goal start/reopen'),
    });
    expect(d.startGoal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-1',
        goalId: 'G-1',
        launcherOwnerId: 'pc-admin-coord-ui',
      }),
    );
    expect(await res.json()).toMatchObject({
      data: { id: 'G-1', status: 'active' },
      activation: { ok: true, ownerId: 'su-holder' },
    });
    expect(d.invalidate).toHaveBeenCalledTimes(1);
  });

  it('does not launch when the status transition itself fails', async () => {
    const d = deps({
      updateGoal: vi.fn(async () => ({ status: 403, body: { error: 'forbidden' } }) as never),
    });
    const res = await startExistingGoal({ id: 'G-1' }, d);

    expect(res.status).toBe(403);
    expect(d.startGoal).not.toHaveBeenCalled();
    expect(d.invalidate).not.toHaveBeenCalled();
  });

  it('reports the committed status change when launch throws', async () => {
    const d = deps({
      startGoal: vi.fn(async () => {
        throw new Error('spawn host unavailable');
      }),
    });
    const res = await startExistingGoal({ id: 'G-1' }, d);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'goal_holder_launch_failed',
        message: 'spawn host unavailable',
        statusChanged: true,
      },
    });
    expect(d.invalidate).toHaveBeenCalledTimes(1);
  });

  it('surfaces canonical activation refusals without pretending the holder exists', async () => {
    const d = deps({
      startGoal: vi.fn(async (): Promise<StartGoalByIdResult> => ({
        ok: false,
        reason: 'not-ready',
        detail: "goal 'G-1' has unsatisfied blockers",
      })),
    });
    const res = await startExistingGoal({ id: 'G-1' }, d);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'goal_activation_not-ready', statusChanged: true },
      activation: { ok: false, reason: 'not-ready' },
    });
    expect(d.invalidate).toHaveBeenCalledTimes(1);
  });

  it('treats a concurrent already-held refusal as idempotent success', async () => {
    const d = deps({
      startGoal: vi.fn(async (): Promise<StartGoalByIdResult> => ({
        ok: false,
        reason: 'already-held',
        detail: "goal 'G-1' already has a live holder (su-other)",
      })),
    });
    const res = await startExistingGoal({ id: 'G-1' }, d);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      alreadyHeld: true,
      activation: { ok: false, reason: 'already-held' },
    });
  });

  it('rejects a missing goal id before either write', async () => {
    const d = deps();
    const res = await startExistingGoal({}, d);

    expect(res.status).toBe(400);
    expect(d.updateGoal).not.toHaveBeenCalled();
    expect(d.startGoal).not.toHaveBeenCalled();
  });
});
