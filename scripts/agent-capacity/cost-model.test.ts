import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { costFromTokens, PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import { encodeChunk, type RecordedExchange } from './record-proxy';
import { capacityRow, parseRampLog } from './capacity-table';
import {
  buildRows,
  allocatePoolBill,
  CAPACITY,
  capacity,
  dedicatedHosts,
  evaluate,
  hostMonthUsd,
  onDemandMonthUsd,
  recordedInferenceCost,
  trialTaskMonth,
  pricingComparison,
  renderMarkdown,
  SCENARIOS,
  serverMonthUsd,
  serverRamGiB,
  TARGET,
  tenantsPerHost,
  type PoolBillLine,
  type CostReportMonth,
  type TrialTaskMonthInput,
} from './cost-model';

describe('P544 recorded inference cost', () => {
  const exchange = (events: unknown[], protocol = 'responses'): RecordedExchange => ({
    seq: 1, sessionId: 'fixture', startedAt: '2026-10-17T00:00:00Z', method: 'POST',
    path: `/v1/${protocol}`, req: { bytes: 1, sha256: 'fixture', model: 'requested-only', stream: true, messages: 1, tools: 0 },
    status: 200, contentType: 'text/event-stream', ttfbMs: 1, totalMs: 5, resBytes: 1,
    chunks: [encodeChunk(5, Buffer.from(events.map((j) => `data: ${JSON.stringify(j)}\r\n\r\n`).join('')))],
  });
  const completed = (input = 100, model = 'gpt-6.1-sol') => ({ type: 'response.completed', response: {
    id: 'response', status: 'completed', model, usage: { input_tokens: input,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, output_tokens: 5 },
  } });

  it('prices each request at its own context tier and subtracts cache subsets exactly once', () => {
    const small = completed(), large = completed(300_000);
    const result = recordedInferenceCost([exchange([small, small]), { ...exchange([large]), seq: 2 }]);
    const expected = [100, 300_000].reduce((sum, total) => sum + costFromTokens('gpt-6.1-sol', {
      requestInputTokens: total, inputTokens: total - 30, cacheReadTokens: 20,
      cacheCreationTokens: 10, outputTokens: 5,
    }).usd, 0);
    expect(result.estimatedInferenceUsd).toBeCloseTo(expected, 12);
    expect(result).toMatchObject({ requests: 2, pricedRequests: 2,
      priceTableVersion: PRICE_TABLE_VERSION, costSource: 'estimated', billedInferenceUsd: null, estimateIsLowerBound: false });
    expect(result.rows[0]!.servedModel).toBe('gpt-6.1-sol');
  });

  it('merges cumulative Anthropic usage and prices the reported 1h cache writes', () => {
    const ex = exchange([
      { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1,
        output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10 } } } },
      { type: 'message_delta', usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 20 } },
      { type: 'message_stop' },
    ], 'messages');
    // Split UTF-8/chunks, including base64, follows the recorder/replayer byte contract.
    const bytes = Buffer.concat(ex.chunks.map((c) => Buffer.from(c.d!)));
    ex.chunks = [{ t: 1, b64: bytes.subarray(0, 27).toString('base64') }, encodeChunk(5, bytes.subarray(27))];
    const result = recordedInferenceCost([ex]);
    expect(result.rows[0]!.usage).toMatchObject({ inputTokens: 4, outputTokens: 5,
      requestInputTokens: 34, cacheReadTokens: 20, cacheCreation1hTokens: 10 });
    expect(result.estimatedInferenceUsd).toBeCloseTo((4 * 2 + 20 * 0.2 + 10 * 4 + 5 * 10) / 1e6, 12);
  });

  it.each(['missing-write', 'invalid-cache', 'unknown-model', 'missing-model', 'failed', 'truncated', 'conflict'])(
    'keeps %s requests in the denominator and refuses a complete estimate', (kind) => {
      const ev = completed();
      const ex = exchange([ev]);
      if (kind === 'missing-write') delete (ev.response.usage.input_tokens_details as Record<string, unknown>).cache_write_tokens;
      if (kind === 'invalid-cache') ev.response.usage.input_tokens_details.cached_tokens = 101;
      if (kind === 'unknown-model') ev.response.model = 'unpriced-future-model';
      if (kind === 'missing-model') ev.response.model = '';
      if (kind === 'failed') ex.status = 500;
      const events = kind === 'truncated' ? [] : kind === 'conflict' ? [ev, completed(200)] : [ev];
      ex.chunks = exchange(events).chunks;
      const result = recordedInferenceCost([exchange([completed()]), { ...ex, seq: 2 }]);
      expect(result.requests).toBe(2);
      expect(result.estimatedInferenceUsd).toBeNull();
      expect(result.estimateIsLowerBound).toBe(true);
      expect(result.billedInferenceUsd).toBeNull();
    });

  it('excludes non-model endpoints, preserves empty unknown and emits no response content', () => {
    const ex = exchange([completed(), { type: 'response.output_text.delta', delta: 'PRIVATE RESPONSE' }]);
    const result = recordedInferenceCost([ex, { ...ex, path: '/v1/messages/count_tokens' }]);
    expect(result.requests).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE RESPONSE');
    expect(recordedInferenceCost([]).estimatedInferenceUsd).toBeNull();
  });

  it('marks unreported Anthropic write TTLs as a price floor without guessing an exact estimate', () => {
    const result = recordedInferenceCost([exchange([
      { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1,
        output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 } } },
      { type: 'message_stop' },
    ], 'messages')]);
    expect(result.estimatedInferenceUsd).toBeNull();
    expect(result.knownEstimatedInferenceUsd).toBeGreaterThan(0);
    expect(result.rows[0]!.gaps).toContain('price-lower-bound');
  });

  it('prices nonstream responses and retains invalid JSON as unknown', () => {
    const ex = exchange([]);
    ex.req = { ...ex.req, stream: false };
    ex.chunks = [encodeChunk(1, Buffer.from(JSON.stringify(completed().response)))];
    expect(recordedInferenceCost([ex]).estimatedInferenceUsd).toBeGreaterThan(0);
    ex.chunks = [encodeChunk(1, Buffer.from('{'))];
    expect(recordedInferenceCost([ex]).rows[0]!.gaps).toContain('invalid-json');
  });
});

