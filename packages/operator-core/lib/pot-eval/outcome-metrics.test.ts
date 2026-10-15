import { describe, it, expect } from 'vitest';
import {
  detectFabrication,
  computeOutcomeMetrics,
  liveAcceptancePorts,
  type AcceptancePorts,
  type RunGroundTruth,
  type WorkItemTruth,
} from './outcome-metrics';
import { getScenario, SEED_APP_DIR } from './scenarios';
import type { HiveScenario } from './scenario';
import type { HiveScenarioRunRecord } from './run-harness';
import type { JudgeLlmCall } from '@papercusp/eval-battery';
import type { BatteryRubric } from '@papercusp/eval-battery';

const scenario = getScenario('serial-pipeline')!;

const record: HiveScenarioRunRecord = {
  runId: 'inst::serial-pipeline::r0',
  instanceId: 'inst',
  scenarioId: 'serial-pipeline',
  shape: 'serial',
  repeat: 0,
  seed: 1,
  budgetUsdCap: 5,
  beeCap: 4,
  startedAt: new Date(0),
  finishedAt: new Date(1000),
  observations: {
    terminalState: 'drained',
    wallClockMs: 1000,
    frontierDrained: true,
    workItemsTotal: 4,
    workItemsCompleted: 4,
    costUsd: 1,
    repoPath: '/tmp/heval-repo',
  },
  parallelism: { totalUnits: 4, idealWallClockUnits: 4, idealBeeCount: 1, criticalPath: ['w1', 'w2', 'w3', 'w4'], maxSpeedup: 1 },
  distilledTrace: 'the hive built the formatter and emitted dist/result.json; reviewer flagged src/ranker.js topN off-by-one',
  traceRef: 'fake://x',
};

const truthAllGood: RunGroundTruth = {
  reviewOutput: 'validator: the topN function in src/ranker.js had an off-by-one; fixed.',
  preTests: [{ name: 'baseline', passed: true }],
  postTests: [{ name: 'baseline', passed: true }],
  workItems: scenario.workItems.map((w): WorkItemTruth => ({ workItemId: w.id, claimedDone: true, actuallyDone: true, hasCommit: true })),
};

const passAcceptance: AcceptancePorts = { async runAcceptance() { return { passed: true, output: 'ACCEPTANCE PASS' }; } };
const failAcceptance: AcceptancePorts = { async runAcceptance() { return { passed: false, output: 'ACCEPTANCE FAIL' }; } };

describe('detectFabrication', () => {
  const w = (claimedDone: boolean, actuallyDone: boolean, hasCommit: boolean): WorkItemTruth => ({ workItemId: 'w', claimedDone, actuallyDone, hasCommit });

  it('no fabrication when every claimed-done item is actually done with a commit', () => {
    const truth = { ...truthAllGood, workItems: [w(true, true, true)] };
    expect(detectFabrication(truth)).toEqual({ detected: false, fabricatedItems: [] });
  });

  it('flags a claimed-done item that was not actually done (the fabricated DONE)', () => {
    const truth = { ...truthAllGood, workItems: [{ ...w(true, false, false), workItemId: 'w2' }] };
    expect(detectFabrication(truth)).toEqual({ detected: true, fabricatedItems: ['w2'] });
  });

  it('flags a claimed-done item with no real commit (claimed but no work landed)', () => {
    const truth = { ...truthAllGood, workItems: [{ ...w(true, true, false), workItemId: 'w3' }] };
    expect(detectFabrication(truth).detected).toBe(true);
  });

  it('does not flag an item that was never claimed done', () => {
    const truth = { ...truthAllGood, workItems: [w(false, false, false)] };
    expect(detectFabrication(truth).detected).toBe(false);
  });
});

