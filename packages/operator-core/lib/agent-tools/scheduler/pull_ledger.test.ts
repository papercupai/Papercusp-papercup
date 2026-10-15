import { describe, expect, it } from 'vitest';
import { pullLedgerRowFromInvocation, type PullLedgerInvocationRow } from './pull_ledger';

const base: PullLedgerInvocationRow = {
  invoked_at: '2026-09-02T18:41:15.233Z',
  coord_owner_id: 'su-d7f0f017',
  harness_slug: 'papercusp',
  status: 'ok',
  duration_ms: 4636,
  disposition: null,
  late_settlement: null,
};

describe('pullLedgerRowFromInvocation (EI-7014)', () => {
  it('shapes a claimed row with its specId@revision and a formatted specRef', () => {
    const row = pullLedgerRowFromInvocation({
      ...base,
      disposition: { kind: 'claimed', workItemId: 'EI-7014', specId: 'fleet-launch-kinds', revision: 3 },
    });
    expect(row).toEqual({
      at: base.invoked_at,
      bee: 'su-d7f0f017',
      harness: 'papercusp',
      disposition: 'claimed',
      item: 'EI-7014',
      specId: 'fleet-launch-kinds',
      revision: 3,
      specRef: 'fleet-launch-kinds (spec rev 3)',
      reason: null,
      durationMs: 4636,
      status: 'ok',
      lateSettlement: null,
    });
  });

  it('shapes a no-claim row with its reason, and null specRef when no specId is attributable', () => {
    const row = pullLedgerRowFromInvocation({
      ...base,
      disposition: { kind: 'no-claim', reason: 'fleet_lane_drained' },
    });
    expect(row.disposition).toBe('no-claim');
    expect(row.reason).toBe('fleet_lane_drained');
    expect(row.item).toBeNull();
    expect(row.specId).toBeNull();
    expect(row.specRef).toBeNull();
  });

  it('reports "unrecorded" — never guesses claimed/no-claim — when the ledger has no disposition', () => {
    // The shape a scheduler:get_next call that errored BEFORE its ctx.metadata?.() call takes
    // (e.g. an early harness_required exit): metadata_json->'schedulerDisposition' is NULL.
    expect(pullLedgerRowFromInvocation({ ...base, disposition: null }).disposition).toBe('unrecorded');
    expect(pullLedgerRowFromInvocation({ ...base, disposition: { kind: 'something-else' } }).disposition).toBe(
      'unrecorded',
    );
  });

  it('formats a null revision distinctly from a numeric one, via formatSpecRef', () => {
    const row = pullLedgerRowFromInvocation({
      ...base,
      disposition: { kind: 'no-claim', reason: 'x', specId: 'default-fixed-ordering', revision: null },
    });
    expect(row.specRef).toBe('default-fixed-ordering (spec rev unknown)');
  });

  it('surfaces a late claimed result separately from the unrecorded handler disposition', () => {
    const row = pullLedgerRowFromInvocation({
      ...base,
      late_settlement: { kind: 'claimed', workItemId: 'EI-late', settledAt: '2026-10-07T16:00:00.000Z' },
    });
    expect(row.disposition).toBe('unrecorded');
    expect(row.lateSettlement).toEqual({ kind: 'claimed', workItemId: 'EI-late', settledAt: '2026-10-07T16:00:00.000Z' });
  });

  it('preserves late no-claim and rejected-unknown as distinct outcomes', () => {
    expect(pullLedgerRowFromInvocation({
      ...base,
      late_settlement: { kind: 'no-claim', settledAt: '2026-10-07T16:00:00.000Z' },
    }).lateSettlement).toEqual({ kind: 'no-claim', settledAt: '2026-10-07T16:00:00.000Z' });
    expect(pullLedgerRowFromInvocation({
      ...base,
      late_settlement: { kind: 'rejected-unknown', settledAt: '2026-10-07T16:00:00.000Z' },
    }).lateSettlement).toEqual({ kind: 'rejected-unknown', settledAt: '2026-10-07T16:00:00.000Z' });
  });

  it('does not infer a late no-claim from missing or malformed settlement metadata', () => {
    expect(pullLedgerRowFromInvocation({ ...base, late_settlement: null }).lateSettlement).toBeNull();
    expect(pullLedgerRowFromInvocation({
      ...base,
      late_settlement: { kind: 'claimed', workItemId: '', settledAt: '2026-10-07T16:00:00.000Z' },
    }).lateSettlement).toBeNull();
  });
});
