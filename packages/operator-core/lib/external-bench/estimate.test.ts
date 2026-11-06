/**
 * Unit tests for estimateBenchLaunch — the pre-launch cost/wall estimate the
 * benchmark launch form shows. Pure logic over knownTaskSets(); that loader does
 * fs IO (readJsonl) so it is mocked here, making the test deterministic + IO-free
 * and isolating estimate's own branches (cap clamp, set lookup/fallback, rounding,
 * wave math).
 *
 * Run: cd packages/operator-core && npx vitest run lib/external-bench/estimate.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./task-sets', () => ({
  knownTaskSets: () => [
    { id: '11-task-pilot', label: 'Pilot', count: 11 },
    { id: 'stratified-30', label: 'Stratified 30', count: 30 },
    { id: 'no-count', label: 'Not provisioned', count: null },
  ],
}));

import { estimateBenchLaunch, estimateCurrentBenchLaunch } from './estimate';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { currentBenchCodexSubscriptionContract, currentBenchOpenAiInputContract } from './current-su';

const PER_TASK_USD = 3.5;
const PER_TASK_WALL_MIN = 18;

describe('estimateBenchLaunch', () => {
  it('uses the known task-set count for cost + wave math', () => {
    const e = estimateBenchLaunch({ taskSetId: 'stratified-30', cap: 5 });
    expect(e.taskSetId).toBe('stratified-30');
    expect(e.taskCount).toBe(30);
    expect(e.cap).toBe(5);
    expect(e.perTaskUsd).toBe(PER_TASK_USD);
    expect(e.estCostUsd).toBe(Math.round(30 * PER_TASK_USD * 100) / 100); // 105
    // waves = ceil(30/5) = 6 → 6 * 18
    expect(e.estWallMin).toBe(6 * PER_TASK_WALL_MIN);
    expect(e.basis).toContain('m3 real-Queen');
  });

  it('defaults taskSetId to 11-task-pilot and cap to 5 when omitted', () => {
    const e = estimateBenchLaunch({});
    expect(e.taskSetId).toBe('11-task-pilot');
    expect(e.taskCount).toBe(11);
    expect(e.cap).toBe(5);
    expect(e.estCostUsd).toBe(38.5); // 11 * 3.5
    expect(e.estWallMin).toBe(Math.ceil(11 / 5) * PER_TASK_WALL_MIN); // 3 * 18 = 54
  });

  it('falls back to 731 for the not-yet-provisioned swe-bench-pro-full set', () => {
    const e = estimateBenchLaunch({ taskSetId: 'swe-bench-pro-full' });
    expect(e.taskCount).toBe(731);
  });

  it('falls back to 11 for an unknown task-set id', () => {
    expect(estimateBenchLaunch({ taskSetId: 'does-not-exist' }).taskCount).toBe(11);
  });

  it('falls back to 11 when a known set carries a null count', () => {
    // set is found, but set.count === null → ?? triggers → non-full id → 11
    expect(estimateBenchLaunch({ taskSetId: 'no-count' }).taskCount).toBe(11);
  });

  it('clamps the cap: 0/NaN → 5 (default), negative → floor of 1', () => {
    expect(estimateBenchLaunch({ cap: 0 }).cap).toBe(5); // 0 || 5 → 5
    expect(estimateBenchLaunch({ cap: Number.NaN }).cap).toBe(5); // NaN || 5 → 5
    expect(estimateBenchLaunch({ cap: -3 }).cap).toBe(1); // (-3 || 5) = -3 → max(1, -3) = 1
  });

  it('rounds the cost to whole cents', () => {
    const e = estimateBenchLaunch({ taskSetId: '11-task-pilot' });
    expect(Number.isInteger(Math.round(e.estCostUsd * 100))).toBe(true);
    expect(e.estCostUsd).toBe(38.5);
  });

  it('cap of 1 yields one wave per task', () => {
    const e = estimateBenchLaunch({ taskSetId: 'stratified-30', cap: 1 });
    expect(e.estWallMin).toBe(30 * PER_TASK_WALL_MIN);
  });
});

describe('committed current protocol launch preflight', () => {
  const setup = () => {
    const config = currentProtocolFixture('current-study');
    const suites: string[] = ['swe-bench-pro'];
    config.priceSchedule.rates[0].inputTokenCeiling = 1000;
    config.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = currentBenchOpenAiInputContract('configured-alias', 1000);
    const ports = {
      readPrereg: vi.fn(async () => ({ preregHash: 'a'.repeat(64), config, suites })),
      verify: vi.fn(async () => ({ preregHash: 'a'.repeat(64) })),
      readAccounts: vi.fn(async () => ({ accounts: [{ id: 'api', provider: 'codex', credentialRef: 'token:/private/key' }] })),
      supportsBearer: vi.fn(async () => true),
      readRuntimes: vi.fn(async () => [{ pid: 123, treeSha: config.arms[0].runtime.sourceRevision, unit: 'staging-api' }]),
      measure: vi.fn(() => config.arms[0].runtime.runtimeRevision), runtimeWorkspaceId: 'host-workspace', pid: 123,
      enabled: vi.fn(async () => true),
    };
    const run = (changed = {}) => estimateCurrentBenchLaunch({ workspaceId: 'benchmarks', protocolRunId: config.runId,
      arm: 'papercusp', seed: 1, ...changed }, {}, ports as never);
    return { run, ports, config, suites };
  };
  it.each(['swe-bench-pro', 'frontier-swe', 'hive-backlog', 'minecraft'])(
    'preserves the registered %s suite through launch preflight', async suite => {
      const s = setup();
      s.suites.splice(0, s.suites.length, suite);
      expect(await s.run()).toMatchObject({ ready: true, suite });
    });
  it.each([{ suites: [] }, { suites: [''] }, { suites: ['swe-bench-pro', 'frontier-swe'] }])(
    'refuses a missing or ambiguous registered suite $suites', async ({ suites }) => {
      const s = setup();
      s.suites.splice(0, s.suites.length, ...suites);
      expect(await s.run()).toMatchObject({ ready: false, error: expect.stringContaining('single registered suite') });
      expect(s.ports.readAccounts).not.toHaveBeenCalled();
    });
  it('derives controls and boot observation from verified frozen data without inference', async () => {
    const { run, ports } = setup();
    expect(await run()).toMatchObject({ ready: true, arm: 'papercusp', model: 'configured-alias', perTaskUsd: 3,
      aggregateBudgetUsd: 60, current: { workspaceId: 'benchmarks', protocolRunId: 'current-study', seed: 1,
        observation: { runtimeWorkspaceId: 'host-workspace', workerUnit: 'staging-api', gatewayUnit: 'staging-api' } } });
    expect(ports.readAccounts).toHaveBeenCalledWith('benchmarks');
    expect(ports.verify).toHaveBeenCalledWith('current-study', expect.any(Object), { workspaceId: 'benchmarks' });
  });
  it('refuses uncommitted protocols, missing API accounts and loaded runtime drift', async () => {
    const a = setup(); a.ports.verify.mockRejectedValue(new Error('uncommitted'));
    expect(await a.run()).toEqual({ ready: false, error: 'uncommitted' });
    expect(a.ports.readAccounts).not.toHaveBeenCalled();
    const b = setup(); b.ports.supportsBearer.mockResolvedValue(false);
    expect(await b.run()).toMatchObject({ ready: false, error: expect.stringContaining('API bearer') });
    const c = setup(); c.ports.measure.mockReturnValue('different-runtime');
    expect(await c.run()).toMatchObject({ ready: false, error: expect.stringContaining('loaded execution host') });
    const d = setup(); d.ports.enabled.mockResolvedValue(false);
    expect(await d.run()).toMatchObject({ ready: false, error: expect.stringContaining('execution is disabled') });
    expect(d.ports.readAccounts).not.toHaveBeenCalled();
    const e = setup(); e.config.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = 'f'.repeat(64);
    expect(await e.run()).toMatchObject({ ready: false, error: expect.stringContaining('input-count contract') });
  });
  // benchmark-coverage-frontierswe-v2-2026-10-10#D-023: a subscription arm needs its own
  // frozen contract and a codex-cli account, and its caps are list prices, not spend.
  const subscription = () => {
    const s = setup();
    for (const arm of s.config.arms) arm.payer = 'subscription';
    s.config.priceSchedule.rates[0].outputTokenCeiling = 128;
    s.config.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = currentBenchCodexSubscriptionContract('configured-alias', 1000, 128);
    s.ports.readAccounts.mockResolvedValue({ accounts: [{ id: 'sub', provider: 'codex', credentialRef: 'codex-cli:/private/home' }] });
    const supportsSubscription = vi.fn(async (ref: string) => ref.startsWith('codex-cli:'));
    Object.assign(s.ports, { supportsSubscription });
    return { ...s, supportsSubscription };
  };
  it('labels an API-key arm metered and a subscription arm list-price-equivalent', async () => {
    expect(await setup().run()).toMatchObject({ ready: true, payer: 'api-key', costBasis: 'metered' });
    const s = subscription();
    expect(await s.run()).toMatchObject({ ready: true, payer: 'subscription', costBasis: 'list-price-equivalent',
      basis: expect.stringContaining('not money spent') });
    expect(s.supportsSubscription).toHaveBeenCalledWith('codex-cli:/private/home');
    expect(s.ports.supportsBearer).not.toHaveBeenCalled();
  });
  it.each(['no-port', 'api-account', 'api-contract', 'missing-output-ceiling'] as const)(
    'refuses a subscription arm with %s', async defect => {
      const s = subscription();
      if (defect === 'no-port') delete (s.ports as { supportsSubscription?: unknown }).supportsSubscription;
      if (defect === 'api-account') s.ports.readAccounts.mockResolvedValue({ accounts: [{ id: 'api', provider: 'codex', credentialRef: 'token:/private/key' }] });
      if (defect === 'api-contract') s.config.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = currentBenchOpenAiInputContract('configured-alias', 1000);
      if (defect === 'missing-output-ceiling') delete s.config.priceSchedule.rates[0].outputTokenCeiling;
      // The frozen-protocol schema refuses a missing output ceiling before the contract check.
      expect(await s.run()).toMatchObject({ ready: false, error: expect.stringContaining(
        defect === 'missing-output-ceiling' ? 'frozen provider input and output ceilings'
          : defect === 'api-contract' ? 'subscription provider-limit contract' : 'Codex subscription account') });
    });
  it('rejects retired arms, unregistered seeds and production scope before launch', async () => {
    const { run } = setup();
    expect((await run({ arm: 'hive-realqueen' })).ready).toBe(false);
    expect((await run({ seed: 2 })).ready).toBe(false);
    expect((await run({ workspaceId: 'papercusp-workspace' })).ready).toBe(false);
  });
});
