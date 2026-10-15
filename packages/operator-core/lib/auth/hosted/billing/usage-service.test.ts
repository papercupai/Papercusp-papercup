import { describe, expect, it, vi } from 'vitest';
import { PILOT_COST_CATEGORIES } from './unit-economics';
import type { HostedUsageRecord } from './usage-statement';
import { createHostedUsageSource, type HostedUsageCollector, type HostedUsageRead } from './usage-service';

const T = Date.UTC(2026, 9, 2);
const request: HostedUsageRead = { scope: { controlWorkspaceId: 'control-a', organizationId: 'org-a', customerWorkspaceId: 'customer-a' }, month: '2026-10', asOfMs: T };
const receipt = (changes: Partial<HostedUsageRecord> = {}): HostedUsageRecord => ({
  controlWorkspaceId: 'control-a', organizationId: 'org-a', customerWorkspaceId: 'customer-a',
  provider: 'fixture-provider', recordId: 'r-1', usageId: 'u-1', revision: 1,
  category: 'compute', payer: 'consumption', occurredAtMs: T - 1, observedAtMs: T,
  quantity: 60, unit: 'seconds', costSource: 'provider-billed', costMicros: 20_003,
  sourceRef: 'fixture:provider-bill', ...changes,
});

function store(seed: readonly HostedUsageRecord[] = []) {
  const records = [...seed];
  return {
    records,
    append: vi.fn(async (record: HostedUsageRecord) => {
      if (records.some(existing => existing.recordId === record.recordId)) return 'duplicate' as const;
      records.push(record); return 'recorded' as const;
    }),
    readRecords: vi.fn(async (_input: HostedUsageRead): Promise<HostedUsageRecord[]> => [...records]),
  };
}
function collector(changes: Partial<HostedUsageCollector> = {}): HostedUsageCollector {
  return { id: 'fixture-census', provider: 'fixture-provider', categories: [...PILOT_COST_CATEGORIES],
    read: vi.fn(async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: T, evidenceRef: 'fixture:complete-population', records: [receipt()] })), ...changes };
}
const source = (s = store(), collectors: readonly HostedUsageCollector[] = [], maximumAgeMs = 1000) =>
  createHostedUsageSource({ store: s, collectors, maximumAgeMs });

