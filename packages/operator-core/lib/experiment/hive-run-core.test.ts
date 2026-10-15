import { describe, expect, it, vi } from 'vitest';
import { BASELINE_ID, type BatteryCellResult, type BatteryRubric, type BatteryScore, type JudgeLlmCall } from '@papercusp/eval-battery';
import { makeFakeHivePorts, type HiveRunHandle, type HiveRunPorts, type HiveScenarioCell } from '../pot-eval/run-harness';
import { GYM_JUDGE_RUBRIC_V1 } from '../gym/judge-scoring';
import type { HiveScenario } from '../pot-eval/scenario';
import {
  armToHiveCells,
  hiveResultsToExperimentResult,
  hiveRunCore,
  type HiveExperimentPayload,
  type HiveExperimentRequest,
  type HiveRunCoreDeps,
} from './hive-run-core';

const scenario = () => ({ id: 's1', title: 'scenario', shape: 'star', workItems: [], acceptance: { description: 'done' } } as unknown as HiveScenario);
const payload = (over: Partial<HiveExperimentPayload> = {}): HiveExperimentPayload => ({
  scenario: scenario(),
  rubric: {} as BatteryRubric,
  seed: 7,
  budgetUsdCap: 3,
  beeCap: 2,
  ...over,
});
const req = (over: Partial<HiveExperimentRequest> = {}): HiveExperimentRequest => ({
  batteryId: 'b1',
  arms: [{ id: 'cand', knobs: { 'model.queen': 'claude-opus-4-8' } }],
  payload: payload(),
  repeats: 1,
  ...over,
});