describe('P544 monthly coding-task workload', () => {
  const workload = (): TrialTaskMonthInput => ({ assignedAgents: 50, activeVmHours: 60, strata: [
    { id: 'light', profile: 'light', cli: 'codex', model: 'fixture-model', effort: 'low',
      monthlyTasks: 48, observedTasks: 8, completedTasks: 8, taskWallSeconds: 800,
      estimatedInferenceUsd: 2, billedInferenceUsd: null, sourceRef: 'fixture:light' },
    { id: 'typical', profile: 'typical', cli: 'claude', model: 'fixture-model', effort: null,
      monthlyTasks: 48, observedTasks: 8, completedTasks: 8, taskWallSeconds: 1600,
      estimatedInferenceUsd: 4, billedInferenceUsd: null, sourceRef: 'fixture:typical' },
    { id: 'heavy', profile: 'heavy', cli: 'claude', model: 'fixture-model', effort: null,
      monthlyTasks: 24, observedTasks: 4, completedTasks: 3, taskWallSeconds: 3600,
      estimatedInferenceUsd: null, billedInferenceUsd: null, sourceRef: 'fixture:heavy' },
  ] });

  it('scales workspace tasks without multiplying by assigned slots or substituting VM hours', () => {
    const result = trialTaskMonth(workload());
    expect(result.monthlyTasks).toBe(120);
    expect(result.taskCounts).toEqual({ light: 48, typical: 48, heavy: 24 });
    expect(result.busyAgentHours).toBe(10);
    expect(result.busyHoursLowerBound).toBe(true);
    expect(result.censoredStrata).toEqual(['heavy']);
    expect(result.unknownBindings).toEqual(['typical', 'heavy']);
    expect(result.modeledInferenceEstimateUsd).toBeNull();
    expect(result.modeledInferenceBilledBasisUsd).toBeNull();
  });

  it('keeps modeled inference and censored task time out of observed monthly charge inputs', () => {
    const input = workload();
    input.strata = input.strata.map((s) => ({ ...s, estimatedInferenceUsd: 1, billedInferenceUsd: 0.5 }));
    const [result] = pricingComparison(buildRows(50, null), { taskWorkload: input, sourceRef: 'fixture:scenario' });
    expect(result!.busyAgentHours).toBe(10);
    expect(result!.busyHoursModeled).toBe(true);
    expect(result!.taskWorkload?.modeledInferenceEstimateUsd).toBe(18);
    expect(result!.taskWorkload?.modeledInferenceBilledBasisUsd).toBe(9);
    expect(result!.inferenceUsd).toBeNull();
    expect(result!.busyHoursTotalUsd).toBeNull();
    const md = renderMarkdown(buildRows(50, null), { taskWorkload: input, sourceRef: 'fixture:scenario' });
    expect(md).toContain('120 coding tasks (48 light, 48 typical, 24 heavy)');
    expect(md).toContain('lower bound: censored tasks retained');
    expect(md).toContain('do not populate observed monthly inference');
  });

  it('ignores zero-weight unknown samples while retaining explicit zero activity', () => {
    const input = workload();
    input.activeVmHours = 0;
    input.strata = input.strata.map((s) => ({ ...s, monthlyTasks: 0 }));
    expect(trialTaskMonth(input)).toMatchObject({ monthlyTasks: 0, busyAgentHours: 0,
      modeledInferenceEstimateUsd: 0, modeledInferenceBilledBasisUsd: 0, censoredStrata: [], unknownBindings: [] });
  });

  it('refuses mismatched populations, conflicting activity inputs and missing evidence', () => {
    expect(() => pricingComparison(buildRows(1, null), { taskWorkload: workload(), sourceRef: 'fixture:s' })).toThrow(/population mismatch/);
    expect(() => pricingComparison(buildRows(50, null), { taskWorkload: workload(), busyAgentHours: 1, sourceRef: 'fixture:s' })).toThrow(/not both/);
    expect(() => pricingComparison(buildRows(50, null), { taskWorkload: workload() })).toThrow(/sourceRef/);
  });

  it.each(['monthlyTasks', 'observedTasks', 'completedTasks', 'taskWallSeconds',
    'estimatedInferenceUsd', 'billedInferenceUsd'] as const)('rejects invalid %s instead of producing a cheaper estimate', (key) => {
    const input = workload();
    Object.assign(input.strata[0]!, { [key]: -1 });
    expect(() => trialTaskMonth(input)).toThrow();
  });

  it('rejects missing samples, impossible time, duplicate identities and absent monetary values', () => {
    for (const patch of [{ observedTasks: 0 }, { completedTasks: 9 }, { sourceRef: '' },
      { taskWallSeconds: Infinity }, { estimatedInferenceUsd: undefined }, { profile: 'dummy-tool' }]) {
      const input = workload();
      Object.assign(input.strata[0]!, patch);
      expect(() => trialTaskMonth(input)).toThrow();
    }
    const input = workload();
    input.strata = [...input.strata, input.strata[0]!];
    expect(() => trialTaskMonth(input)).toThrow(/duplicate/);
    expect(() => trialTaskMonth({ ...workload(), activeVmHours: 0.01 })).toThrow(/population hours/);
    expect(() => trialTaskMonth({ ...workload(), assignedAgents: 0 })).toThrow(/assignedAgents/);
  });
});

