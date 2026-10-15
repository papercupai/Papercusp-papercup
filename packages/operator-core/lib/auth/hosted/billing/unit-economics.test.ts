import { describe, expect, it } from 'vitest';
import { calculatePilotEconomics, PILOT_COST_CATEGORIES, type PilotCostLine, type PilotPriceSheet,
  type PilotOutcomeObservation, type PilotOutcomePopulation } from './unit-economics';

const time = 1_000_000;
const provenance = { evidenceRef: 'fixture:observed-cost', measuredAtMs: time };
function line(category: PilotCostLine['category'], quantity = 0, micros = 1_000_000): PilotCostLine {
  return {
    id: category, category, payer: ['support', 'platform-overhead'].includes(category) ? 'platform' : 'consumption',
    quantity, unit: 'fixture-unit', usage: { ...provenance, kind: 'observed' },
    rate: { ...provenance, kind: 'provider-billed', unit: 'fixture-unit', unitsPerRate: 1, microsPerRate: micros },
  };
}
function sheet(overrides: Partial<PilotPriceSheet> = {}): PilotPriceSheet {
  return {
    version: 'fixture-v1', asOfMs: time, maximumEvidenceAgeMs: 1000,
    lines: PILOT_COST_CATEGORIES.map((category) => line(category)),
    platformPriceCents: 10_000, consumptionPriceCents: 2_000, includedAllowanceMicros: 20_000_000,
    inferenceMode: 'managed', overage: 'stop',
    paymentFee: { ...provenance, kind: 'merchant-confirmed', percentageBps: 290, fixedCents: 30 },
    targetPlatformMarginBps: 5000, targetConsumptionMarginBps: 2000, ...overrides,
  };
}
function replace(base: PilotPriceSheet, category: PilotCostLine['category'], patch: Partial<PilotCostLine>): PilotPriceSheet {
  return { ...base, lines: base.lines.map((row) => row.category === category ? { ...row, ...patch } : row) };
}

