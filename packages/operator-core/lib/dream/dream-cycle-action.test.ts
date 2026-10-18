import { describe, expect, it, vi } from 'vitest';
import type { SystemActionCtx } from '../harness/routines/system-actions';
import type { DreamCycleResult } from './dream-cycle';
import { DREAM_ACTION_DECISION_PREFIX, makeDreamCycleAction, parseDreamCycleActionConfig } from './dream-cycle-action';

const CTX: SystemActionCtx = {
  installSlug: 'papercusp',
  workspaceId: 'ws-1',
  triggerConfig: { cron: '0 */5 * * * *' },
  payloadTemplate: null,
};

function result(overrides: Partial<DreamCycleResult> = {}): DreamCycleResult {
  return {
    fired: true,
    reason: 'completed',
    cycleId: 'cycle-1',
    attempts: 1,
    accepted: 0,
    costUsd: 0.02,
    newSpendUsd: 0.02,
    runs: [],
    ...overrides,
  };
}

describe('parseDreamCycleActionConfig', () => {
  it('retains explicit open exploration and refuses unknown problem modes', () => {
    expect(parseDreamCycleActionConfig({ problemMode: 'open-exploration' })).toEqual({ mode: 'manual', problemMode: 'open-exploration' });
    expect(() => parseDreamCycleActionConfig({ problemMode: 'foreign-problems' })).toThrow('problem mode');
  });
  it('refuses a declared pilot without its frozen protocol rather than treating it as an ordinary manual cycle', () => {
    expect(() => parseDreamCycleActionConfig({ mode: 'manual', pilot: null })).toThrow();
    expect(() => parseDreamCycleActionConfig({ mode: 'manual', pilot: { arm: 'structured-pair' } })).toThrow();
  });

  it('defaults the Start/Pause routine to manual mode and preserves bounded overrides', () => {
    expect(parseDreamCycleActionConfig(null)).toEqual({ mode: 'manual' });
    expect(
      parseDreamCycleActionConfig({
        mode: 'auto',
        cycle: { maxDreamsPerCycle: 1 },
        sampler: { arity: 2 },
      }),
    ).toEqual({
      mode: 'auto',
      cycle: { maxDreamsPerCycle: 1 },
      sampler: { arity: 2 },
    });
  });

  it('rejects an unknown mode instead of silently turning it into automatic spend', () => {
    expect(() => parseDreamCycleActionConfig({ mode: 'background' })).toThrow('unsupported dream-cycle mode');
  });
  it('rejects legacy sampler knobs, invalid money and attempts above the fixed ceiling', () => {
    expect(() => parseDreamCycleActionConfig({ sampler: { randomPartnerRate: 1 } })).toThrow('Unsupported');
    expect(() => parseDreamCycleActionConfig({ cycle: { maxCostUsd: -1 } })).toThrow('finite');
    expect(() => parseDreamCycleActionConfig({ cycle: { rolling24hCostUsd: Infinity } })).toThrow('finite');
    expect(() => parseDreamCycleActionConfig({ cycle: { maxDreamsPerCycle: 4 } })).toThrow('ceiling');
  });
  it('preserves explicitly configured larger monetary limits for the production governor', () => {
    expect(parseDreamCycleActionConfig({ cycle: { maxCostUsd: 10, rolling24hCostUsd: 200 } })).toMatchObject({
      mode: 'manual', cycle: { maxCostUsd: 10, rolling24hCostUsd: 200 },
    });
  });
});

