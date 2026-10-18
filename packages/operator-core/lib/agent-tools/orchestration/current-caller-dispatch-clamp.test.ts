import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';

const { getFlagMock, safeToolsRemoveSetMock } = vi.hoisted(() => ({
  getFlagMock: vi.fn(async () => true),
  safeToolsRemoveSetMock: vi.fn(() => new Set<string>()),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: getFlagMock,
}));
vi.mock('../../auth-config-overrides', () => ({ authSafeToolsRemoveSet: safeToolsRemoveSetMock }));

import { bindCurrentCallerDispatch, withNestedWorkItemId } from './current-caller-dispatch';
import { applyScopedSuperuserTransportBoundary } from '../../endpoint-route/routes/transport/scoped-superuser-transport-boundary';

describe('scoped-superuser transport boundary', () => {
  beforeEach(() => {
    getFlagMock.mockReset();
    getFlagMock.mockResolvedValue(true);
    safeToolsRemoveSetMock.mockReset();
    safeToolsRemoveSetMock.mockReturnValue(new Set());
  });

  it('denies a scoped-superuser nested crossWorkspace dispatch before the target handler runs', async () => {
    const next = vi.fn(async () => ({ ok: true }));
    const tool = { crossWorkspace: true };
    const ctx = {
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      role: 'su',
      profile: 'engineer',
      isSuperuser: true,
      tx: { outer: true },
    };

    const result = await bindCurrentCallerDispatch(
      tool as never,
      'cupboard:publish-plugin',
      {},
      ctx as never,
      next,
    ) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

    expect(getFlagMock).toHaveBeenCalledWith(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system');
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('workspace_forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('does not read the workspace clamp flag for an ordinary nested tool', async () => {
    const next = vi.fn(async (ctx: { workspaceId?: string }) => ({ workspaceId: ctx.workspaceId }));
    const tool = { needsWorkspaceTx: true };
    const ctx = {
      workspaceId: 'ws-one',
      role: 'su',
      isSuperuser: true,
      profile: 'engineer',
      tx: { outer: true },
    };

    await bindCurrentCallerDispatch(tool as never, 'work_items:get', {}, ctx as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getFlagMock).not.toHaveBeenCalled();
  });

  it('preserves scoped-safe tools and global flag administration exceptions', async () => {
    const scopedCaller = { workspaceId: 'ws-one', role: 'su', isSuperuser: true, profile: 'engineer' };

    await expect(
      applyScopedSuperuserTransportBoundary({ name: 'memory:remember', crossWorkspace: true }, scopedCaller),
    ).resolves.toMatchObject({ ok: true, scopedSuperuserClamp: true });
    await expect(
      applyScopedSuperuserTransportBoundary({ name: 'pot_git:integration_requests', crossWorkspace: true }, scopedCaller),
    ).resolves.toMatchObject({ ok: true, scopedSuperuserClamp: true });
    await expect(
      applyScopedSuperuserTransportBoundary({ name: 'flags:set', crossWorkspace: true }, scopedCaller),
    ).resolves.toMatchObject({ ok: true, scopedSuperuserClamp: true });
    expect(safeToolsRemoveSetMock).toHaveBeenCalledTimes(2);
  });

  it('still rejects engineer-only tools from a power profile', async () => {
    const result = await applyScopedSuperuserTransportBoundary(
      { name: 'tools:find', profile: 'engineer' },
      { workspaceId: 'ws-one', isSuperuser: true, profile: 'power' },
    );

    expect(result).toMatchObject({ ok: false, result: { isError: true } });
    if (!result.ok) {
      expect(result.result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('tool_not_available_for_profile'),
      });
    }
  });

  it('propagates an outer work-item to an omitted nested capability:bash attribution', async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const ctx = withNestedWorkItemId({
      workspaceId: 'ws-one',
      role: 'su',
      isSuperuser: true,
      profile: 'engineer',
      tx: { outer: true },
    } as never, 'WI-command');

    await bindCurrentCallerDispatch(
      { needsWorkspaceTx: true } as never,
      'capability:bash',
      { command: 'true' },
      ctx as never,
      async (_callCtx, args) => {
        seenArgs = args as Record<string, unknown>;
        return { ok: true };
      },
    );

    expect(seenArgs).toMatchObject({ command: 'true', work_item_id: 'WI-command' });
  });

  it('preserves explicit nested attribution over the outer default', async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const ctx = withNestedWorkItemId({
      workspaceId: 'ws-one',
      role: 'su',
      isSuperuser: true,
      profile: 'engineer',
      tx: { outer: true },
    } as never, 'WI-outer');

    await bindCurrentCallerDispatch(
      { needsWorkspaceTx: true } as never,
      'capability:bash',
      { command: 'true', work_item_id: 'WI-inner' },
      ctx as never,
      async (_callCtx, args) => {
        seenArgs = args as Record<string, unknown>;
        return { ok: true };
      },
    );

    expect(seenArgs).toMatchObject({ command: 'true', work_item_id: 'WI-inner' });
  });
});
