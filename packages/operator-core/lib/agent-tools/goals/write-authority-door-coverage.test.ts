import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  activeWorkspaceId: vi.fn(),
  isCompilableSchema: vi.fn(),
  jsonSchemaRequiredKeys: vi.fn(),
  validateRrule: vi.fn(),
  frequencyWarning: vi.fn(),
  materializeGoalSchedule: vi.fn(),
  deleteGoalSchedule: vi.fn(),
  armGoalSchedule: vi.fn(),
  deactivateGoalSchedule: vi.fn(),
  getFlag: vi.fn(),
}));

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: mocks.activeWorkspaceId }));
vi.mock('../../json-schema-validation', () => ({
  isCompilableSchema: mocks.isCompilableSchema,
  jsonSchemaRequiredKeys: mocks.jsonSchemaRequiredKeys,
}));
vi.mock('../../goals/write-authority', () => ({
  assertGoalWriteAuthorityForCaller: mocks.guard,
}));
vi.mock('../../harness/routines/schedule-next', () => ({
  validateRrule: mocks.validateRrule,
  frequencyWarning: mocks.frequencyWarning,
}));
vi.mock('../../harness/routines/materialize-goal-schedule', () => ({
  materializeGoalSchedule: mocks.materializeGoalSchedule,
  deleteGoalSchedule: mocks.deleteGoalSchedule,
  armGoalSchedule: mocks.armGoalSchedule,
  deactivateGoalSchedule: mocks.deactivateGoalSchedule,
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: mocks.getFlag }));

const inputSchemaTool = (await import('./set-input-schema')).default;
const outputSchemaTool = (await import('./set-output-schema')).default;
const setScheduleTool = (await import('./set-schedule')).default;
const armScheduleTool = (await import('./arm-schedule')).default;

const superseded = Object.assign(new Error('holder-old is superseded by holder-new'), {
  code: 'goal_holder_superseded',
});

function makeTx() {
  return vi.fn((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (/SELECT id, status FROM harness_shared\.goals/.test(sql)) {
      return Promise.resolve([{ id: 'goal-1', status: 'active' }]);
    }
    return Promise.resolve([{ id: 'goal-1' }]);
  });
}

const makeCtx = () => ({
  workspaceId: 'ws-1',
  harnessSlug: 'pot-1',
  tx: makeTx(),
  role: 'su',
});

const authorityScenarios = ['elected-write', 'superseded-set-schedule', 'superseded-arm-schedule'] as const;
const authorityControl = process.env.PAPERCUSP_GOAL_AUTHORITY_CONTROL;
if (authorityControl && !authorityScenarios.includes(authorityControl as typeof authorityScenarios[number])) {
  throw new Error(`Unknown permanent goal authority control: ${authorityControl}`);
}

async function observeScheduleDoor(scenario: typeof authorityScenarios[number], wrong = false) {
  const elected = scenario === 'elected-write';
  if (elected !== wrong) mocks.guard.mockResolvedValue({ status: 'elected' });
  else mocks.guard.mockRejectedValue(superseded);
  const ctx = makeCtx();
  let refused = false;
  try {
    if (scenario === 'superseded-arm-schedule') {
      await armScheduleTool.handler({ harness: 'pot-1', goalId: 'goal-1' } as never, ctx as never);
    } else {
      await setScheduleTool.handler({
        harness: 'pot-1', goalId: 'goal-1', schedule: { kind: 'rrule', rrule: 'FREQ=DAILY' },
      } as never, ctx as never);
      if (elected) {
        await armScheduleTool.handler({ harness: 'pot-1', goalId: 'goal-1' } as never, ctx as never);
      }
    }
  } catch (error) {
    expect(error).toBe(superseded);
    refused = true;
  }
  return {
    refused,
    materialized: mocks.materializeGoalSchedule.mock.calls.length,
    armed: mocks.armGoalSchedule.mock.calls.length,
  };
}

