/**
 * Beekeeper runner unit tests with stubbed instance.
 * (P-003: vitest with a stubbed instance)
 */

import { describe, it, expect, vi } from 'vitest';
import { runBeekeeperBattery, type BeekeeperConfig, type BeekeeperDeps, type BeekeeperResult } from './beekeeper-runner';
import type { InstanceBootSpec } from './instance-manifest';
import type { CorpusCase } from './corpus';
import type { GymJudgeRubric } from '../gym/judge-scoring';
import type { GymScore } from '../gym/judge';
import type { IQBatteryMetrics, MetricCollectorInput } from './collectors';

const createMockStore = () => ({
  upsertInstance: vi.fn().mockResolvedValue(undefined),
  upsertCorpusCase: vi.fn().mockResolvedValue(undefined),
  startRun: vi.fn().mockResolvedValue(undefined),
  finishRun: vi.fn().mockResolvedValue(undefined),
  recordScore: vi.fn().mockResolvedValue(undefined),
});

const createMockInstanceManifest = (): InstanceBootSpec['manifest'] => ({
  instanceId: 'inst-test-001',
  workspaceId: 'ws-test',
  codeSha: 'abc123def456',
  createdAt: new Date(),
});

const createMockInstanceSpec = (): InstanceBootSpec => ({
  manifest: createMockInstanceManifest(),
  instanceUrl: 'http://localhost:3055',
});

const createMockRubric = (): GymJudgeRubric => ({
  version: 'v1-test',
  model: 'claude-opus-4-8',
  temperature: 0,
  thinkingBudgetTokens: 16_000,
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: {
    d1: 'Intent & spec fidelity',
    d2: 'Code quality',
    d3: 'Process correctness',
  },
});

const createMockCase = (id: string = 'case-001'): CorpusCase => ({
  id,
  variant: 'fix-injected-bug',
  title: 'Test bug fix case',
  prompt: 'Fix the off-by-one error in the ranking function.',
  groundTruth: {
    bugLocation: 'lib/rank.ts',
    expectedFix: 'Initialize with index, not index+1',
  },
  rubric: {
    dimensions: [
      {
        name: 'Bug Detection',
        description: 'Correctly identified the bug',
        weight: 0.5,
        scoring: 'binary',
      },
      {
        name: 'Fix Quality',
        description: 'The fix is correct',
        weight: 0.5,
        scoring: 'binary',
      },
    ],
  },
  rotationIndex: 0,
  createdAt: new Date(),
});

const createMockScore = (): GymScore => ({
  d1: 0.8,
  d2: 0.9,
  d3: 0.85,
  composite: 0.85,
  rationale: 'Well-structured fix with good explanation',
  judgeModel: 'claude-opus-4-8',
  rubricHash: 'mock-hash',
  judgeTemp: 0,
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  costUsd: 0.01,
  inputTokens: 1000,
  outputTokens: 200,
});

const createMockMetrics = (): IQBatteryMetrics => ({
  runId: 'run-001',
  caseId: 'case-001',
  variant: 'fix-injected-bug',
  success: true,
  tokensPerSolvedTask: 2500,
  timeToGreenSecs: 45,
  firstAttemptPass: true,
  recurrence: 1,
  escalation: false,
  recallHit: 1,
});