describe('makeDreamCycleAction', () => {
  it.each(['feature-off', 'owner-idle-disabled', 'idle-ratio-below-floor'])(
    'records the actual %s policy branch with zero paid calls before any cycle', async reason => {
      const log = vi.fn(), runCycle = vi.fn(async () => result());
      const action = makeDreamCycleAction({ featureEnabled: async () => reason !== 'feature-off',
        idleAllowed: async () => reason !== 'owner-idle-disabled', readIdleRatio: async () => 0,
        runCycle, log });
      await action({ ...CTX, payloadTemplate: { mode: 'auto' } });
      expect(runCycle).not.toHaveBeenCalled();
      const line = log.mock.calls.map(args => args[0]).find(line => line.startsWith(DREAM_ACTION_DECISION_PREFIX));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice(DREAM_ACTION_DECISION_PREFIX.length))).toMatchObject({ schemaVersion: 1,
        workspaceId: CTX.workspaceId, potSlug: CTX.installSlug, mode: 'auto', reason,
        disposition: 'pre-attempt-policy-skip', paidCalls: 0, model: null, usage: null, costUsd: 0,
        runtime: expect.objectContaining({ processId: expect.any(String) }), capturedAt: expect.any(String),
      });
      const recorded = JSON.parse(line!.slice(DREAM_ACTION_DECISION_PREFIX.length));
      expect(recorded.admission.find((g: { gate: string }) => g.gate === 'source').status).toBe('not-reached');
      expect(recorded.admission.find((g: { gate: string }) => g.gate === 'governor').status).toBe('not-reached');
      expect(recorded.admission.filter((g: { status: string }) => g.status === 'refused')).toHaveLength(1);
    });
  it('gates the whole surface on DREAM_CYCLE', async () => {
    const runCycle = vi.fn(async () => result());
    const idleAllowed = vi.fn(async () => true);
    const readIdleRatio = vi.fn(async () => 1);
    const log = vi.fn();
    const action = makeDreamCycleAction({
      featureEnabled: vi.fn(async () => false),
      idleAllowed,
      readIdleRatio,
      runCycle,
      log,
    });

    await action(CTX);

    expect(runCycle).not.toHaveBeenCalled();
    expect(idleAllowed).not.toHaveBeenCalled();
    expect(readIdleRatio).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('DREAM_CYCLE feature flag is OFF'));
  });

  it('runs a manual Start/Pause fire without consulting automatic-idle gates', async () => {
    const runCycle = vi.fn(async () => result());
    const idleAllowed = vi.fn(async () => false);
    const readIdleRatio = vi.fn(async () => 0);
    const action = makeDreamCycleAction({
      featureEnabled: vi.fn(async () => true),
      idleAllowed,
      readIdleRatio,
      runCycle,
      log: vi.fn(),
    });

    await action({ ...CTX, payloadTemplate: { mode: 'manual' } });

    expect(runCycle).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'papercusp' }), { mode: 'manual' }, expect.any(Function));
    expect(idleAllowed).not.toHaveBeenCalled();
    expect(readIdleRatio).not.toHaveBeenCalled();
  });

  it('keeps automatic dreaming dark when the separate owner steering toggle is off', async () => {
    const runCycle = vi.fn(async () => result());
    const readIdleRatio = vi.fn(async () => 1);
    const action = makeDreamCycleAction({
      featureEnabled: vi.fn(async () => true),
      idleAllowed: vi.fn(async () => false),
      readIdleRatio,
      runCycle,
      log: vi.fn(),
    });

    await action({ ...CTX, payloadTemplate: { mode: 'auto' } });

    expect(runCycle).not.toHaveBeenCalled();
    expect(readIdleRatio).not.toHaveBeenCalled();
  });

  it('requires measured idle headroom before an enabled auto routine can spend', async () => {
    const runCycle = vi.fn(async () => result());
    const readIdleRatio = vi.fn().mockResolvedValueOnce(0.49).mockResolvedValueOnce(0.5);
    const action = makeDreamCycleAction({
      featureEnabled: vi.fn(async () => true),
      idleAllowed: vi.fn(async () => true),
      readIdleRatio,
      runCycle,
      log: vi.fn(),
    });
    const auto = { ...CTX, payloadTemplate: { mode: 'auto', cycle: { autoIdleRatioFloor: 0.5 } } };

    await action(auto);
    expect(runCycle).not.toHaveBeenCalled();

    await action(auto);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(runCycle).toHaveBeenCalledWith(auto, {
      mode: 'auto',
      cycle: { autoIdleRatioFloor: 0.5 },
    }, expect.any(Function));
  });

  it('retains production governor inputs and repeated pause refusals instead of treating dispatch as admission', async () => {
    const log = vi.fn();
    const action = makeDreamCycleAction({ featureEnabled: async () => true,
      runCycle: async (_ctx, _config, observe) => {
        observe({ gate: 'source', status: 'passed', inputs: { rootPath: '/registered' } });
        observe({ gate: 'governor', status: 'passed', inputs: { allow: true, rollingRemainingUsd: 4, cycleRemainingUsd: 1 } });
        observe({ gate: 'continue', status: 'passed', inputs: { active: true } });
        observe({ gate: 'continue', status: 'refused', inputs: { reason: 'routine-inactive' } });
        return result({ reason: 'aborted' });
      }, log });
    await action({ ...CTX, payloadTemplate: { mode: 'manual' } });
    const row = JSON.parse(log.mock.calls.find(([line]) => line.startsWith(DREAM_ACTION_DECISION_PREFIX))![0].slice(DREAM_ACTION_DECISION_PREFIX.length));
    expect(row.admission.filter((g: { gate: string }) => g.gate === 'continue').map((g: { status: string }) => g.status)).toEqual(['passed', 'refused']);
    expect(row.admission.find((g: { gate: string }) => g.gate === 'governor').inputs).toMatchObject({ rollingRemainingUsd: 4 });
    expect(row.admission.find((g: { gate: string }) => g.gate === 'idle-ratio').status).toBe('not-applicable');
  });
});
