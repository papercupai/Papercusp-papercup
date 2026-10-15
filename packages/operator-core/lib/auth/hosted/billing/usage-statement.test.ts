import { describe, expect, it } from 'vitest';
import { buildHostedUsageStatement, type HostedUsageRecord } from './usage-statement';

const JAN = Date.UTC(2026, 0, 1);
const FEB = Date.UTC(2026, 1, 1);
const NOW = FEB + 1000;
function receipt(patch: Partial<HostedUsageRecord> = {}): HostedUsageRecord {
  return { controlWorkspaceId: 'control', organizationId: 'org-a', customerWorkspaceId: 'ws-a',
    recordId: 'receipt-a', usageId: 'usage-a', revision: 1, provider: 'openrouter',
    category: 'inference-input', payer: 'consumption', occurredAtMs: JAN + 1000, observedAtMs: JAN + 2000,
    quantity: 100, unit: 'tokens', costSource: 'provider-billed', costMicros: 10_001,
    sourceRef: 'provider:receipt-a', ...patch };
}
function statement(records: readonly HostedUsageRecord[], patch: Partial<Parameters<typeof buildHostedUsageStatement>[0]> = {}) {
  return buildHostedUsageStatement({ scope: { controlWorkspaceId: 'control', organizationId: 'org-a', customerWorkspaceId: null },
    month: '2026-01', asOfMs: NOW, source: { complete: true, observedAtMs: NOW, maximumAgeMs: 1000, evidenceRef: 'collector:census' }, records, ...patch });
}