describe('hosted usage server collector composition', () => {
  it('does not certify completeness from empty or populated database rows', async () => {
    for (const s of [store(), store([receipt()])]) {
      const statement = await source(s)(request);
      expect(statement.settlementEligible).toBe(false);
      expect(statement.gaps).toContain('incomplete-source');
      expect(s.append).not.toHaveBeenCalled();
    }
  });

  it('reconciles complete declared collector populations with exact cents and idempotent retries', async () => {
    const s = store(); const c = collector(); const read = source(s, [c]);
    const first = await read(request); const replay = await read(request);
    expect(first).toEqual(replay);
    expect(first.settlementEligible).toBe(true);
    expect(first.consumptionBilled).toEqual({ micros: 20_003, wholeCents: 2, roundingMicros: 3 });
    expect(first.lines[0]?.usages).toBe(1);
    expect(s.records).toHaveLength(1);
    expect(c.read).toHaveBeenCalledWith(request);
  });

  it('requires every canonical cost category even if the installed provider reports a complete subset', async () => {
    const statement = await source(store(), [collector({ categories: ['compute'] })])(request);
    expect(statement.gaps).toContain('incomplete-source');
    expect(statement.settlementEligible).toBe(false);
  });

  it('accepts a measured zero population only with explicit complete source coverage', async () => {
    const c = collector({ read: async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: T, evidenceRef: 'fixture:measured-zero-population', records: [] }) });
    const statement = await source(store(), [c])(request);
    expect(statement.lines).toEqual([]);
    expect(statement.settlementEligible).toBe(true);
    expect(statement.consumptionBilled.micros).toBe(0);
  });

  it('does not accept an omitted receipt, unconfigured provider or older correction as a reconciled population', async () => {
    const empty = collector({ read: async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: T, evidenceRef: 'fixture:claims-zero', records: [] }) });
    const missing = await source(store([receipt()]), [empty])(request);
    expect(missing.settlementEligible).toBe(false);
    expect(missing.consumptionBilled.micros).toBe(20_003);
    const unknown = receipt({ provider: 'unconfigured-provider', recordId: 'unknown-r', usageId: 'unknown-u' });
    expect((await source(store([unknown]), [collector()])(request)).settlementEligible).toBe(false);
    const corrected = receipt({ recordId: 'r-2', revision: 2, costMicros: 30_004 });
    const oldSnapshot = await source(store([corrected]), [collector()])(request);
    expect(oldSnapshot.settlementEligible).toBe(false);
    expect(oldSnapshot.consumptionBilled.micros).toBe(30_004);
    const current = collector({ read: async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: T, evidenceRef: 'fixture:corrected-bill', records: [corrected] }) });
    const reconciled = await source(store([receipt(), corrected]), [current])(request);
    expect(reconciled.settlementEligible).toBe(true);
    expect(reconciled.consumptionBilled.micros).toBe(30_004);
  });

  it('keeps partial and stale collection receipts ineligible', async () => {
    for (const change of [{ complete: false }, { observedAtMs: T - 2000 }]) {
      const c = collector({ read: async input => ({ scope: input.scope, month: input.month, complete: true,
        observedAtMs: T, evidenceRef: 'fixture:census', records: [], ...change }) });
      expect((await source(store(), [c])(request)).settlementEligible).toBe(false);
    }
  });

  it.each(['estimate', 'provider-reported', 'unpriced'] as const)('never turns %s into a provider bill', async costSource => {
    const r = receipt({ costSource, costMicros: costSource === 'unpriced' ? null : 20_003 });
    const c = collector({ read: async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: T, evidenceRef: 'fixture:census', records: [r] }) });
    const statement = await source(store(), [c])(request);
    expect(statement.settlementEligible).toBe(false);
    expect(statement.consumptionBilled.micros).toBe(0);
  });

  it.each([
    { organizationId: 'org-b' }, { controlWorkspaceId: 'control-b' }, { customerWorkspaceId: 'customer-b' },
    { provider: 'another-provider' }, { category: 'egress' as const }, { observedAtMs: T + 1 },
    { occurredAtMs: Date.UTC(2026, 8, 30) },
  ])('rejects a foreign or misclassified receipt before any write: %j', async change => {
    const s = store();
    const c = collector({ categories: ['compute'], read: async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: T, evidenceRef: 'fixture:census', records: [receipt(change)] }) });
    await expect(source(s, [c])(request)).rejects.toThrow('receipt mismatch');
    expect(s.append).not.toHaveBeenCalled();
  });

  it('rejects a 1999 receipt for the literal month 0099-12 before persistence', async () => {
    const s = store();
    const c = collector({ read: async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: T, evidenceRef: 'fixture:wrong-century', records: [receipt({ occurredAtMs: Date.UTC(1999, 11, 15) })] }) });
    await expect(source(s, [c])({ ...request, month: '0099-12' })).rejects.toThrow('receipt mismatch');
    expect(s.append).not.toHaveBeenCalled();
  });

  it('includes the first instant of a month and excludes the first instant of the next', async () => {
    const s = store();
    const c = collector({ read: async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: input.asOfMs, evidenceRef: 'fixture:boundary', records: [receipt({ occurredAtMs: Date.UTC(2026, 9, 1) })] }) });
    expect((await source(s, [c])(request)).consumptionBilled.micros).toBe(20_003);
    expect(s.append).toHaveBeenCalledTimes(1);
    const next = store();
    const nextMonth = collector({ read: async input => ({ scope: input.scope, month: input.month, complete: true,
      observedAtMs: input.asOfMs, evidenceRef: 'fixture:excluded-boundary',
      records: [receipt({ occurredAtMs: Date.UTC(2026, 10, 1), observedAtMs: input.asOfMs })] }) });
    await expect(source(next, [nextMonth])({ ...request, asOfMs: Date.UTC(2026, 10, 2) })).rejects.toThrow('receipt mismatch');
    expect(next.append).not.toHaveBeenCalled();
  });

  it('validates every collector batch before writing an otherwise valid first batch', async () => {
    const s = store(); const invalid = collector({ id: 'invalid-census',
      read: async input => ({ scope: input.scope, month: input.month, complete: true, observedAtMs: T,
        evidenceRef: 'fixture:invalid', records: [{ ...receipt(), customerContent: 'private' } as HostedUsageRecord] }) });
    await expect(source(s, [collector(), invalid])(request)).rejects.toThrow('unsupported fields');
    expect(s.append).not.toHaveBeenCalled();
  });

  it('rejects provider failure, receipt collision and a scope error from the store', async () => {
    const s = store(); const failed = collector({ read: async () => { throw new Error('private provider failure'); } });
    await expect(source(s, [failed])(request)).rejects.toThrow('provider failure');
    expect(s.append).not.toHaveBeenCalled();
    const conflicting = { append: vi.fn(async () => 'replay-mismatch' as const), readRecords: s.readRecords };
    await expect(createHostedUsageSource({ store: conflicting, collectors: [collector()], maximumAgeMs: 0 })(request)).rejects.toThrow('replay conflict');
    expect(s.readRecords).not.toHaveBeenCalled();
    s.readRecords.mockResolvedValue([receipt({ organizationId: 'org-b' })]);
    await expect(source(s)(request)).rejects.toThrow('store scope mismatch');
  });

  it('rejects mismatched month/census and invalid input before persistence', async () => {
    for (const change of [{ month: '2026-09' }, { observedAtMs: T + 1 }, { scope: { ...request.scope, organizationId: 'org-b' } }]) {
      const s = store(); const c = collector({ read: async input => ({ scope: input.scope, month: input.month,
        complete: true, observedAtMs: T, evidenceRef: 'fixture:census', records: [], ...change }) });
      await expect(source(s, [c])(request)).rejects.toThrow('snapshot mismatch');
      expect(s.append).not.toHaveBeenCalled();
    }
    const c = collector();
    await expect(source(store(), [c])({ ...request, scope: { ...request.scope, organizationId: '' } })).rejects.toThrow('identifier');
    expect(c.read).not.toHaveBeenCalled();
  });

  it('freezes authority bindings and validated observations across awaited persistence', async () => {
    const mutableRecord = { ...receipt() }; const snapshot = { scope: request.scope, month: request.month,
      complete: false, observedAtMs: T, evidenceRef: 'fixture:partial', records: [mutableRecord] };
    const s = store();
    s.append.mockImplementation(async r => {
      snapshot.complete = true; mutableRecord.costMicros = 999;
      s.records.push(r); return 'recorded';
    });
    const statement = await source(s, [collector({ read: async () => snapshot })])(request);
    expect(statement.settlementEligible).toBe(false);
    expect(statement.consumptionBilled.micros).toBe(20_003);
    expect(s.records[0]?.costMicros).toBe(20_003);
    const mutator = collector({ read: async input => {
      (input.scope as { organizationId: string }).organizationId = 'org-b'; return snapshot;
    } });
    await expect(source(store(), [mutator])(request)).rejects.toThrow();
    expect(request.scope.organizationId).toBe('org-a');
  });

  it('refuses duplicate/unknown collector declarations and invalid census age', () => {
    expect(() => source(store(), [collector(), collector()])).toThrow('invalid usage collector');
    expect(() => source(store(), [collector({ categories: ['unknown'] as never })])).toThrow('invalid usage collector');
    expect(() => source(store(), [], -1)).toThrow('invalid usage census age');
  });
});