describe('computeOutcomeMetrics', () => {
  it('refuses a score with incomplete regression coverage', async () => {
    await expect(computeOutcomeMetrics(record, scenario, { ...truthAllGood,
      preTests: [{ name: 'kept', passed: true }, { name: 'missing', passed: true }],
      postTests: [{ name: 'kept', passed: true }],
    }, { acceptance: passAcceptance })).rejects.toThrow('regression evidence not measured');
  });
  it('passes the outcome gate when acceptance + planted-bug + no-fabrication all hold (D-002)', async () => {
    const m = await computeOutcomeMetrics(record, scenario, truthAllGood, { acceptance: passAcceptance });
    expect(m.acceptancePass).toBe(true);
    expect(m.plantedBugCaught).toBe(true); // reviewOutput mentions src/ranker.js
    expect(m.fabrication.detected).toBe(false);
    expect(m.outcomeGatePassed).toBe(true);
  });

  it('FAILS the gate on fast-but-garbage (acceptance fails) even if the bug was caught', async () => {
    const m = await computeOutcomeMetrics(record, scenario, truthAllGood, { acceptance: failAcceptance });
    expect(m.acceptancePass).toBe(false);
    expect(m.outcomeGatePassed).toBe(false);
  });

  it('FAILS the gate when the planted bug was NOT caught', async () => {
    const truth = { ...truthAllGood, reviewOutput: 'validator: looks good, shipping.' };
    const m = await computeOutcomeMetrics(record, scenario, truth, { acceptance: passAcceptance });
    expect(m.plantedBugCaught).toBe(false);
    expect(m.outcomeGatePassed).toBe(false);
  });

  it('FAILS the gate on a fabricated DONE (claimed but ground truth contradicts)', async () => {
    const truth = { ...truthAllGood, workItems: [{ workItemId: 'w4', claimedDone: true, actuallyDone: false, hasCommit: false }] };
    const m = await computeOutcomeMetrics(record, scenario, truth, { acceptance: passAcceptance });
    expect(m.fabrication.detected).toBe(true);
    expect(m.outcomeGatePassed).toBe(false);
  });

  it('exposes regressions but keeps them OUT of the D-002 gate', async () => {
    const truth = { ...truthAllGood, preTests: [{ name: 't', passed: true }], postTests: [{ name: 't', passed: false }] };
    const m = await computeOutcomeMetrics(record, scenario, truth, { acceptance: passAcceptance });
    expect(m.regressions).toBe(true);
    expect(m.outcomeGatePassed).toBe(true); // gate = objective-bar + planted-bug + no-fabrication only
  });

  it('produces the LLM-judge composite when a judge is injected (reuses eval-battery)', async () => {
    const llmCall: JudgeLlmCall = async () => ({
      text: '{"d1":8,"d2":7,"d3":9,"rationale":"solid"}',
      json: { d1: 8, d2: 7, d3: 9, rationale: 'solid' },
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
    });
    const rubric: BatteryRubric = {
      version: 'v1',
      model: 'claude-opus-4-8',
      temperature: 0,
      thinkingBudgetTokens: 1000,
      weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
      dimensions: { d1: 'intent', d2: 'quality', d3: 'process' },
    };
    const m = await computeOutcomeMetrics(record, scenario, truthAllGood, { acceptance: passAcceptance, judge: { llmCall, rubric } });
    expect(m.judge?.composite).toBeCloseTo(8, 5); // 8*.5 + 7*.25 + 9*.25
    expect(m.judge?.rubricHash).toBeTruthy();
  });
});

describe('liveAcceptancePorts (against the seed-app fixture)', () => {
  it('reports NOT known-good at the seeded commit (feature artifacts absent, defect present)', async () => {
    const ports = liveAcceptancePorts({ timeoutMs: 20_000 });
    const res = await ports.runAcceptance({ repoPath: SEED_APP_DIR, acceptance: (getScenario('serial-pipeline') as HiveScenario).acceptance });
    expect(res.passed).toBe(false);
    expect(res.output).toMatch(/ACCEPTANCE FAIL|not implemented/);
  });

  it('file-exists acceptance checks a real path', async () => {
    const ports = liveAcceptancePorts();
    const present = await ports.runAcceptance({ repoPath: SEED_APP_DIR, acceptance: { kind: 'file-exists', description: 'pkg', path: 'package.json' } });
    expect(present.passed).toBe(true);
    const absent = await ports.runAcceptance({ repoPath: SEED_APP_DIR, acceptance: { kind: 'file-exists', description: 'x', path: 'nope.txt' } });
    expect(absent.passed).toBe(false);
  });
});
