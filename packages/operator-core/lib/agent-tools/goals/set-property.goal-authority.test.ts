import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  guard: vi.fn(),
  emit: vi.fn(),
  identity: vi.fn(() => ({ ownerId: 'holder-old' })),
  backfill: vi.fn(),
}));

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../typed-properties-db', () => ({ applyGoalPropertyWrite: mocks.apply }));
vi.mock('../coordination/identity', () => ({
  ADMIN_COORD_UI_OWNER: 'pc-admin-coord-ui',
  resolveAgentIdentity: mocks.identity,
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: mocks.emit }));
vi.mock('../../goals/write-authority', () => ({
  assertGoalWriteAuthorityForCaller: mocks.guard,
}));
vi.mock('../../goals/worklist-attribution-backfill', () => ({
  backfillWorklistGoalAttribution: mocks.backfill,
}));
vi.mock('../../goals/package-property-datatypes', () => ({ CANONICAL_WORKLIST_PROPERTY: 'worklist' }));
vi.mock('../../modes/goal-context', () => ({
  isGoalHolderAuthorityError: (error: unknown) =>
    Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'GoalHolderAuthorityError'),
}));

const tool = (await import('./set-property')).default;

const args = {
  goalId: 'goal-42',
  property: 'worklist',
  value: ['docs'],
  expectedVersion: 1,
};
const ctx = { workspaceId: 'ws-1', tx: {} };
type Out = { isError?: boolean; content: Array<{ text: string }> };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockReturnValue({ ownerId: 'holder-old' });
  mocks.guard.mockResolvedValue({ status: 'elected' });
  mocks.apply.mockResolvedValue({
    ok: true,
    priorValue: ['tests'],
    definition: { datatype: 'list', editable_by: 'both' },
    entry: { value: ['docs'], version: 2 },
  });
  mocks.backfill.mockResolvedValue({ refs: 1, plansStamped: ['docs'], workItemsStamped: ['WI-1'] });
});

describe('goals:set-property effective-holder fence', () => {
  it('checks the caller before the typed-property writer runs', async () => {
    const out = (await tool.handler({ ...args, confirmShrink: true } as never, ctx as never)) as Out;
    expect(out.isError).toBeUndefined();
    expect(mocks.guard).toHaveBeenCalledWith(ctx, 'ws-1', ctx.tx);
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.apply).toHaveBeenCalledWith(
      ctx.tx,
      expect.objectContaining({ confirmShrink: true }),
    );
  });

  it('refuses an expired predecessor without calling the property writer', async () => {
    const error = Object.assign(new Error('holder-old is superseded by holder-new'), {
      name: 'GoalHolderAuthorityError',
      code: 'goal_holder_superseded',
      authority: {
        status: 'superseded',
        goalId: 'goal-42',
        electedOwnerId: 'holder-new',
        electedEpoch: 2,
        handoffExpiresAt: null,
      },
    });
    mocks.guard.mockRejectedValue(error);

    const out = (await tool.handler(args as never, ctx as never)) as Out;
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({
      error: 'goal_holder_superseded',
      goalId: 'goal-42',
      authority: { electedOwnerId: 'holder-new' },
    });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.backfill).not.toHaveBeenCalled();
  });
});

describe('goals:set-property worklist attribution backfill (WI-10005246)', () => {
  it('forwards the reason and records affected plans on the existing history rail', async () => {
    mocks.apply.mockResolvedValue({ ok: true,
      definition: { datatype: 'ordered-selection-policy', editable_by: 'owner' },
      priorValue: { order: ['plan:h/a', 'plan:h/b'], excluded: [] },
      entry: { value: { order: ['plan:h/b', 'plan:h/a'], excluded: [] }, version: 2 } });
    await tool.handler({ ...args, property: 'worklist_policy', reason: 'Friday demo',
      value: { order: ['plan:h/b', 'plan:h/a'], excluded: [] } } as never, ctx as never);
    expect(mocks.apply).toHaveBeenCalledWith(ctx.tx, expect.objectContaining({ reason: 'Friday demo' }));
    expect(mocks.emit).toHaveBeenCalledWith(ctx, expect.objectContaining({
      planSlug: 'a', event: 'property_changed', detail: expect.stringContaining('Friday demo') }));
    expect(mocks.emit).toHaveBeenCalledWith(ctx, expect.objectContaining({
      planSlug: 'b', event: 'property_changed', detail: expect.stringContaining('Priority 2 → 1') }));
  });
  it('stamps the goal on rows of the worklist plans after a successful worklist write', async () => {
    const out = (await tool.handler(args as never, ctx as never)) as Out;
    expect(out.isError).toBeUndefined();
    // ctx.tx is {} (no savepoint), so the handler falls through to run(tx) with the tx itself.
    expect(mocks.backfill).toHaveBeenCalledOnce();
    expect(mocks.backfill).toHaveBeenCalledWith(ctx.tx, {
      workspaceId: 'ws-1',
      goalId: 'goal-42',
      worklist: ['docs'],
    });
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({
      attributionBackfill: { refs: 1, plansStamped: ['docs'], workItemsStamped: ['WI-1'] },
    });
  });

  it('does not run for a non-worklist property', async () => {
    mocks.apply.mockResolvedValue({
      ok: true,
      priorValue: 'a',
      definition: { datatype: 'text', editable_by: 'both' },
      entry: { value: 'b', version: 2 },
    });
    const out = (await tool.handler({ ...args, property: 'brief', value: 'b' } as never, ctx as never)) as Out;
    expect(out.isError).toBeUndefined();
    expect(mocks.backfill).not.toHaveBeenCalled();
    expect(JSON.parse(out.content[0]!.text)).not.toHaveProperty('attributionBackfill');
  });

  it('does not run when the typed-property writer refuses the write', async () => {
    mocks.apply.mockResolvedValue({ ok: false, code: 'version_conflict', message: 'stale' });
    await tool.handler(args as never, ctx as never);
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it('reports a stamping fault on the result instead of failing the owner worklist write', async () => {
    mocks.backfill.mockRejectedValue(new Error('stamp boom'));
    const out = (await tool.handler(args as never, ctx as never)) as Out;
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({
      version: 2,
      attributionBackfill: { error: 'stamp boom' },
    });
  });

  it('runs the backfill inside a savepoint when the transaction offers one', async () => {
    const savepoint = vi.fn(async (fn: (sp: unknown) => unknown) => fn({ sp: true }));
    const tx = { savepoint };
    await tool.handler(args as never, { workspaceId: 'ws-1', tx } as never);
    expect(savepoint).toHaveBeenCalledOnce();
    expect(mocks.backfill).toHaveBeenCalledWith({ sp: true }, expect.objectContaining({ goalId: 'goal-42' }));
  });
});