describe('BeekeeperRunner', () => {
  it('stops further instance runs and scores when a judge charge is unknown', async () => {
    const store = createMockStore();
    const instanceSpec = createMockInstanceSpec();
    const runInstance = vi.fn().mockResolvedValue({ instanceId: instanceSpec.manifest.instanceId, instanceUrl: instanceSpec.instanceUrl, costUsd: 0.1 });
    const deps: BeekeeperDeps = {
      store, runInstance,
      collectAndDistill: async () => ({ distilledTrace: 'trace', traceRef: 'ref', rawSignals: {} }),
      collectMetrics: async () => createMockMetrics(),
      llmCall: async () => { throw new Error('charge unavailable'); },
      newRunId: (id, repeat) => `${id}:${repeat}`, now: () => 0,
    };
    const result = await runBeekeeperBattery({ instanceSpec, corpus: [createMockCase('a'), createMockCase('b')], repeats: 1, rubric: createMockRubric(), maxDistillChars: 100 }, deps);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ judgeCostMeasured: false, status: 'errored' });
    expect(result.costMeasured).toBe(false);
    expect(runInstance).toHaveBeenCalledTimes(1);
    expect(store.recordScore).not.toHaveBeenCalled();
  });

  it('keeps measured failed-judge charges while excluding the failed case from quality', async () => {
    const store = createMockStore();
    const instanceSpec = createMockInstanceSpec();
    let calls = 0;
    const deps: BeekeeperDeps = {
      store,
      runInstance: vi.fn().mockResolvedValue({ instanceId: instanceSpec.manifest.instanceId, instanceUrl: instanceSpec.instanceUrl, costUsd: 0.1 }),
      collectAndDistill: async () => ({ distilledTrace: 'trace', traceRef: 'ref', rawSignals: {} }),
      collectMetrics: async () => createMockMetrics(),
      llmCall: async () => ({ text: ++calls <= 2 ? 'invalid judge output' : JSON.stringify({ d1: 8, d2: 8, d3: 8, rationale: 'ok' }), costUsd: calls <= 2 ? 0.02 : 0.03, inputTokens: 10, outputTokens: 5 }),
      newRunId: (id, repeat) => `${id}:${repeat}`, now: () => 0,
    };
    const result = await runBeekeeperBattery({ instanceSpec, corpus: [createMockCase('a'), createMockCase('b')], repeats: 1, rubric: createMockRubric(), maxDistillChars: 100 }, deps);
    expect(result.outcomes.map((o) => o.status)).toEqual(['errored', 'scored']);
    expect(result.outcomes.map((o) => o.judgeUsd)).toEqual([0.04, 0.03]);
    expect(result.passedCases).toBe(1);
    expect(store.recordScore).toHaveBeenCalledTimes(1);
  });

  describe('runBeekeeperBattery', () => {
    it('runs corpus cases against an instance and collects outcomes', async () => {
      const store = createMockStore();
      const instanceSpec = createMockInstanceSpec();
      const corpus = [createMockCase('case-001'), createMockCase('case-002')];
      const repeats = 1;

      const config: BeekeeperConfig = {
        instanceSpec,
        corpus,
        repeats,
        rubric: createMockRubric(),
        maxDistillChars: 5000,
      };

      const deps: BeekeeperDeps = {
        store,
        runInstance: vi.fn().mockResolvedValue({
          instanceId: instanceSpec.manifest.instanceId,
          instanceUrl: instanceSpec.instanceUrl,
          costUsd: 0.01,
        }),
        collectAndDistill: vi.fn().mockResolvedValue({
          distilledTrace: 'Fixed the off-by-one error.',
          traceRef: 'trace-001',
          rawSignals: { success: true },
        }),
        collectMetrics: vi.fn().mockResolvedValue(createMockMetrics()),
        llmCall: vi.fn().mockResolvedValue({
          text: JSON.stringify({ d1: 8.5, d2: 9.0, d3: 8.8, rationale: 'Good work' }),
          json: { d1: 8.5, d2: 9.0, d3: 8.8, rationale: 'Good work' },
          costUsd: 0.02,
          inputTokens: 1500,
          outputTokens: 500,
        }),
        newRunId: vi.fn().mockImplementation((caseId, repeat) => `run-${caseId}-${repeat}`),
        now: () => Date.now(),
      };

      const result: BeekeeperResult = await runBeekeeperBattery(config, deps);

      expect(result.instanceId).toBe(instanceSpec.manifest.instanceId);
      expect(result.outcomes).toHaveLength(2); // 2 cases × 1 repeat
      expect(result.totalCases).toBe(2);
      expect(result.passedCases).toBe(2);
      expect(result.meanComposite).toBeCloseTo(8.7, 1);

      expect(store.upsertInstance).toHaveBeenCalledWith(instanceSpec.manifest);
      expect(store.startRun).toHaveBeenCalledTimes(2);
      expect(store.finishRun).toHaveBeenCalledTimes(2);
      expect(store.recordScore).toHaveBeenCalledTimes(2);
    });

    it('continues on run failure and records error status', async () => {
      const store = createMockStore();
      const instanceSpec = createMockInstanceSpec();
      const corpus = [createMockCase('case-001'), createMockCase('case-002')];

      const config: BeekeeperConfig = {
        instanceSpec,
        corpus,
        repeats: 1,
        rubric: createMockRubric(),
        maxDistillChars: 5000,
      };

      let callCount = 0;
      const deps: BeekeeperDeps = {
        store,
        runInstance: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              instanceId: instanceSpec.manifest.instanceId,
              instanceUrl: instanceSpec.instanceUrl,
              costUsd: 0.01,
            };
          }
          throw new Error('Instance connection failed');
        }),
        collectAndDistill: vi.fn().mockResolvedValue({
          distilledTrace: 'Output',
          traceRef: 'trace-001',
          rawSignals: {},
        }),
        collectMetrics: vi.fn().mockResolvedValue(createMockMetrics()),
        llmCall: vi.fn().mockResolvedValue({
          text: JSON.stringify({ d1: 8.5, d2: 9.0, d3: 8.8, rationale: 'Good work' }),
          json: { d1: 8.5, d2: 9.0, d3: 8.8, rationale: 'Good work' },
          costUsd: 0.02,
          inputTokens: 1500,
          outputTokens: 500,
        }),
        newRunId: vi.fn().mockImplementation((caseId, repeat) => `run-${caseId}-${repeat}`),
        now: () => Date.now(),
      };

      const result = await runBeekeeperBattery(config, deps);

      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0].status).toBe('scored');
      expect(result.outcomes[1].status).toBe('errored');
      expect(result.outcomes[1].error).toContain('Instance connection failed');
      expect(result.passedCases).toBe(1);
    });

    it('handles rate-limit errors separately', async () => {
      const store = createMockStore();
      const instanceSpec = createMockInstanceSpec();
      const corpus = [createMockCase('case-001')];

      const config: BeekeeperConfig = {
        instanceSpec,
        corpus,
        repeats: 1,
        rubric: createMockRubric(),
        maxDistillChars: 5000,
      };

      const deps: BeekeeperDeps = {
        store,
        runInstance: vi.fn().mockResolvedValue({
          instanceId: instanceSpec.manifest.instanceId,
          instanceUrl: instanceSpec.instanceUrl,
          costUsd: 0.01,
        }),
        collectAndDistill: vi.fn().mockResolvedValue({
          distilledTrace: 'Output',
          traceRef: 'trace-001',
          rawSignals: {},
        }),
        collectMetrics: vi.fn().mockResolvedValue(createMockMetrics()),
        llmCall: vi.fn().mockRejectedValue(new Error('rate_limit exceeded')),
        newRunId: vi.fn().mockReturnValue('run-001'),
        now: () => Date.now(),
      };

      const result = await runBeekeeperBattery(config, deps);

      expect(result.outcomes[0].status).toBe('rate_limited');
      expect(result.outcomes[0].error).toContain('rate_limit');
    });

    it('respects repeats for noise calibration', async () => {
      const store = createMockStore();
      const instanceSpec = createMockInstanceSpec();
      const corpus = [createMockCase('case-001')];
      const repeats = 3;

      const config: BeekeeperConfig = {
        instanceSpec,
        corpus,
        repeats,
        rubric: createMockRubric(),
        maxDistillChars: 5000,
      };

      const deps: BeekeeperDeps = {
        store,
        runInstance: vi.fn().mockResolvedValue({
          instanceId: instanceSpec.manifest.instanceId,
          instanceUrl: instanceSpec.instanceUrl,
          costUsd: 0.01,
        }),
        collectAndDistill: vi.fn().mockResolvedValue({
          distilledTrace: 'Output',
          traceRef: 'trace-001',
          rawSignals: {},
        }),
        collectMetrics: vi.fn().mockResolvedValue(createMockMetrics()),
        llmCall: vi.fn().mockResolvedValue({
          text: JSON.stringify({ d1: 8.5, d2: 9.0, d3: 8.8, rationale: 'Good work' }),
          json: { d1: 8.5, d2: 9.0, d3: 8.8, rationale: 'Good work' },
          costUsd: 0.02,
          inputTokens: 1500,
          outputTokens: 500,
        }),
        newRunId: vi.fn().mockImplementation((caseId, repeat) => `run-${caseId}-${repeat}`),
        now: () => Date.now(),
      };

      const result = await runBeekeeperBattery(config, deps);

      expect(result.outcomes).toHaveLength(3); // 1 case × 3 repeats
      expect(store.startRun).toHaveBeenCalledTimes(3);
      expect(result.totalCases).toBe(3);
    });

    it('reports meanComposite 0 (not NaN) when zero runs scored', async () => {
      const store = createMockStore();
      const instanceSpec = createMockInstanceSpec();

      const config: BeekeeperConfig = {
        instanceSpec,
        corpus: [createMockCase('case-001'), createMockCase('case-002')],
        repeats: 1,
        rubric: createMockRubric(),
        maxDistillChars: 5000,
      };

      const deps: BeekeeperDeps = {
        store,
        runInstance: vi.fn().mockRejectedValue(new Error('Instance connection failed')),
        collectAndDistill: vi.fn().mockResolvedValue({
          distilledTrace: 'Output',
          traceRef: 'trace-001',
          rawSignals: {},
        }),
        collectMetrics: vi.fn().mockResolvedValue(createMockMetrics()),
        llmCall: vi.fn().mockResolvedValue({
          text: JSON.stringify({ d1: 8.5, d2: 9.0, d3: 8.8, rationale: 'Good work' }),
          json: { d1: 8.5, d2: 9.0, d3: 8.8, rationale: 'Good work' },
          costUsd: 0.02,
          inputTokens: 1500,
          outputTokens: 500,
        }),
        newRunId: vi.fn().mockImplementation((caseId, repeat) => `run-${caseId}-${repeat}`),
        now: () => Date.now(),
      };

      const result = await runBeekeeperBattery(config, deps);

      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes.every((o) => o.status === 'errored')).toBe(true);
      expect(result.passedCases).toBe(0);
      expect(Number.isNaN(result.meanComposite)).toBe(false);
      expect(result.meanComposite).toBe(0);
    });
  });
});