const judge = (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as unknown as JudgeLlmCall;

function mkScore(composite: number): BatteryScore {
  return { d1: composite, d2: composite, d3: composite, composite, rationale: '', judgeModel: 'm', rubricHash: 'rh', judgeTemp: 0, weights: {} as never, costUsd: 0.05, inputTokens: 0, outputTokens: 0 };
}

describe('armToHiveCells', () => {
  it('empty-knobs arm → no variantConfig, one cell per repeat, arm-scoped runId + instanceId', () => {
    const a = armToHiveCells({ id: BASELINE_ID, knobs: {} }, payload(), 2);
    expect(a.cells).toHaveLength(2);
    expect(a.cells[0]!.runId).toBe(`${BASELINE_ID}::r0`);
    expect(a.cells[0]!.cell.instanceId).toBe(BASELINE_ID);
    expect(a.cells[0]!.cell.variantConfig).toBeUndefined();
    expect(a.cells[0]!.cell.seed).toBe(7);
  });

  it('a model.<role> knob → variantConfig.modelOverrides (the spawn-time axis)', () => {
    const a = armToHiveCells({ id: 'm', knobs: { 'model.queen': 'claude-opus-4-8' } }, payload(), 1);
    expect(a.cells[0]!.cell.variantConfig?.modelOverrides).toEqual({ queen: 'claude-opus-4-8' });
    expect(a.cells[0]!.cell.variantConfig?.genome).toBeUndefined();
  });

  it('a genome.* knob → variantConfig.genome merged onto the base', () => {
    const a = armToHiveCells({ id: 'g', knobs: { 'genome.config.wake.minSleepSec': 90 } }, payload({ baseGenome: { prompts: {}, config: {} } }), 1);
    expect(a.cells[0]!.cell.variantConfig?.genome?.config?.wake).toMatchObject({ minSleepSec: 90 });
  });
});

describe('hiveResultsToExperimentResult', () => {
  it('withholds winner and scorecard when a judge charge is unknown', () => {
    const row = (instanceId: string, composite: number, measured: boolean): BatteryCellResult<HiveScenarioCell, HiveRunHandle, unknown> => ({
      runId: instanceId, cell: { instanceId } as HiveScenarioCell, handle: { costUsd: 0.2 } as HiveRunHandle,
      score: mkScore(composite), status: 'scored', judgeCostUsd: 0.03, judgeCostMeasured: measured, elapsedMs: 0,
    });
    const out = hiveResultsToExperimentResult([{ armId: BASELINE_ID, label: 'base' }, { armId: 'cand', label: 'cand' }], new Map([[BASELINE_ID, [row(BASELINE_ID, 4, true)]], ['cand', [row('cand', 9, false)]]]));
    expect(out.totalCostUsd).toBeCloseTo(0.46);
    expect(out.costMeasured).toBe(false);
    expect(out.winner).toBeNull();
    expect(out.comparison).toBeNull();
    expect(Object.values(out.scorecardScores!)).toEqual([null, null, null]);
  });

  it('includes measured failed-judge charges in the arm and total cost', () => {
    const failed: BatteryCellResult<HiveScenarioCell, HiveRunHandle, unknown> = {
      runId: 'failed', cell: { instanceId: BASELINE_ID } as HiveScenarioCell,
      handle: { costUsd: 0.2 } as HiveRunHandle, status: 'errored', error: 'invalid judge output',
      judgeCostUsd: 0.04, judgeCostMeasured: true, elapsedMs: 0,
    };
    const out = hiveResultsToExperimentResult([{ armId: BASELINE_ID, label: 'baseline' }], new Map([[BASELINE_ID, [failed]]]));
    expect(out.arms[0].costUsd).toBeCloseTo(0.24);
    expect(out.totalCostUsd).toBeCloseTo(0.24);
    expect(out.arms[0].scored).toBe(0);
    expect(out.winner).toBeNull();
  });

  it('groups per-arm cells → mean composite + compareArms verdict + summed cost', () => {
    const cell = (instanceId: string): HiveScenarioCell => ({ instanceId, scenario: scenario(), repeat: 0, seed: 1, budgetUsdCap: 1, beeCap: 1 });
    const row = (armId: string, composite: number): BatteryCellResult<HiveScenarioCell, HiveRunHandle, unknown> => ({
      runId: `${armId}::r0`,
      cell: cell(armId),
      handle: { costUsd: 0.2 } as HiveRunHandle,
      score: mkScore(composite),
      status: 'scored',
      judgeCostUsd: 0.05,
      judgeCostMeasured: true,
      elapsedMs: 0,
    });
    const byArm = new Map<string, BatteryCellResult<HiveScenarioCell, HiveRunHandle, unknown>[]>([
      [BASELINE_ID, [row(BASELINE_ID, 4)]],
      ['cand', [row('cand', 9)]],
    ]);
    const out = hiveResultsToExperimentResult(
      [
        { armId: BASELINE_ID, label: 'baseline' },
        { armId: 'cand', label: 'cand' },
      ],
      byArm,
    );
    expect(out.testId).toBe('hive');
    expect(out.arms.map((a) => a.meanScore)).toEqual([4, 9]);
    expect(out.winner).toBe('cand');
    // per arm: handle 0.2 + judge 0.05 = 0.25 × 2 arms
    expect(out.totalCostUsd).toBeCloseTo(0.5, 5);
  });
});

describe('hiveRunCore', () => {
  it('uses actual fake-provider charges across failed repairs and stops booting on unknown spend', async () => {
    const fake = makeFakeHivePorts(() => ({ costUsd: 0.2 }));
    let calls = 0;
    const llmCall: JudgeLlmCall = async () => {
      if (++calls === 3) throw new Error('charge unavailable');
      return { text: 'invalid judge output', costUsd: 0.02, inputTokens: 10, outputTokens: 5 };
    };
    const out = await hiveRunCore(req({ repeats: 2, payload: payload({ rubric: GYM_JUDGE_RUBRIC_V1 }) }), { workspaceId: 'ws', now: fake.ports.now, ports: fake.ports, llmCall });
    expect(calls).toBe(3);
    expect(fake.booted).toHaveLength(2);
    expect(fake.tornDown).toHaveLength(2);
    expect(out.totalCostUsd).toBeCloseTo(0.44);
    expect(out.arms[0].costUsd).toBeCloseTo(0.44);
    expect(out.arms[1].cells).toBe(0);
    expect(out.costMeasured).toBe(false);
    expect(out.winner).toBeNull();
  });

  it('refuses (staged) with NO spend when ctx.hive.ports is absent', async () => {
    const runBattery = vi.fn();
    await expect(
      hiveRunCore(req(), { workspaceId: 'ws', now: () => 0, llmCall: judge }, { runBattery } as unknown as HiveRunCoreDeps),
    ).rejects.toThrow(/STAGED until the owner arms it/);
    expect(runBattery).not.toHaveBeenCalled();
  });

  it('delegates all arm×repeat cells to one runBattery, groups by arm, normalizes (baseline auto-prepended)', async () => {
    const runBattery = vi.fn(async (config: { cells: { runId: string; cell: HiveScenarioCell }[] }) =>
      config.cells.map((c) => ({
        runId: c.runId,
        cell: c.cell,
        handle: { costUsd: 0.2 } as HiveRunHandle,
        score: mkScore(c.runId.startsWith(BASELINE_ID) ? 5 : 8),
        status: 'scored' as const,
        judgeCostUsd: 0.05,
        judgeCostMeasured: true,
        elapsedMs: 0,
      })),
    );
    const out = await hiveRunCore(
      req({ repeats: 1 }),
      { workspaceId: 'ws', now: () => 0, llmCall: judge, ports: {} as HiveRunPorts },
      { runBattery } as unknown as HiveRunCoreDeps,
    );
    expect(runBattery).toHaveBeenCalledTimes(1);
    expect(runBattery.mock.calls[0]![0]).toMatchObject({ stopOnUnmeasuredJudgeCost: true });
    // baseline auto-prepended + cand, each 1 repeat = 2 cells in one battery
    const passedCells = (runBattery.mock.calls[0]![0] as { cells: unknown[] }).cells;
    expect(passedCells).toHaveLength(2);
    expect(out.arms.map((a) => a.id)).toEqual([BASELINE_ID, 'cand']);
    expect(out.winner).toBe('cand');
  });

  it('rejects a missing scenario / rubric before spend', async () => {
    await expect(
      hiveRunCore(
        req({ payload: { scenario: undefined as unknown as HiveScenario, rubric: {} as BatteryRubric } }),
        { workspaceId: 'ws', now: () => 0, llmCall: judge, ports: {} as HiveRunPorts },
        { runBattery: vi.fn() } as unknown as HiveRunCoreDeps,
      ),
    ).rejects.toThrow(/scenario/);
  });
});