describe('bounded pilot outcome projection (synthetic observations, not customer acceptance)', () => {
  const observation = (caseId: string, patch: Partial<PilotOutcomeObservation> = {}): PilotOutcomeObservation => ({
    caseId, decision: 'accepted', reviewerRef: 'reviewer:fixture', reviewDurationMs: 30_000,
    reworkCount: 0, repeatUse: false, evidenceRef: `fixture:${caseId}`, measuredAtMs: time, ...patch,
  });
  const population = (patch: Partial<PilotOutcomePopulation> = {}): PilotOutcomePopulation => ({
    trialRef: 'trial:fixture', caseIds: ['case-1', 'case-2'],
    observations: [observation('case-1'), observation('case-2', { decision: 'rejected', reviewDurationMs: 20_000,
      reworkCount: 2, repeatUse: true })], costCaseIds: ['case-2', 'case-1'], costEvidenceRef: 'fixture:case-costs', ...patch,
  });
  const project = (outcomes = population(), base = sheet()) => calculatePilotEconomics({ ...base, outcomes }).outcomes!;

  it('uses the full case and cost census with independently calculated measured aggregates', () => {
    const base = replace(replace(sheet(), 'compute', { quantity: 3 }), 'support', { quantity: 1 });
    expect(project(population(), base)).toEqual({
      trialRef: 'trial:fixture', caseCount: 2, observedCases: 2, missingCaseIds: [], decidedCases: 2,
      acceptedCases: 1, acceptanceBps: 5000, knownReviewDurationMs: 50_000, reviewDurationMs: 50_000,
      knownReworkCount: 2, reworkCount: 2, knownRepeatUseCases: 1, repeatUseCases: 1,
      totalCostMicros: 4_000_000, costPerAcceptedCaseMicros: 4_000_000, gaps: [],
      evidenceRefs: ['fixture:case-1', 'fixture:case-2', 'fixture:case-costs'],
    });
    expect(calculatePilotEconomics(base)).not.toHaveProperty('outcomes');
  });
  it('includes customer-direct cost and rounds the result average up once', () => {
    const base = replace(sheet({ inferenceMode: 'customer-key', consumptionPriceCents: 0,
      lines: sheet().lines.map(row => row.category.startsWith('inference-') || row.category.startsWith('cache-')
        ? { ...row, payer: 'customer-direct' as const } : row) }), 'inference-output', {
      quantity: 3, rate: { ...provenance, unit: 'fixture-unit', unitsPerRate: 1, microsPerRate: 1, kind: 'provider-billed' },
    });
    expect(project(population({ observations: [observation('case-1'), observation('case-2')] }), base))
      .toMatchObject({ totalCostMicros: 3, acceptedCases: 2, costPerAcceptedCaseMicros: 2 });
  });
  it('keeps missing case observations in the denominator and retains partial sums as partial', () => {
    const result = project(population({ observations: [observation('case-1')] }));
    expect(result).toMatchObject({ caseCount: 2, observedCases: 1, missingCaseIds: ['case-2'], decidedCases: 1,
      acceptedCases: 1, acceptanceBps: null, knownReviewDurationMs: 30_000, reviewDurationMs: null,
      knownReworkCount: 0, reworkCount: null, knownRepeatUseCases: 0, repeatUseCases: null,
      costPerAcceptedCaseMicros: null });
    expect(result.gaps).toContain('missing-observations');
  });
  it('preserves each missing human measurement as unknown, independently of a known accepted decision', () => {
    const result = project(population({ observations: [observation('case-1', {
      reviewDurationMs: null, reworkCount: null, repeatUse: null }), observation('case-2')] }));
    expect(result).toMatchObject({ acceptedCases: 2, acceptanceBps: 10_000,
      knownReviewDurationMs: 30_000, reviewDurationMs: null, knownReworkCount: 0, reworkCount: null,
      knownRepeatUseCases: 0, repeatUseCases: null });
    expect(result.gaps).toEqual(['missing-review-duration', 'missing-rework', 'missing-repeat-use']);
  });
  it('preserves observed zero and refuses to divide empty or unaccepted populations', () => {
    expect(project(population({ observations: ['case-1', 'case-2'].map(id => observation(id, { reviewDurationMs: 0 })) })))
      .toMatchObject({ reviewDurationMs: 0, reworkCount: 0, repeatUseCases: 0, costPerAcceptedCaseMicros: 0 });
    expect(project(population({ caseIds: [], observations: [], costCaseIds: [] })))
      .toMatchObject({ acceptanceBps: null, reviewDurationMs: null, totalCostMicros: null, costPerAcceptedCaseMicros: null });
    expect(project(population({ observations: ['case-1', 'case-2'].map(id => observation(id, { decision: 'rejected' })) })))
      .toMatchObject({ acceptanceBps: 0, acceptedCases: 0, costPerAcceptedCaseMicros: null });
    expect(project(population({ observations: [observation('case-1', { decision: null }), observation('case-2')] })))
      .toMatchObject({ acceptanceBps: null, decidedCases: 1, costPerAcceptedCaseMicros: null });
  });
  it.each([null, ['case-1'], ['case-1', 'case-2', 'foreign']])('keeps absent or mismatched cost coverage unknown: %j', costCaseIds => {
    const result = project(population({ costCaseIds, costEvidenceRef: costCaseIds === null ? null : 'fixture:cost' }));
    expect(result).toMatchObject({ totalCostMicros: null, costPerAcceptedCaseMicros: null });
    expect(result.gaps).toContain('cost-population-unbound');
  });
  it('withholds measured result cost for provisional and unpriced cost sheets', () => {
    for (const base of [replace(sheet(), 'compute', { quantity: 1, rate: null }),
      replace(sheet(), 'compute', { quantity: 1, rate: { ...sheet().lines[0]!.rate!, kind: 'estimate' } })]) {
      expect(project(population(), base)).toMatchObject({ totalCostMicros: null, costPerAcceptedCaseMicros: null });
      expect(project(population(), base).gaps).toContain('cost-not-measured');
    }
  });
  it('rejects duplicate and cross-population records instead of silently changing counts', () => {
    for (const patch of [{ caseIds: ['case-1', 'case-1'] }, { costCaseIds: ['case-1', 'case-1'] },
      { observations: [observation('case-1'), observation('case-1')] }, { observations: [observation('foreign')] }]) {
      expect(() => project(population(patch))).toThrow();
    }
  });
  it('rejects malformed counters, attribution, evidence, freshness and oversized populations', () => {
    for (const patch of [{ reviewDurationMs: -1 }, { reworkCount: 0.5 }, { reviewDurationMs: NaN },
      { reworkCount: Infinity }, { reviewerRef: null }, { decision: 'fake' }, { repeatUse: 1 },
      { evidenceRef: '' }, { measuredAtMs: time + 1 }, { measuredAtMs: time - 1001 },
      { reviewDurationMs: undefined }, { extra: 'untrusted' }]) {
      expect(() => project(population({ observations: [observation('case-1', patch as Partial<PilotOutcomeObservation>)] })))
        .toThrow();
    }
    expect(() => project(population({ caseIds: Array.from({ length: 501 }, (_, n) => `case-${n}`) }))).toThrow();
    expect(() => project(population({ observations: Array(501).fill(observation('case-1')) }))).toThrow();
    expect(() => project(population({ costCaseIds: null }))).toThrow('cost evidence requires cost population');
    expect(() => project(population({ costEvidenceRef: null }))).toThrow('cost evidence');
    expect(() => project(population({ observations: [observation('case-1', { reviewerRef: null, decision: null })] })))
      .toThrow('reviewer attribution');
  });
  it('rejects aggregate overflow and accepts exactly the evidence age boundary', () => {
    for (const key of ['reviewDurationMs', 'reworkCount'] as const) {
      expect(() => project(population({ observations: [observation('case-1', { [key]: Number.MAX_SAFE_INTEGER }),
        observation('case-2', { [key]: 1 })] }))).toThrow('overflow');
    }
    expect(project(population({ observations: [observation('case-1', { measuredAtMs: time - 1000 }), observation('case-2')] })))
      .toMatchObject({ decidedCases: 2 });
  });
});