describe('goal authority causal controls (WI-1074216)', () => {
  it('authority calibration: an elected caller can author and arm', async () => {
    expect(await observeScheduleDoor('elected-write')).toEqual({ refused: false, materialized: 1, armed: 1 });
  });

  it.each(authorityScenarios)('repaired authority contract: %s', async (scenario) => {
    // The permanent falsifier reverses only the authority verdict at its DI seam.
    // The real handlers and side-effect spies run in both arms of the causal pair.
    const actual = await observeScheduleDoor(scenario, authorityControl === scenario);
    expect(actual, `authority-contract:${scenario}`).toEqual(
      scenario === 'elected-write'
        ? { refused: false, materialized: 1, armed: 1 }
        : { refused: true, materialized: 0, armed: 0 },
    );
  });

  it.each(authorityScenarios)('detects permanent wrong authority: %s', async (scenario) => {
    const expected = scenario === 'elected-write'
      ? { refused: false, materialized: 1, armed: 1 }
      : { refused: true, materialized: 0, armed: 0 };
    expect(await observeScheduleDoor(scenario)).toEqual(expected);
    vi.clearAllMocks();
    expect(await observeScheduleDoor(scenario, true)).not.toEqual(expected);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeWorkspaceId.mockReturnValue('ws-1');
  mocks.isCompilableSchema.mockReturnValue(true);
  mocks.jsonSchemaRequiredKeys.mockReturnValue([]);
  mocks.validateRrule.mockReturnValue({ ok: true });
  mocks.frequencyWarning.mockReturnValue(null);
  mocks.materializeGoalSchedule.mockResolvedValue({ id: 'routine-1', nextFireAt: null });
  mocks.deleteGoalSchedule.mockResolvedValue(true);
  mocks.armGoalSchedule.mockResolvedValue({ ok: true, routineId: 'routine-1', nextFireAt: null });
  mocks.deactivateGoalSchedule.mockResolvedValue(true);
  mocks.getFlag.mockResolvedValue(true);
  mocks.guard.mockResolvedValue({ status: 'elected' });
});

describe('goal schema and schedule mutation doors use the holder fence (WI-1139512)', () => {
  it.each([
    ['goals:set-input-schema', inputSchemaTool, { goalId: 'goal-1', schema: { type: 'object' } }],
    ['goals:set-output-schema', outputSchemaTool, { goalId: 'goal-1', schema: { type: 'object' } }],
  ])('refuses a superseded caller before %s writes', async (_name, tool, args) => {
    mocks.guard.mockRejectedValue(superseded);
    const ctx = makeCtx();

    await expect(tool.handler(args as never, ctx as never)).rejects.toBe(superseded);

    expect(mocks.guard).toHaveBeenCalledWith(ctx, 'ws-1', ctx.tx);
    expect(ctx.tx).not.toHaveBeenCalled();
  });

  it('refuses a superseded caller before goals:set-schedule materializes a routine', async () => {
    mocks.guard.mockRejectedValue(superseded);
    const ctx = makeCtx();

    await expect(
      setScheduleTool.handler(
        {
          harness: 'pot-1',
          goalId: 'goal-1',
          schedule: { kind: 'rrule', rrule: 'FREQ=DAILY' },
        } as never,
        ctx as never,
      ),
    ).rejects.toBe(superseded);

    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'pot-1' }), 'ws-1', ctx.tx);
    expect(mocks.materializeGoalSchedule).not.toHaveBeenCalled();
    expect(mocks.deleteGoalSchedule).not.toHaveBeenCalled();
  });

  it('refuses a superseded caller before goals:arm-schedule arms a routine', async () => {
    mocks.guard.mockRejectedValue(superseded);
    const ctx = makeCtx();

    await expect(
      armScheduleTool.handler({ harness: 'pot-1', goalId: 'goal-1' } as never, ctx as never),
    ).rejects.toBe(superseded);

    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'pot-1' }), 'ws-1', ctx.tx);
    expect(mocks.armGoalSchedule).not.toHaveBeenCalled();
    expect(mocks.deactivateGoalSchedule).not.toHaveBeenCalled();
  });

  it('preserves an ordinary elected caller on the schema and schedule paths', async () => {
    const schemaCtx = makeCtx();
    await inputSchemaTool.handler(
      { goalId: 'goal-1', schema: { type: 'object' } } as never,
      schemaCtx as never,
    );
    expect(schemaCtx.tx).toHaveBeenCalled();

    const scheduleCtx = makeCtx();
    await setScheduleTool.handler(
      {
        harness: 'pot-1',
        goalId: 'goal-1',
        schedule: { kind: 'rrule', rrule: 'FREQ=DAILY' },
      } as never,
      scheduleCtx as never,
    );
    expect(mocks.materializeGoalSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', harnessSlug: 'pot-1', goalId: 'goal-1' }),
    );
  });
});