describe('hosted usage statement projection (collector fixtures, not customer billing)', () => {
  it('aggregates submicro residue across providers before cent settlement, deduplicating and replacing revisions', () => {
    const a = receipt({ costMicros: 4999, costMicrosExact: '4999.6' });
    const b = receipt({ recordId: 'b', usageId: 'b', provider: 'other', costMicros: 5000, costMicrosExact: '5000.6' });
    const total = statement([a, b, a]);
    expect(total.consumptionBilled).toEqual({ micros: 10000, wholeCents: 1, roundingMicros: 0,
      microsExact: '10000.2', roundingMicrosExact: '0.2' });
    expect(total.history[0]?.revisions[0]?.costMicrosExact).toBeDefined();
    const correction = receipt({ recordId: 'corrected', revision: 2, observedAtMs: FEB, costMicros: 4999, costMicrosExact: '4999.3' });
    expect(statement([a, correction, correction, b]).consumptionBilled)
      .toEqual({ micros: 9999, wholeCents: 0, roundingMicros: 9999, microsExact: '9999.9', roundingMicrosExact: '9999.9' });
    const foreign = receipt({ organizationId: 'foreign', costMicros: 9000, costMicrosExact: '9000.9' });
    expect(statement([a, b, foreign])).toEqual(statement([a, b]));
  });
  it('carries tiny exact amounts into the forecast rather than a known zero', () => {
    const r = receipt({ costMicros: 0, costMicrosExact: '0.6' });
    const period = FEB - JAN; const cutoff = JAN + period / 2;
    expect(statement([r], { asOfMs: cutoff, source: { complete: true, observedAtMs: cutoff,
      maximumAgeMs: 0, evidenceRef: 'census:half-month' } }).forecast)
      .toMatchObject({ basisMicros: 0, basisMicrosExact: '0.6', projectedConsumptionMicros: 2 });
  });
  it.each(['00.1', '1e-1', '0.10', '-0.1', 'NaN', '0.' + '0'.repeat(324) + '1', '9007199254740991.1'])(
    'rejects noncanonical/overflow exact cost %s', costMicrosExact => {
      expect(() => statement([receipt({ costMicros: 0, costMicrosExact })])).toThrow();
    });
  it('refuses integer/exact disagreement and an exact amount on unknown cost', () => {
    expect(() => statement([receipt({ costMicros: 1, costMicrosExact: '0.1' })])).toThrow('mismatch');
    expect(() => statement([receipt({ costSource: 'unpriced', costMicros: null, costMicrosExact: '0' })])).toThrow('unknown cost');
    const a = receipt({ costMicros: 0, costMicrosExact: '0.1' });
    expect(() => statement([a, { ...a, costMicrosExact: '0.2' }])).toThrow('replay mismatch');
  });
  const periodMs = FEB - JAN;
  const mid = JAN + periodMs / 2;
  const midWindow = { asOfMs: mid,
    source: { complete: true, observedAtMs: mid, maximumAgeMs: 1000, evidenceRef: 'collector:mid-month' } };

  it('forecasts latest known consumption at the elapsed monthly rate without changing billed totals', () => {
    const result = statement([receipt({ costMicros: 101 }),
      receipt({ recordId: 'estimate', usageId: 'estimate', costSource: 'estimate', costMicros: 10 }),
      receipt({ recordId: 'reported', usageId: 'reported', costSource: 'provider-reported', costMicros: 4 }),
      receipt({ recordId: 'platform', usageId: 'platform', payer: 'platform', costMicros: 900 }),
      receipt({ recordId: 'direct', usageId: 'direct', payer: 'customer-direct', costMicros: 800 })], midWindow);
    expect(result.forecast).toEqual({ method: 'linear-elapsed-utc-month', basisMicros: 115,
      elapsedMs: periodMs / 2, periodMs, projectedConsumptionMicros: 230, provisional: true, unavailableReason: null });
    expect(result.consumptionBilled.micros).toBe(101); expect(result.settlementEligible).toBe(false);
    expect(result.platformBilledMicros).toBe(900); expect(result.customerDirectBilledMicros).toBe(800);
  });

  it('uses the actual census cutoff and rounds projected micros upward exactly', () => {
    const cutoff = JAN + periodMs * 2 / 3;
    const result = statement([receipt({ costMicros: 1 })], { asOfMs: cutoff + 500,
      source: { ...midWindow.source, observedAtMs: cutoff } });
    expect(result.forecast).toMatchObject({ basisMicros: 1, elapsedMs: periodMs * 2 / 3, projectedConsumptionMicros: 2 });
  });

  it('does not extrapolate a closed month or count a corrected/replayed bill twice', () => {
    const first = receipt({ costMicros: 100 });
    const corrected = receipt({ recordId: 'corrected', revision: 2, observedAtMs: FEB, costMicros: 40 });
    const result = statement([first, corrected, corrected]);
    expect(result.forecast).toMatchObject({ basisMicros: 40, elapsedMs: periodMs, projectedConsumptionMicros: 40,
      provisional: false, unavailableReason: null });
    expect(result.consumptionBilled.micros).toBe(40);
  });

  it('keeps a not-yet-complete period provisional even when the read happens just after month end', () => {
    const result = statement([receipt({ costMicros: 10 })], { asOfMs: FEB + 100,
      source: { ...midWindow.source, observedAtMs: FEB - 100 } });
    expect(result.forecast).toMatchObject({ elapsedMs: periodMs - 100, projectedConsumptionMicros: 11,
      provisional: true, unavailableReason: null });
  });

  it.each([
    ['incomplete-source', { ...midWindow.source, complete: false }],
    ['source-not-current', { ...midWindow.source, observedAtMs: mid - 1001 }],
    ['source-not-current', { ...midWindow.source, observedAtMs: mid + 1 }],
  ] as const)('leaves the forecast unknown for %s', (reason, source) => {
    expect(statement([receipt()], { asOfMs: mid, source }).forecast)
      .toMatchObject({ basisMicros: null, projectedConsumptionMicros: null, unavailableReason: reason });
  });

  it('does not turn unpriced work or a receipt newer than its census into a known forecast', () => {
    expect(statement([receipt({ costSource: 'unpriced', costMicros: null })], midWindow).forecast)
      .toMatchObject({ projectedConsumptionMicros: null, unavailableReason: 'unpriced-usage' });
    expect(statement([receipt({ observedAtMs: mid })], { asOfMs: mid,
      source: { ...midWindow.source, observedAtMs: mid - 1 } }).forecast)
      .toMatchObject({ projectedConsumptionMicros: null, unavailableReason: 'receipt-newer-than-census' });
  });

  it('requires elapsed observation time, while a complete zero-usage mid-month remains zero', () => {
    expect(statement([], { month: '2026-03' }).forecast.unavailableReason).toBe('window-not-started');
    expect(statement([], { asOfMs: JAN, source: { ...midWindow.source, observedAtMs: JAN } }).forecast)
      .toMatchObject({ projectedConsumptionMicros: null, unavailableReason: 'no-elapsed-time' });
    expect(statement([], midWindow).forecast).toMatchObject({ basisMicros: 0, projectedConsumptionMicros: 0, unavailableReason: null });
  });

  it('leaves an overflowing forecast unknown without losing the supported billed amount', () => {
    const result = statement([receipt({ costMicros: Number.MAX_SAFE_INTEGER })], midWindow);
    expect(result.forecast).toMatchObject({ basisMicros: null, projectedConsumptionMicros: null, unavailableReason: 'amount-overflow' });
    expect(result.consumptionBilled.micros).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reconciles distinct input/output/cache, retained compute/storage/IP and egress costs exactly', () => {
    const categories = ['inference-input', 'inference-output', 'cache-read', 'cache-write', 'compute', 'persistent-storage', 'external-ip', 'egress'] as const;
    const result = statement(categories.map((category, i) => receipt({ category, recordId: `r-${i}`, usageId: `u-${i}`, costMicros: i + 1 })));
    expect(result.lines).toHaveLength(8);
    expect(result.consumptionBilled).toEqual({ micros: 36, wholeCents: 0, roundingMicros: 36 });
    expect(result.settlementEligible).toBe(true);
  });

  it('replay does not change quantities, usage count, costs or evidence history', () => {
    const row = receipt();
    expect(statement([row, { ...row }, row])).toEqual(statement([row]));
  });

  it('rejects a changed immutable receipt rather than silently accepting its retry', () => {
    expect(() => statement([receipt(), receipt({ costMicros: 99 })])).toThrow('replay mismatch');
  });

  it('does not mix overlapping IDs across organizations or control workspaces', () => {
    const result = statement([receipt(), receipt({ organizationId: 'org-b', costMicros: 999_999, sourceRef: 'foreign:evidence' }),
      receipt({ controlWorkspaceId: 'other-control', costMicros: 999_999 })]);
    expect(result).toEqual(statement([receipt()]));
    expect(JSON.stringify(result)).not.toContain('foreign:evidence');
  });

  it('allows the same provider receipt ID in distinct customer workspaces, with exact workspace filtering', () => {
    const rows = [receipt(), receipt({ customerWorkspaceId: 'ws-b', costMicros: 20_001 })];
    expect(statement(rows).consumptionBilled.micros).toBe(30_002);
    const scoped = statement(rows, { scope: { controlWorkspaceId: 'control', organizationId: 'org-a', customerWorkspaceId: 'ws-b' } });
    expect(scoped.lines.map((line) => line.customerWorkspaceId)).toEqual(['ws-b']);
    expect(scoped.consumptionBilled.micros).toBe(20_001);
  });

  it('keeps estimated, reported and unpriced usage separate from billed amounts', () => {
    const result = statement([receipt({ costSource: 'estimate', costMicros: 50 }),
      receipt({ recordId: 'r-b', usageId: 'u-b', costSource: 'provider-reported', costMicros: 75 }),
      receipt({ recordId: 'r-c', usageId: 'u-c', costSource: 'unpriced', costMicros: null })]);
    expect(result.lines[0]).toMatchObject({ quantity: 300, usages: 3, estimatedMicros: 50, reportedMicros: 75, billedMicros: 0, unpricedUsages: 1 });
    expect(result.settlementEligible).toBe(false);
    expect(result.gaps).toEqual(['estimated-cost', 'unpriced-usage', 'unreconciled-provider-cost']);
  });

  it('late billing replaces the estimate once and preserves traceable receipt revisions', () => {
    const estimate = receipt({ costSource: 'estimate', costMicros: 999 });
    const billed = receipt({ recordId: 'receipt-b', revision: 2, observedAtMs: FEB, costMicros: 10_001, sourceRef: 'invoice:line-b' });
    const result = statement([billed, estimate, billed]);
    expect(result.settlementEligible).toBe(true);
    expect(result.lines[0]).toMatchObject({ usages: 1, quantity: 100, estimatedMicros: 0, billedMicros: 10_001 });
    expect(result.history[0]?.revisions.map((row) => row.sourceRef)).toEqual(['provider:receipt-a', 'invoice:line-b']);
    expect(statement([estimate, billed])).toEqual(result);
  });

  it('cost corrections replace an earlier bill without adding another charge', () => {
    const result = statement([receipt(), receipt({ recordId: 'credit-correction', revision: 2, costMicros: 2000, observedAtMs: FEB })]);
    expect(result.consumptionBilled.micros).toBe(2000);
    expect(result.history[0]?.revisions.map((row) => row.costMicros)).toEqual([10_001, 2000]);
  });

  it.each([
    { recordId: 'r-b' },
    { recordId: 'r-b', revision: 2, occurredAtMs: JAN + 2000 },
    { recordId: 'r-b', revision: 2, category: 'egress' as const },
    { recordId: 'r-b', revision: 2, payer: 'customer-direct' as const },
    { recordId: 'r-b', revision: 2, unit: 'bytes' },
    { recordId: 'r-b', revision: 2, observedAtMs: JAN + 1500 },
    { recordId: 'r-b', revision: 2, costSource: 'estimate' as const },
  ])('rejects ambiguous, identity-changing or downgraded revisions: %j', (patch) => {
    expect(() => statement([receipt(), receipt(patch)])).toThrow('conflicting usage revision');
  });

  it('takes provider and platform costs out of customer-direct BYOK totals without dropping disclosure', () => {
    const result = statement([receipt(), receipt({ recordId: 'byok', usageId: 'byok', payer: 'customer-direct', costMicros: 700 }),
      receipt({ recordId: 'support', usageId: 'support', category: 'support', payer: 'platform', costMicros: 300 })]);
    expect(result.consumptionBilled.micros).toBe(10_001);
    expect(result.customerDirectBilledMicros).toBe(700);
    expect(result.platformBilledMicros).toBe(300);
  });

  it('rounds once after monthly aggregation and retains every sub-cent micro', () => {
    const result = statement([receipt({ costMicros: 9999 }), receipt({ recordId: 'r-b', usageId: 'u-b', costMicros: 2 })]);
    expect(result.consumptionBilled).toEqual({ micros: 10_001, wholeCents: 1, roundingMicros: 1 });
    expect(result.consumptionBilled.wholeCents * 10_000 + result.consumptionBilled.roundingMicros).toBe(result.consumptionBilled.micros);
  });

  it('uses UTC start-inclusive/end-exclusive occurrence windows, even when billing arrives later', () => {
    const result = statement([receipt({ occurredAtMs: JAN, costMicros: 5 }),
      receipt({ recordId: 'old', usageId: 'old', occurredAtMs: JAN - 1, costMicros: 99 }),
      receipt({ recordId: 'next', usageId: 'next', occurredAtMs: FEB, observedAtMs: FEB, costMicros: 99 })]);
    expect(result.consumptionBilled.micros).toBe(5);
    expect(result.history).toHaveLength(1);
  });

  it('does not use a receipt that was unknown at the requested as-of time', () => {
    expect(statement([receipt(), receipt({ recordId: 'late', revision: 2, observedAtMs: NOW + 1, costMicros: 500 })])).toEqual(statement([receipt()]));
  });

  it('keeps an empty incomplete census unknown and requires a fresh completeness receipt', () => {
    expect(statement([], { source: { complete: false, observedAtMs: NOW - 2000, maximumAgeMs: 1000, evidenceRef: 'collector:partial' } }))
      .toMatchObject({ settlementEligible: false, gaps: ['incomplete-source', 'source-not-current'] });
    expect(statement([])).toMatchObject({ settlementEligible: true, lines: [], consumptionBilled: { micros: 0 } });
    expect(statement([], { source: { complete: true, observedAtMs: NOW + 1, maximumAgeMs: 1000, evidenceRef: 'collector:future' } }).settlementEligible).toBe(false);
  });

  it('cannot call a future month or a receipt newer than its completeness census ready for settlement', () => {
    expect(statement([], { month: '2026-03' })).toMatchObject({ settlementEligible: false, gaps: ['window-not-started'] });
    const result = statement([receipt({ observedAtMs: NOW })], {
      source: { complete: true, observedAtMs: NOW - 1, maximumAgeMs: 1000, evidenceRef: 'collector:older' },
    });
    expect(result).toMatchObject({ settlementEligible: false, gaps: ['receipt-newer-than-census'] });
  });

  it('refuses unattributable rows instead of dropping them as foreign and asserting zero usage', () => {
    expect(() => statement([receipt({ organizationId: undefined as unknown as string })])).toThrow('identifier');
    expect(() => statement([null as unknown as HostedUsageRecord])).toThrow('invalid usage receipt');
  });

  it('keeps exact cents and residue at the largest supported micro amount', () => {
    const result = statement([receipt({ costMicros: Number.MAX_SAFE_INTEGER })]);
    expect(result.consumptionBilled).toEqual({ micros: 9_007_199_254_740_991, wholeCents: 900_719_925_474, roundingMicros: 991 });
  });

  it('accepts an explicit zero provider bill without calling unknown cost free', () => {
    expect(statement([receipt({ costMicros: 0 })]).settlementEligible).toBe(true);
    expect(() => statement([receipt({ costMicros: null })])).toThrow('safe integers');
    expect(() => statement([receipt({ costSource: 'unpriced', costMicros: 0 })])).toThrow('unknown cost');
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('refuses invalid cost/counter %s', (value) => {
    expect(() => statement([receipt({ costMicros: value })])).toThrow();
    expect(() => statement([receipt({ quantity: value })])).toThrow();
  });

  it('refuses aggregate overflow instead of losing financial precision', () => {
    expect(() => statement([receipt({ costMicros: Number.MAX_SAFE_INTEGER }), receipt({ recordId: 'r-b', usageId: 'u-b', costMicros: 1 })])).toThrow('safe integer range');
  });

  it('rejects customer content and freeform evidence fields at the metadata boundary', () => {
    expect(() => statement([{ ...receipt(), prompt: 'private source text' } as HostedUsageRecord])).toThrow('unsupported fields');
    expect(() => statement([receipt({ sourceRef: 'private source text' })])).toThrow('identifier');
    const result = statement([receipt()]);
    expect(result.history).toHaveLength(1); // The mechanism and legitimate evidence still work.
    expect(JSON.stringify(result)).not.toContain('private source text');
  });
});