describe('pilot unit economics (synthetic arithmetic fixtures, not customer measurements)', () => {
  it.each([
    ['idle', 0, 1, 1, 0, 2, 4_000_000],
    ['normal', 5, 1, 1, 2, 2, 11_000_000],
    ['heavy', 20, 2, 2, 5, 4, 33_000_000],
    ['burst', 50, 2, 2, 10, 8, 72_000_000],
  ] as const)('reproduces %s including retained resources', (_name, compute, storage, ip, egress, support, total) => {
    const quantities = { compute, 'persistent-storage': storage, 'external-ip': ip, egress, support };
    const result = calculatePilotEconomics(sheet({ lines: PILOT_COST_CATEGORIES.map((category) => line(category, quantities[category as keyof typeof quantities] ?? 0)) }));
    expect(result.costs.reduce((sum, row) => sum + row.micros!, 0)).toBe(total);
    expect(result.platform.costMicros).toBe(support * 1_000_000);
    expect(result.consumption.costMicros).toBe((compute + storage + ip + egress) * 1_000_000);
    expect(result.paymentFeeCents).toBe(378);
  });

  it('allocates processing fees without loss and keeps platform/consumption margins separate', () => {
    const result = calculatePilotEconomics(replace(replace(sheet(), 'support', { quantity: 30 }), 'compute', { quantity: 10 }));
    expect(result.platform.paymentFeeMicros).toBe(3_200_000);
    expect(result.consumption.paymentFeeMicros).toBe(580_000);
    expect(result.platform.profitMicros).toBe(66_800_000);
    expect(result.consumption.profitMicros).toBe(9_420_000);
    expect(result.platform.marginBps).toBe(6680);
    expect(result.consumption.marginBps).toBe(4710);
    expect(result.platform.paymentFeeMicros! + result.consumption.paymentFeeMicros!).toBe(result.paymentFeeCents! * 10_000);
    expect(result.quoteAllowed).toBe(true);
  });

  it('uses margin, not markup, and gives a minimal fee-inclusive whole-cent quote', () => {
    const base = replace(sheet({ consumptionPriceCents: 0, paymentFee: { ...provenance, kind: 'merchant-confirmed', percentageBps: 0, fixedCents: 0 } }), 'support', { quantity: 100 });
    const result = calculatePilotEconomics({ ...base, platformPriceCents: 12_000, targetPlatformMarginBps: 2000 });
    expect(result.platform.marginBps).toBe(1666); // 20% markup is 16.66% margin.
    expect(result.platform.targetMet).toBe(false);
    expect(result.platform.minimumPriceCents).toBe(12_500);
    const floor = calculatePilotEconomics({ ...base, platformPriceCents: 12_500, targetPlatformMarginBps: 2000 });
    expect(floor.platform.targetMet).toBe(true);
    expect(calculatePilotEconomics({ ...base, platformPriceCents: 12_499, targetPlatformMarginBps: 2000 }).platform.targetMet).toBe(false);
  });

  it('finds the exact price floor despite whole-cent fee rounding', () => {
    const base = replace(sheet({ consumptionPriceCents: 0 }), 'support', { quantity: 40 });
    const result = calculatePilotEconomics(base);
    const price = result.platform.minimumPriceCents!;
    expect(calculatePilotEconomics({ ...base, platformPriceCents: price }).platform.targetMet).toBe(true);
    expect(calculatePilotEconomics({ ...base, platformPriceCents: price - 1 }).platform.targetMet).toBe(false);
  });

  it.each([[10_001, 290, 5000], [123_456, 3333, 5000], [1000, 1, 9998], [5001, 4000, 5000]])(
    'matches an independent exhaustive quote oracle for cost=%s fee=%s target=%s', (cost, fee, target) => {
      let expected = 1;
      while ((expected * 10_000 - cost - (Math.ceil(expected * fee / 10_000) + 30) * 10_000) * 10_000 < expected * 10_000 * target) expected++;
      const base = replace(sheet({ targetPlatformMarginBps: target, paymentFee: { ...provenance, kind: 'merchant-confirmed', percentageBps: fee, fixedCents: 30 } }), 'support', { quantity: 1, rate: { ...sheet().lines[0].rate!, microsPerRate: cost } });
      expect(calculatePilotEconomics(base).platform.minimumPriceCents).toBe(expected);
    },
  );

  it('does not bill customer-direct BYOK cost as Papercusp consumption', () => {
    const base = sheet({ inferenceMode: 'customer-key', consumptionPriceCents: 0 });
    const lines = base.lines.map((row): PilotCostLine => row.category.startsWith('inference-') || row.category.startsWith('cache-')
      ? { ...row, payer: 'customer-direct', quantity: row.category === 'inference-output' ? 17 : 0 } : row);
    const result = calculatePilotEconomics({ ...base, lines });
    expect(result.customerDirectKnownCostMicros).toBe(17_000_000);
    expect(result.consumption.costMicros).toBe(0);
    expect(result.quoteAllowed).toBe(true);
    expect(() => calculatePilotEconomics(base)).toThrow('inference payer');
  });

  it('prices uncached, output and cache usage as distinct inputs', () => {
    const base = sheet({ lines: PILOT_COST_CATEGORIES.map((category) => line(category,
      category === 'inference-input' ? 10 : category === 'cache-read' ? 90 : category === 'cache-write' ? 5 : category === 'inference-output' ? 20 : 0,
      category === 'cache-read' ? 100_000 : category === 'cache-write' ? 1_250_000 : category === 'inference-output' ? 5_000_000 : 1_000_000)) });
    expect(calculatePilotEconomics(base).consumption.costMicros).toBe(125_250_000);
  });

  it('rounds a fractional rate up only to a micro, and fees only once per invoice', () => {
    const base = replace(sheet({ platformPriceCents: 1, consumptionPriceCents: 1 }), 'compute', {
      quantity: 2, rate: { ...provenance, unit: 'fixture-unit', unitsPerRate: 3, microsPerRate: 1, kind: 'provider-billed' },
    });
    const result = calculatePilotEconomics(base);
    expect(result.consumption.costMicros).toBe(1);
    expect(result.paymentFeeCents).toBe(31);
    expect(result.platform.paymentFeeMicros! + result.consumption.paymentFeeMicros!).toBe(310_000);
  });

  it.each([[0, 0], [30, 1200], [60, 1200], [61, 1220]])('applies a 60-second minimum with subsequent seconds: %s seconds', (quantity, expected) => {
    const base = replace(sheet(), 'compute', { quantity, unit: 'seconds', rate: {
      ...provenance, kind: 'catalog', unit: 'seconds', microsPerRate: 72_000, unitsPerRate: 3600,
      minimumBillableUnits: 60, billingIncrementUnits: 1,
    } });
    expect(calculatePilotEconomics(base).consumption.costMicros).toBe(expected);
  });

  it('applies whole-block billing without treating bytes as GiB', () => {
    const base = replace(sheet(), 'egress', { quantity: 1025, unit: 'bytes', rate: {
      ...provenance, kind: 'provider-billed', unit: 'bytes', microsPerRate: 1, unitsPerRate: 1024,
      billingIncrementUnits: 1024,
    } });
    expect(calculatePilotEconomics(base).consumption.costMicros).toBe(2);
    expect(() => calculatePilotEconomics(replace(base, 'egress', { rate: { ...base.lines.find((row) => row.category === 'egress')!.rate!, billingIncrementUnits: 0 } }))).toThrow('billing increment');
  });

  it.each(['catalog', 'estimate'] as const)('%s prices remain provisional even with observed usage', (kind) => {
    const base = sheet();
    const result = calculatePilotEconomics(replace(base, 'compute', { quantity: 1, rate: { ...base.lines[0].rate!, kind } }));
    expect(result.state).toBe('provisional');
    expect(result.quoteAllowed).toBe(false);
    expect(result.reasons).toContain('estimated-cost:compute');
  });
  it.each(PILOT_COST_CATEGORIES.filter((category) => !['support', 'platform-overhead'].includes(category)))(
    'rejects a measured labor rate as observed %s provider cost', (category) => {
      const base = sheet();
      const resource = base.lines.find((row) => row.category === category)!;
      expect(() => calculatePilotEconomics(replace(base, category, {
        quantity: 1, rate: { ...resource.rate!, kind: 'measured-labor' },
      }))).toThrow('measured labor rate requires a labor cost category');
    },
  );
  it.each(['inference-input', 'inference-output', 'cache-read', 'cache-write', 'inference-fees'] as const)(
    'rejects labor evidence for customer-direct %s costs', (category) => {
      const base = sheet({ inferenceMode: 'customer-key', consumptionPriceCents: 0 });
      const lines = base.lines.map((row): PilotCostLine => row.category.startsWith('inference-') || row.category.startsWith('cache-')
        ? { ...row, payer: 'customer-direct' } : row);
      const resource = lines.find((row) => row.category === category)!;
      expect(() => calculatePilotEconomics(replace({ ...base, lines }, category, {
        quantity: 1, rate: { ...resource.rate!, kind: 'measured-labor' },
      }))).toThrow('measured labor rate requires a labor cost category');
    },
  );
  it.each(['support', 'platform-overhead'] as const)('retains measured staff rates for %s', (category) => {
    const base = sheet();
    const labor = base.lines.find((row) => row.category === category)!;
    const result = calculatePilotEconomics(replace(base, category, {
      quantity: 1, rate: { ...labor.rate!, kind: 'measured-labor' },
    }));
    expect(result.state).toBe('measured');
    expect(result.quoteAllowed).toBe(true);
    expect(result.platform.costMicros).toBe(1_000_000);
  });
  it('modeled support and catalog merchant fees cannot certify a real quote', () => {
    const result = calculatePilotEconomics(replace(sheet({ paymentFee: { ...provenance, kind: 'catalog', percentageBps: 290, fixedCents: 30 } }), 'support', { usage: { ...provenance, kind: 'modeled' } }));
    expect(result.state).toBe('provisional');
    expect(result.reasons).toContain('modeled-usage:support');
    expect(result.reasons).toContain('estimated-cost:payment-fee');
  });
  it('missing storage price leaves cost and margin unknown instead of reporting free stopped resources', () => {
    const result = calculatePilotEconomics(replace(sheet(), 'persistent-storage', { quantity: 20, rate: null }));
    expect(result.state).toBe('incomplete');
    expect(result.consumption.costMicros).toBeNull();
    expect(result.consumption.marginBps).toBeNull();
    expect(result.consumption.minimumPriceCents).toBeNull();
    expect(result.quoteAllowed).toBe(false);
    expect(result.reasons).toContain('unpriced:persistent-storage');
  });
  it('requires an explicit observation for each cost category', () => {
    const result = calculatePilotEconomics(sheet({ lines: sheet().lines.filter((row) => row.category !== 'external-ip') }));
    expect(result.state).toBe('incomplete');
    expect(result.reasons).toContain('missing-cost:external-ip');
    expect(result.platform.marginBps).toBeNull();
  });
  it('requires provider credit/BYOK fees in addition to token costs', () => {
    const result = calculatePilotEconomics(sheet({ lines: sheet().lines.filter((row) => row.category !== 'inference-fees') }));
    expect(result.state).toBe('incomplete');
    expect(result.reasons).toContain('missing-cost:inference-fees');
    expect(result.quoteAllowed).toBe(false);
  });
  it('permits observed zero exposure without inventing a rate', () => {
    expect(calculatePilotEconomics(replace(sheet(), 'external-ip', { quantity: 0, rate: null })).state).toBe('measured');
  });
  it('rejects stale and future-dated evidence as quote certification', () => {
    for (const measuredAtMs of [time - 1001, time + 1]) {
      const result = calculatePilotEconomics(replace(sheet(), 'compute', { usage: { ...provenance, measuredAtMs, kind: 'observed' } }));
      expect(result.state).toBe('provisional');
      expect(result.quoteAllowed).toBe(false);
      expect(result.reasons).toContain('stale-evidence:compute:usage');
    }
  });
  it('unknown fees do not produce a known margin', () => {
    const result = calculatePilotEconomics(sheet({ paymentFee: null }));
    expect(result.state).toBe('incomplete');
    expect(result.platform.marginBps).toBeNull();
    expect(result.paymentFeeCents).toBeNull();
  });
  it('reports uncharged consumption and negative margins faithfully', () => {
    const result = calculatePilotEconomics(replace(sheet({ consumptionPriceCents: 0, platformPriceCents: 1 }), 'compute', { quantity: 5 }));
    expect(result.reasons).toContain('unfunded-consumption');
    expect(result.platform.marginBps).toBe(-300_000);
    expect(result.quoteAllowed).toBe(false);
  });
  it('does not incur a transaction fee when no invoice is charged', () => {
    const result = calculatePilotEconomics(sheet({ platformPriceCents: 0, consumptionPriceCents: 0 }));
    expect(result.paymentFeeCents).toBe(0);
    expect(result.platform.marginBps).toBeNull();
    expect(result.quoteAllowed).toBe(false);
  });
  it('reports impossible fee-plus-margin targets without an invented quote', () => {
    const result = calculatePilotEconomics(sheet({ targetPlatformMarginBps: 9800 }));
    expect(result.platform.minimumPriceCents).toBeNull();
    expect(result.quoteAllowed).toBe(false);
  });
  it.each([-1, 0, Infinity, NaN])('rejects a non-finite or non-positive allowance %s', (includedAllowanceMicros) => {
    expect(() => calculatePilotEconomics(sheet({ includedAllowanceMicros }))).toThrow('finite allowance');
  });
  it('rejects duplicate cost ids, mismatched units and invalid billing units', () => {
    const base = sheet();
    expect(() => calculatePilotEconomics({ ...base, lines: [...base.lines, base.lines[0]] })).toThrow('duplicate');
    expect(() => calculatePilotEconomics(replace(base, 'compute', { unit: 'wrong' }))).toThrow('unit mismatch');
    expect(() => calculatePilotEconomics(replace(base, 'compute', { quantity: 0.5 }))).toThrow('quantity');
    expect(() => calculatePilotEconomics(replace(base, 'compute', { rate: { ...base.lines[0].rate!, unitsPerRate: 0 } }))).toThrow('rate units');
  });
  it('uses exact intermediate multiplication and refuses unsafe final amounts', () => {
    const base = replace(sheet(), 'compute', { quantity: 1_000_000_000, rate: { ...sheet().lines[0].rate!, unitsPerRate: 1_000_000_000, microsPerRate: 1_000_000_000 } });
    expect(calculatePilotEconomics(base).consumption.costMicros).toBe(1_000_000_000);
    expect(() => calculatePilotEconomics(replace(base, 'compute', { rate: { ...base.lines[0].rate!, unitsPerRate: 1 } }))).toThrow('overflow');
    expect(() => calculatePilotEconomics(sheet({ platformPriceCents: Number.MAX_SAFE_INTEGER }))).toThrow('overflow');
  });
});