const perActiveSpot = (id: string) => hostMonthUsd(capacity(id).machineType, true) / capacity(id).active;
const row = (id: string, agents = 50, saved: number | null = null) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return evaluate(s, agents, saved);
};

describe('cost-model inputs', () => {
  // Original GCP output, retained with the full source-file hashes. Do not compare the model
  // only with old decision prose: D-020 corrected D-019's slot-based pricing, but the model
  // and its old regression both retained 64 instead of the 60.1 sessions actually held.
  const { measurements } = JSON.parse(readFileSync(new URL('./fixtures/capacity-ramps.json', import.meta.url), 'utf8')) as {
    measurements: Array<{
      capacityId: string;
      source: string;
      sourceSha256: string;
      label?: string;
      verdictLines?: string[];
      summary?: { failed: number; achievedConcurrency: { target: number; mean: number } };
    }>;
  };

  it('retains original measurement evidence for every model capacity input', () => {
    expect(measurements.map((m) => m.capacityId).sort()).toEqual(CAPACITY.map((c) => c.id).sort());
    for (const m of measurements) {
      expect(m.source).not.toBe('');
      expect(m.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it.each(measurements)('$capacityId uses achieved concurrency and censoring from the original run', (m) => {
    const c = capacity(m.capacityId);
    if (m.verdictLines && m.label) {
      const measured = capacityRow(c.machineType, m.label, parseRampLog(m.verdictLines.join('\n')), { capture: null, sessions: [] }, 120);
      expect(measured.activeAgents).not.toBeNull();
      expect(c.active).toBe(measured.activeAgents);
      expect(c.atLeast ?? false).toBe(measured.censored);
    } else {
      expect(m.summary).toBeDefined();
      expect(m.summary?.failed).toBe(0);
      expect(c.active).toBe(Math.min(m.summary!.achievedConcurrency.target, m.summary!.achievedConcurrency.mean));
      expect(c.atLeast).toBe(true); // D-040's last tested step; no saturation run followed it.
    }
  });

  it('every capacity row cites a plan Decision', () => {
    for (const c of CAPACITY) expect(c.source, c.id).toMatch(/\bD-\d{3}\b/);
  });

  // Reproduce the achieved-concurrency figures, including D-020's correction to D-019.
  it.each([
    ['mixed-e2s16', 4.11, 'D-020'],
    ['mixed-e2c16', 2.81, 'D-020'],
    ['heavy-e2s16', 10.33, 'D-023'],
    ['heavy-e2s16-adm', 7.76, 'D-023'],
  ])('reproduces %s spot USD per active agent-month (%s, %s)', (id, expected) => {
    expect(perActiveSpot(id)).toBeCloseTo(expected, 0);
    expect(Math.abs(perActiveSpot(id) - expected) / expected).toBeLessThan(0.02);
  });

  it('prices an idle Server inside the D-022 6-9 USD range at spot resource rates', () => {
    const { floor } = serverMonthUsd();
    expect(floor).toBeGreaterThanOrEqual(6);
    expect(floor).toBeLessThanOrEqual(9);
  });

  it('packs ~14 Servers on a 64 GiB host with a 10 GiB reserve (D-045)', () => {
    expect(tenantsPerHost()).toBe(14);
  });
});

describe('cost-model levers', () => {
  it('a freed GiB per Server raises the packing and lowers both Server prices', () => {
    expect(tenantsPerHost(1)).toBeGreaterThan(tenantsPerHost(0));
    const before = serverMonthUsd(0);
    const after = serverMonthUsd(1);
    expect(after.floor).toBeLessThan(before.floor);
    expect(after.packed).toBeLessThan(before.packed);
  });

  it('refuses a saving that is negative or at least the whole Server', () => {
    expect(() => serverRamGiB(-0.1)).toThrow(/out of range/);
    expect(() => serverRamGiB(3.6)).toThrow(/out of range/);
  });

  it('marks the P-532 rows PENDING until the saving is measured, then prices them', () => {
    expect(row('M5').pending).toBe(true);
    const measured = row('M5', 50, 1);
    expect(measured.pending).toBe(false);
    expect(measured.totalUsd.packed).toBeLessThan(row('M4').totalUsd.packed);
  });

  it('a dedicated VM must hold its own p99 busy agents plus the Server slot', () => {
    // 50 agents x 0.35 x 1.3 = 22.75 busy at p99, inside one e2-standard-8 (31.6 - 1 active).
    expect(dedicatedHosts(50, capacity('mixed-e2s8'))).toBe(1);
    expect(dedicatedHosts(1, capacity('mixed-e2s4'))).toBe(1);
    // 100 agents need 45.5 at p99: two e2-standard-8.
    expect(dedicatedHosts(100, capacity('mixed-e2s8'))).toBe(2);
    // 135 agents: 61.425 busy at p99 over 30.6 usable active capacity = 3 hosts. Sizing on the
    // mean (47.25 busy) or forgetting the Server slot (61.425 / 31.6) would both give 2.
    expect(dedicatedHosts(135, capacity('mixed-e2s8'))).toBe(3);
  });

  it('each lever row costs no more than the row it builds on', () => {
    const rows = buildRows(TARGET.agents, 1);
    for (const ladder of [
      ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'],
      ['H0', 'H1', 'H2', 'H3'],
    ]) {
      for (let i = 1; i < ladder.length; i++) {
        const prev = rows.find((r) => r.id === ladder[i - 1])!;
        const cur = rows.find((r) => r.id === ladder[i])!;
        expect(cur.totalUsd.packed, `${cur.id} vs ${prev.id}`).toBeLessThanOrEqual(prev.totalUsd.packed);
      }
    }
  });

  it('grades a row on its packed total against the target scaled to the agent count', () => {
    for (const r of buildRows(TARGET.agents, null)) {
      expect(r.meetsTarget, r.id).toBe(r.totalUsd.packed <= TARGET.googleUsdMonthMax);
    }
  });

  it('a 1-agent workspace in a shared pool costs mostly its Server', () => {
    const r = row('M3', 1);
    expect(r.serverUsd.packed).toBeGreaterThan(5 * r.computeUsd);
    expect(row('M1', 1).totalUsd.packed).toBeGreaterThan(5 * r.totalUsd.packed);
  });
});

describe('cost-model rendering', () => {
  it('shows a lower-bound capacity as an upper-bound cost and an unmeasured lever as PENDING', () => {
    const md = renderMarkdown(buildRows(TARGET.agents, null));
    expect(md).toMatch(/\| H2 \|[^\n]*\| <=\d/);
    expect(md).toMatch(/\| M5 \|[^\n]*PENDING P-532 \|$/m);
    expect(md).not.toMatch(/\| M4 \|[^\n]*PENDING/);
  });

  const knownMonth: CostReportMonth = { retainedStorageUsd: 2, provisionedPerformanceUsd: 0,
    backupUsd: 0.5, objectStorageUsd: 0.1, networkUsd: 0.2, controlUsd: 0.4,
    warmCapacityUsd: 0.8, inferenceUsd: 3, sourceRef: 'synthetic:month-evidence' };

  it.each([1, 50])('compares both alternatives for %s assigned agents at the same modeled activity', (agents) => {
    const original = row('M3', agents);
    const [result] = pricingComparison([original], knownMonth);
    expect(result!.basePlusAgentCoreUsd).toBeCloseTo(original.totalUsd.packed);
    expect(result!.busyHoursCoreUsd).toBeCloseTo(result!.basePlusAgentCoreUsd);
    expect(result!.basePlusAgentTotalUsd).toBeCloseTo(original.totalUsd.packed + 7);
    expect(result!.busyHoursTotalUsd).toBeCloseTo(result!.basePlusAgentTotalUsd!);
    expect(result!.inferenceUsd).toBe(3);
    expect(result!.busyAgentHours).toBeCloseTo(agents * 730 * 0.35);
    expect(result!.sources).toEqual(original.sources);
    expect(result!.inputSourceRef).toBe('synthetic:month-evidence');
  });

  it('keeps base and retained costs when actual busy time is zero without making assigned agents free', () => {
    const [result] = pricingComparison([row('M3')], { ...knownMonth, busyAgentHours: 0 });
    expect(result!.busyHoursCoreUsd).toBe(result!.baseServerUsd);
    expect(result!.busyHoursTotalUsd).toBeCloseTo(result!.baseServerUsd + 7);
    expect(result!.basePlusAgentCoreUsd).toBeGreaterThan(result!.busyHoursCoreUsd);
    expect(result!.busyHoursModeled).toBe(false);
  });

  it('preserves every omitted/null cost as unknown instead of silently pricing it at zero', () => {
    for (const key of Object.keys(knownMonth).filter((key) => key !== 'sourceRef') as (keyof CostReportMonth)[]) {
      for (const absent of [undefined, null]) {
        const [result] = pricingComparison([row('M3')], { ...knownMonth, [key]: absent });
        expect(result!.missingCosts).toEqual([key]);
        expect(result!.basePlusAgentTotalUsd).toBeNull();
        expect(result!.busyHoursTotalUsd).toBeNull();
      }
    }
    const md = renderMarkdown(buildRows(50, null));
    expect(md).toContain('base + agent all-in');
    expect(md).toContain('busy-hours all-in');
    expect(md).toContain('inference');
    expect(md).toContain('UNKNOWN');
    expect(md).toContain('retainedStorageUsd');
    expect(md).toContain('not observed usage');
  });

  it('accepts sourced zero costs and keeps inference separate when it crosses $20', () => {
    const original = row('M3', 1);
    const zeroMonth = Object.fromEntries(Object.keys(knownMonth).map((key) =>
      [key, key === 'sourceRef' ? 'synthetic:explicit-zero-evidence' : 0])) as CostReportMonth;
    const [zero] = pricingComparison([original], zeroMonth);
    expect(zero!.missingCosts).toEqual([]);
    expect(zero!.basePlusAgentTotalUsd).toBeCloseTo(original.totalUsd.packed);
    const [inference] = pricingComparison([original], { ...zeroMonth, inferenceUsd: 20 });
    expect(inference!.basePlusAgentTotalUsd).toBeGreaterThan(20);
    expect(inference!.inferenceUsd).toBe(20);
    expect(inference!.basePlusAgentCoreUsd).toBe(zero!.basePlusAgentCoreUsd);
  });

  it('rejects invalid usage, cost, missing evidence and overflow without turning them into unknowns', () => {
    for (const bad of [-1, NaN, Infinity]) {
      expect(() => pricingComparison([row('M3')], { ...knownMonth, inferenceUsd: bad })).toThrow(/invalid/);
      expect(() => pricingComparison([row('M3')], { ...knownMonth, busyAgentHours: bad })).toThrow(/invalid/);
    }
    expect(() => pricingComparison([row('M3', 1)], { ...knownMonth, busyAgentHours: 731 })).toThrow(/population/);
    expect(() => pricingComparison([row('M3')], { inferenceUsd: 0 })).toThrow(/sourceRef/);
    expect(() => pricingComparison([row('M3')], { ...knownMonth, sourceRef: ' ' })).toThrow(/sourceRef/);
    expect(() => pricingComparison([row('M3')], { ...knownMonth,
      inferenceUsd: Number.MAX_VALUE, backupUsd: Number.MAX_VALUE })).toThrow(/overflow/);
  });

  it('keeps pending/bounded capacity provenance and excludes dedicated hosts from metered pool rates', () => {
    const results = pricingComparison(buildRows(50, null), knownMonth);
    expect(results.some((result) => result.id === 'M0' || result.id === 'M1')).toBe(false);
    expect(results.find((result) => result.id === 'M5')!.pending).toBe(true);
    expect(results.find((result) => result.id === 'M4')!.costIsUpperBound).toBe(true);
    const md = renderMarkdown([row('M3')], knownMonth);
    expect(md).toContain('synthetic:month-evidence');
    expect(md).toContain('unknown: none');
  });
});

describe('on-demand workspace month', () => {
  const profile = { computeHourlyUsd: 0.06, retainedDiskGiB: 52, diskGiBMonthUsd: 0.1,
    backupMonthUsd: 0.8, controlMonthUsd: 1, networkMonthUsd: 2, activeIpv4HourlyUsd: 0.005,
    inferenceMonthUsd: 1.5 };

  it('retains disks, backups and control costs when the VM never runs', () => {
    const idle = onDemandMonthUsd({ ...profile, activeHours: 0 });
    expect(idle.computeUsd).toBe(0);
    expect(idle.ipv4Usd).toBe(0);
    expect(idle.retainedUsd).toBeCloseTo(7);
    expect(idle.inferenceUsd).toBeCloseTo(1.5);
    expect(idle.totalUsd).toBeCloseTo(10.5);
  });

  it.each([[60, 14.4], [120, 18.3], [240, 26.1]])('prices %s active hours without prorating retained storage or monthly inference', (activeHours, total) => {
    const result = onDemandMonthUsd({ ...profile, activeHours });
    expect(result.storageUsd).toBeCloseTo(5.2);
    expect(result.totalUsd).toBeCloseTo(total);
  });

  it('accounts for growing storage independently of running hours', () => {
    const before = onDemandMonthUsd({ ...profile, activeHours: 60 });
    const after = onDemandMonthUsd({ ...profile, activeHours: 60, retainedDiskGiB: 104 });
    expect(after.computeUsd).toBe(before.computeUsd);
    expect(after.totalUsd - before.totalUsd).toBeCloseTo(5.2);
  });

  it('rejects missing, negative and non-finite inputs and hours beyond one month', () => {
    const input = { ...profile, activeHours: 60 };
    for (const key of Object.keys(input) as (keyof typeof input)[]) {
      for (const bad of [-1, NaN, Infinity, undefined]) {
        expect(() => onDemandMonthUsd({ ...input, [key]: bad } as Parameters<typeof onDemandMonthUsd>[0])).toThrow(/finite/);
      }
      const omitted = { ...input } as Partial<typeof input>;
      delete omitted[key];
      expect(() => onDemandMonthUsd(omitted as typeof input), `omitted ${key}`).toThrow(/finite/);
    }
    expect(() => onDemandMonthUsd({ ...profile, activeHours: 731 })).toThrow(/month/);
  });

  it('requires an explicit inference cost and includes it when a profile crosses $20', () => {
    const result = onDemandMonthUsd({ ...profile, activeHours: 120, inferenceMonthUsd: 3.2 });
    expect(result.inferenceUsd).toBe(3.2);
    expect(result.totalUsd).toBeCloseTo(20);
    const withoutInference = onDemandMonthUsd({ ...profile, activeHours: 120, inferenceMonthUsd: 0 });
    expect(withoutInference.totalUsd).toBeCloseTo(16.8);
  });

  it('rejects finite inputs whose computed monthly charge overflows', () => {
    expect(() => onDemandMonthUsd({ ...profile, activeHours: 730,
      computeHourlyUsd: Number.MAX_VALUE })).toThrow(/finite/);
  });
});

describe('pool bill conservation (synthetic accounting fixtures, not measured prices)', () => {
  const line = (patch: Partial<PoolBillLine> = {}): PoolBillLine => ({
    id: 'compute', periodRef: 'invoice:2026-10', provider: 'gcp', currency: 'USD',
    category: 'compute', kind: 'charge', amountMicros: 101, sourceRef: 'fixture:invoice',
    allocation: { kind: 'compute', achievedAgentMilliseconds: 1000,
      capacityEvidenceRef: 'fixture:measured-capacity', tenants: [{ tenantId: 'tenant-a', activeAgentMilliseconds: 500 }] },
    ...patch,
  });
  const bill = (lines: PoolBillLine[], totalMicros = lines.reduce((sum, row) => sum + (row.amountMicros ?? 0), 0)) =>
    allocatePoolBill({ periodRef: 'invoice:2026-10', currency: 'USD', totalMicros, lines });

  it.each([1, 50])('conserves a bill for %i agents and exposes unused achieved capacity as overhead', (agents) => {
    const result = bill([line({ allocation: { kind: 'compute', achievedAgentMilliseconds: (agents + 1) * 1000,
      capacityEvidenceRef: 'fixture:measured-capacity',
      tenants: Array.from({ length: agents }, (_, n) => ({ tenantId: `tenant-${n}`, activeAgentMilliseconds: 1000 })) } })]);
    expect(result.complete).toBe(true);
    expect(result.tenants).toHaveLength(agents);
    expect(result.tenants.reduce((sum, row) => sum + row.amountMicros, 0) + result.overheadMicros).toBe(101);
    expect(result.unallocatedMicros).toBe(0);
    expect(result.overheadMicros).toBeGreaterThan(0);
  });

  it('uses achieved capacity rather than nominal slots when allocating compute', () => {
    expect(bill([line({ amountMicros: 100 })]).tenants[0].amountMicros).toBe(50);
    const result = bill([line({ amountMicros: 100, allocation: { kind: 'compute', achievedAgentMilliseconds: 500,
      capacityEvidenceRef: 'fixture:measured-lower-capacity', tenants: [{ tenantId: 'tenant-a', activeAgentMilliseconds: 500 }] } })]);
    expect(result.tenants[0].amountMicros).toBe(100);
    expect(result.overheadMicros).toBe(0);
  });

  it('retains every resource class and mixed-provider costs at zero activity', () => {
    const categories: PoolBillLine['category'][] = ['compute', 'persistent-storage', 'provisioned-performance',
      'backup', 'object-storage', 'network', 'control-plane', 'warm-capacity', 'inference'];
    const result = bill(categories.map((category, n) => line({ id: category, category,
      provider: n % 2 ? 'aws' : 'gcp', amountMicros: n + 1,
      allocation: { kind: 'compute', achievedAgentMilliseconds: 0, capacityEvidenceRef: 'fixture:idle', tenants: [] } })));
    expect(result.overheadMicros).toBe(45);
    expect(result.tenantTotalMicros).toBe(0);
    expect(result.lines.map((row) => row.category)).toEqual(categories);
    expect(result.complete).toBe(true);
  });

  it('splits indivisible micros deterministically, independent of tenant order', () => {
    const tenants = [{ tenantId: 'b', weight: 1 }, { tenantId: 'a', weight: 1 }];
    const project = (rows: typeof tenants) => bill([line({ amountMicros: 2,
      allocation: { kind: 'weighted', tenants: rows, overheadWeight: 1 } })]);
    const result = project(tenants);
    expect(result.tenants).toEqual([{ tenantId: 'a', amountMicros: 1 }, { tenantId: 'b', amountMicros: 1 }]);
    expect(result.overheadMicros).toBe(0);
    expect(project([...tenants].reverse())).toEqual(result);
  });

  it('conserves signed credits while exposing the credits-excluded steady-state total', () => {
    const result = bill([line({ amountMicros: 101 }), line({ id: 'credit', kind: 'credit', amountMicros: -51 })]);
    expect(result.totalMicros).toBe(50);
    expect(result.creditsMicros).toBe(-51);
    expect(result.creditsExcludedTotalMicros).toBe(101);
    expect(result.tenantTotalMicros + result.overheadMicros + result.unallocatedMicros).toBe(50);
    expect(result.lines[1].tenants[0].amountMicros).toBe(-26);
    expect(result.lines[1].overheadMicros).toBe(-25);
  });

  it.each([0, 29])('keeps missing prices unknown even with a %i-micro invoice residual', (residual) => {
    const result = bill([line(), line({ id: 'unpriced-backup', category: 'backup', amountMicros: null })], 101 + residual);
    expect(result.complete).toBe(false);
    expect(result.unpricedLineIds).toEqual(['unpriced-backup']);
    expect(result.unknownRateAllocationMicros).toBe(residual);
    expect(result.unallocatedMicros).toBe(residual);
    expect(result.creditsExcludedTotalMicros).toBeNull();
    expect(result.lines[1]).toMatchObject({ amountMicros: null, overheadMicros: null, unallocatedMicros: null });
    expect(result.tenantTotalMicros + result.overheadMicros + result.unallocatedMicros).toBe(result.totalMicros);
  });

  it('preserves unresolved tenant ownership separately from shared overhead', () => {
    const result = bill([line({ allocation: { kind: 'unresolved', reason: 'usage-census-missing' } })]);
    expect(result).toMatchObject({ complete: false, overheadMicros: 0, unallocatedMicros: 101, tenantTotalMicros: 0 });
    expect(result.gaps).toEqual(['unresolved-allocation:compute']);
  });

  it('keeps an unpriced credit as an unresolved reduction rather than free capacity', () => {
    const result = bill([line(), line({ id: 'unpriced-credit', kind: 'credit', amountMicros: null })], 99);
    expect(result).toMatchObject({ totalMicros: 99, unknownRateAllocationMicros: -2,
      unallocatedMicros: -2, complete: false, creditsExcludedTotalMicros: null });
    expect(result.tenantTotalMicros + result.overheadMicros + result.unallocatedMicros).toBe(99);
  });

  it('rejects currency, period, identity, sign and total mismatches', () => {
    for (const patch of [{ currency: 'EUR' }, { periodRef: 'invoice:other' }, { sourceRef: '' }, { provider: '' },
      { amountMicros: -1 }, { kind: 'credit', amountMicros: 1 }]) {
      expect(() => bill([line(patch as Partial<PoolBillLine>)])).toThrow();
    }
    expect(() => bill([line(), line()])).toThrow('duplicate');
    expect(() => bill([line()], 100)).toThrow('does not reconcile');
    expect(() => bill([line({ amountMicros: null })], -1)).toThrow('does not reconcile');
    expect(() => bill([line({ amountMicros: null, kind: 'credit' })], 1)).toThrow('does not reconcile');
  });

  it('rejects unmeasured capacity, over-allocation and invalid integer counters', () => {
    for (const achieved of [-1, NaN, Infinity, 0.5, 499, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bill([line({ allocation: { kind: 'compute', achievedAgentMilliseconds: achieved,
        capacityEvidenceRef: 'fixture:measured-capacity', tenants: [{ tenantId: 'a', activeAgentMilliseconds: 500 }] } })])).toThrow();
    }
    expect(() => bill([line({ allocation: { kind: 'compute', achievedAgentMilliseconds: 1000,
      capacityEvidenceRef: '', tenants: [] } })])).toThrow('reference');
    expect(() => bill([line({ allocation: { kind: 'weighted', overheadWeight: 0,
      tenants: [{ tenantId: 'a', weight: 1 }, { tenantId: 'a', weight: 1 }] } })])).toThrow('duplicate');
    expect(() => bill([line({ amountMicros: 0.5 })], 0)).toThrow('line amount');
  });

  it('conserves every small signed bill across a census of asymmetric and empty allocation weights', () => {
    for (let micros = -17; micros <= 17; micros++) {
      for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) for (let shared = 0; shared <= 3; shared++) {
        const result = bill([line({ amountMicros: micros, kind: micros < 0 ? 'credit' : 'charge',
          allocation: { kind: 'weighted', overheadWeight: shared,
            tenants: [{ tenantId: 'a', weight: a }, { tenantId: 'b', weight: b }] } })]);
        expect(result.tenantTotalMicros + result.overheadMicros + result.unallocatedMicros).toBe(micros);
        const weights = a + b + shared === 0 ? [0, 0, 1] : [a, b, shared];
        const shares = [...result.tenants.map((tenant) => tenant.amountMicros), result.overheadMicros];
        for (let n = 0; n < shares.length; n++) {
          const exact = Math.abs(micros) * weights[n] / weights.reduce((sum, value) => sum + value, 0);
          expect(Math.abs(shares[n])).toBeGreaterThanOrEqual(Math.floor(exact));
          expect(Math.abs(shares[n])).toBeLessThanOrEqual(Math.ceil(exact));
          expect(shares[n] * micros).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('conserves exact large values and refuses unsafe aggregate projections', () => {
    const result = bill([line({ amountMicros: Number.MAX_SAFE_INTEGER })]);
    expect(BigInt(result.tenantTotalMicros) + BigInt(result.overheadMicros)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(() => bill([line({ id: 'one', amountMicros: Number.MAX_SAFE_INTEGER }),
      line({ id: 'two', amountMicros: Number.MAX_SAFE_INTEGER }),
      line({ id: 'offset', kind: 'credit', amountMicros: -Number.MAX_SAFE_INTEGER })])).toThrow('overflow');
    expect(() => bill([line({ amountMicros: Number.MAX_SAFE_INTEGER }), line({ id: 'one-more', amountMicros: 1 })])).toThrow();
  });
});
