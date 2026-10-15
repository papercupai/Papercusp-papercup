/**
 * R-31 (agent-economy-flywheel-2026-08-30 P-043, D-025): one fixture per
 * invariant break — detected, exactly one work item opened and not re-opened on
 * the next hourly run, transfer gate closed; a clean fixture opens no item and
 * leaves the gate open.
 */
import { describe, expect, it } from 'vitest';
import { externalRefKey, journalEntryForMovement, type ExternalRef, type JournalEntry, type MoneyMovement } from './money-journal';
import {
  MANDATED_INVARIANTS,
  evaluateReconciliation,
  memoryReconciliationStore,
  reconciliationPeriod,
  runReconciliation,
  type BreakFiler,
  type GatePublisher,
  type ReconciliationInvariant,
  type ReconciliationSources,
  type TransferGate,
} from './reconciliation';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15T12:00Z
const IN_MONTH = Date.UTC(2026, 9, 2, 9, 0, 0);
const WS = 'ws-recon';

function entry(entryId: string, externalRef: ExternalRef, movement: MoneyMovement, occurredAtMs = IN_MONTH): JournalEntry {
  const built = journalEntryForMovement({ entryId, occurredAtMs, currency: 'USD', externalRef, memo: entryId, movement });
  if (!built.ok) throw new Error(`fixture entry ${entryId} invalid: ${built.code} ${built.detail}`);
  return built.entry;
}

const BT1: ExternalRef = { kind: 'stripe-balance-transaction', id: 'txn_credit1' };
const BT2: ExternalRef = { kind: 'stripe-balance-transaction', id: 'txn_payment2' };
const TX: ExternalRef = { kind: 'chain-tx', chainId: 84532, txHash: `0x${'ab'.repeat(32)}` };

/** A credit purchase, a customer payment carrying a DAO share, and a DAO transfer that paid part of it down. */
const ENTRIES: readonly JournalEntry[] = [
  entry('stripe-bt:txn_credit1', BT1, { kind: 'credit-purchase', grossCents: 10_000, feeCents: 320, taxCents: 0 }),
  entry('stripe-bt:txn_payment2', BT2, {
    kind: 'customer-payment',
    grossCents: 5_000,
    feeCents: 175,
    taxCents: 0,
    daoCents: 500,
    refundReserveCents: 100,
  }),
  entry('chain-tx:84532:dao-1', TX, { kind: 'dao-transfer', amountCents: 300 }),
];

function cleanSources(): ReconciliationSources {
  return {
    stripe: {
      status: 'ok',
      value: [
        { ref: externalRefKey(BT1), netCents: 9_680 },
        { ref: externalRefKey(BT2), netCents: 4_825 },
      ],
    },
    bank: { status: 'not-configured' },
    chain: { status: 'ok', value: [{ ref: externalRefKey(TX), netCents: -300 }] },
    credits: { status: 'ok', value: { outstandingMicros: 10_000 * 10_000 } },
    dao: { status: 'ok', value: { transferredCents: 300, chainAccruedCents: 0 } },
    safe: { status: 'ok', value: { balanceMicros: 3_000_000, receiptsMicros: 3_000_000, approvedSpendsMicros: 0 } },
  };
}

function harness() {
  const store = memoryReconciliationStore();
  const filed: { invariant: ReconciliationInvariant; id: string }[] = [];
  const resolvedNotes: string[] = [];
  const published: TransferGate[] = [];
  const filer: BreakFiler = {
    async fileBreak({ verdict }) {
      const id = `WI-${filed.length + 1}`;
      filed.push({ invariant: verdict.invariant, id });
      return id;
    },
    async noteResolved({ workItemId }) {
      resolvedNotes.push(workItemId);
    },
  };
  const gate: GatePublisher = {
    async publish({ gate: g }) {
      published.push(g);
      return { published: true };
    },
  };
  let clock = NOW;
  let n = 0;
  const deps = { store, filer, gate, now: () => clock, newRunId: () => `run-${++n}` };
  const run = (sources: ReconciliationSources, mode: 'provisional' | 'final' = 'provisional') =>
    runReconciliation({ workspaceId: WS, mode, entries: ENTRIES, sources, startedAtMs: clock }, deps);
  const tick = () => {
    clock += HOUR;
  };
  const hours = () => clock - NOW;
  return { store, filed, resolvedNotes, published, run, tick, hours };
}

const BREAKS: readonly { invariant: ReconciliationInvariant; sources: () => ReconciliationSources }[] = [
  {
    invariant: 'credit-reserve-covers-outstanding-credits',
    sources: () => ({ ...cleanSources(), credits: { status: 'ok', value: { outstandingMicros: 10_000 * 10_000 + 1 } } }),
  },
  {
    invariant: 'dao-payable-equals-accrued-minus-transferred',
    // The chain shows 100c more leaving for the DAO than the journal recorded.
    sources: () => ({ ...cleanSources(), dao: { status: 'ok', value: { transferredCents: 400, chainAccruedCents: 0 } } }),
  },
  {
    invariant: 'safe-balance-equals-receipts-minus-approved-spends',
    // 1 USDC left the Safe without an approved spend.
    sources: () => ({ ...cleanSources(), safe: { status: 'ok', value: { balanceMicros: 2_000_000, receiptsMicros: 3_000_000, approvedSpendsMicros: 0 } } }),
  },
  {
    invariant: 'journal-matches-stripe',
    // A Stripe movement the journal never recorded.
    sources: () => {
      const s = cleanSources();
      if (s.stripe.status !== 'ok') throw new Error('fixture');
      return { ...s, stripe: { status: 'ok', value: [...s.stripe.value, { ref: 'stripe-balance-transaction:txn_orphan', netCents: 1_234 }] } };
    },
  },
  {
    invariant: 'journal-matches-bank',
    // A bank feed is connected and shows a movement with no journal entry.
    sources: () => ({ ...cleanSources(), bank: { status: 'ok', value: [{ ref: 'bank-transaction:bk_77', netCents: -5_000 }] } }),
  },
  {
    invariant: 'journal-matches-chain',
    // The chain moved a different amount than the journal recorded for the same tx.
    sources: () => ({ ...cleanSources(), chain: { status: 'ok', value: [{ ref: externalRefKey(TX), netCents: -250 }] } }),
  },
];

describe('reconciliation (R-31)', () => {
  it('a clean fixture: every invariant holds, no item is opened, and the gate stays open', async () => {
    const h = harness();
    const first = await h.run(cleanSources());
    expect(first.verdicts.filter((v) => v.status === 'broken')).toEqual([]);
    expect(first.verdicts.find((v) => v.invariant === 'journal-matches-bank')?.status).toBe('not-configured');
    expect(first.opened).toEqual([]);
    expect(h.filed).toEqual([]);
    expect(first.gate).toEqual({ open: true, reasons: [] });
    h.tick();
    const second = await h.run(cleanSources());
    expect(second.gate.open).toBe(true);
    expect(h.published.map((g) => g.open)).toEqual([true, true]);
  });

  for (const fixture of BREAKS) {
    it(`${fixture.invariant}: detected, one item, not re-opened next hour, gate closed`, async () => {
      const h = harness();
      const first = await h.run(fixture.sources());
      const broken = first.verdicts.filter((v) => v.status === 'broken').map((v) => v.invariant);
      // Only the invariant this fixture breaks is broken: the fixture isolates it.
      expect(broken).toEqual([fixture.invariant]);
      expect(first.opened).toEqual([fixture.invariant]);
      expect(h.filed).toEqual([{ invariant: fixture.invariant, id: 'WI-1' }]);
      expect(first.gate.open).toBe(false);
      expect(first.gate.reasons).toEqual([`break open: ${fixture.invariant}`]);

      h.tick();
      const second = await h.run(fixture.sources());
      expect(second.opened).toEqual([]);
      expect(h.filed).toHaveLength(1);
      expect(second.gate.open).toBe(false);
      expect((await h.store.listOpenBreaks(WS)).map((b) => [b.invariant, b.workItemId])).toEqual([[fixture.invariant, 'WI-1']]);
      expect(h.published.map((g) => g.open)).toEqual([false, false]);
    });
  }

  it('a restored invariant resolves its break, notes the item, and reopens the gate; a later break files a new item', async () => {
    const h = harness();
    const breakFixture = BREAKS[0]!;
    await h.run(breakFixture.sources());
    h.tick();
    const restored = await h.run(cleanSources());
    expect(restored.resolved).toEqual([breakFixture.invariant]);
    expect(h.resolvedNotes).toEqual(['WI-1']);
    expect(restored.gate.open).toBe(true);
    h.tick();
    const again = await h.run(breakFixture.sources());
    expect(again.opened).toEqual([breakFixture.invariant]);
    expect(h.filed.map((f) => f.id)).toEqual(['WI-1', 'WI-2']);
  });

  it('a break found at month close stays open through provisional runs of the new month; only a final re-run resolves it', async () => {
    const h = harness();
    // Move to 2026-11-01T01:00Z: a final run now covers October, where the fixture's entries sit.
    while (h.store.runs.length === 0 && Date.UTC(2026, 10, 1, 1) > NOW + h.hours()) h.tick();
    const breakFixture = BREAKS[0]!;
    const closed = await h.run(breakFixture.sources(), 'final');
    expect(closed.opened).toEqual([breakFixture.invariant]);
    const detailAtClose = h.store.rows.get(`${WS}\u0000${breakFixture.invariant}`)!.detail;
    h.tick();
    // November is clean (no movements yet), but that says nothing about October.
    const november = {
      ...cleanSources(),
      stripe: { status: 'ok', value: [] },
      bank: { status: 'ok', value: [] },
      chain: { status: 'ok', value: [] },
    } as const;
    const hourly = await h.run(november);
    expect(hourly.resolved).toEqual([]);
    expect(hourly.gate).toEqual({ open: false, reasons: [`break open: ${breakFixture.invariant}`] });
    expect(h.store.rows.get(`${WS}\u0000${breakFixture.invariant}`)!.detail).toBe(detailAtClose);
    expect(h.resolvedNotes).toEqual([]);
    h.tick();
    const reclose = await h.run(cleanSources(), 'final');
    expect(reclose.resolved).toEqual([breakFixture.invariant]);
    expect(h.resolvedNotes).toEqual(['WI-1']);
    expect(reclose.gate.open).toBe(true);
    expect(h.filed).toHaveLength(1);
  });

  it('a source that fails keeps the gate closed without filing a break, and does not resolve an open one', async () => {
    const h = harness();
    await h.run(BREAKS[1]!.sources());
    h.tick();
    const blind = await h.run({ ...cleanSources(), dao: { status: 'failed', detail: 'rpc timeout' } });
    const dao = blind.verdicts.find((v) => v.invariant === 'dao-payable-equals-accrued-minus-transferred');
    expect(dao?.status).toBe('unknown');
    expect(blind.resolved).toEqual([]);
    expect(blind.gate.open).toBe(false);
    expect(blind.gate.reasons.some((r) => r.startsWith('cannot evaluate dao-payable'))).toBe(true);
    expect(h.filed).toHaveLength(1);
  });

  it('a mandated source that is not configured blocks the FINAL month close but not a provisional run', async () => {
    const noSafe = { ...cleanSources(), safe: { status: 'not-configured' } as const };
    const provisional = await harness().run(noSafe, 'provisional');
    expect(provisional.verdicts.find((v) => v.invariant === 'safe-balance-equals-receipts-minus-approved-spends')?.status).toBe(
      'not-configured',
    );
    expect(provisional.gate.open).toBe(true);
    // The final run covers September, before any of the fixture entries existed.
    const final = await harness().run(noSafe, 'final');
    expect(final.period.month).toBe('2026-09');
    expect(final.gate.open).toBe(false);
  });

  it('journal entries citing a rail with no configured source are a break, not a silent pass', () => {
    const verdicts = evaluateReconciliation({
      entries: ENTRIES,
      sources: { ...cleanSources(), chain: { status: 'not-configured' } },
      period: reconciliationPeriod('provisional', NOW),
    });
    expect(verdicts.find((v) => v.invariant === 'journal-matches-chain')?.status).toBe('broken');
  });

  it('a concurrent run that already opened the break files nothing', async () => {
    const h = harness();
    const fixture = BREAKS[2]!;
    await h.store.openBreak(WS, { invariant: fixture.invariant, workItemId: 'WI-peer', openedAtMs: NOW, openedByRunId: 'run-peer' }, 'peer');
    const run = await h.run(fixture.sources());
    expect(run.opened).toEqual([]);
    expect(h.filed).toEqual([]);
    expect(run.gate.open).toBe(false);
  });

  it('a break whose opening run died before filing its item is filed by the next run, once', async () => {
    const h = harness();
    const fixture = BREAKS[2]!;
    await h.store.openBreak(WS, { invariant: fixture.invariant, workItemId: null, openedAtMs: NOW, openedByRunId: 'run-dead' }, 'opener died');
    const run = await h.run(fixture.sources());
    expect(run.opened).toEqual([]);
    expect(h.filed).toEqual([{ invariant: fixture.invariant, id: 'WI-1' }]);
    expect((await h.store.listOpenBreaks(WS))[0]?.workItemId).toBe('WI-1');
    expect(run.gate.open).toBe(false);
    h.tick();
    await h.run(fixture.sources());
    expect(h.filed).toHaveLength(1);
  });

  it('periods: provisional covers the open month to now; final covers the month that just closed', () => {
    expect(reconciliationPeriod('provisional', NOW)).toEqual({ mode: 'provisional', fromMs: Date.UTC(2026, 9, 1), untilMs: NOW, month: '2026-10' });
    expect(reconciliationPeriod('final', Date.UTC(2026, 0, 1, 1))).toEqual({
      mode: 'final',
      fromMs: Date.UTC(2025, 11, 1),
      untilMs: Date.UTC(2026, 0, 1),
      month: '2025-12',
    });
    expect(MANDATED_INVARIANTS).toHaveLength(3);
  });
});

describe('dao-payable accrual on the chain rail (D-032, WI-10004709)', () => {
  const CLAIM: ExternalRef = { kind: 'chain-tx', chainId: 84532, txHash: `0x${'cd'.repeat(32)}` };
  // A final settlement claim of 20.00 whose batch allocated 2.00 to the DAO.
  const claimEntry = (daoCents: number) =>
    entry('chain-tx:84532:claim-1', CLAIM, { kind: 'customer-payment', grossCents: 2_000, feeCents: 0, taxCents: 0, daoCents, refundReserveCents: 0 });
  const daoVerdict = (entries: readonly JournalEntry[], chainAccruedCents: number) =>
    evaluateReconciliation({
      entries,
      sources: { ...cleanSources(), dao: { status: 'ok', value: { transferredCents: 300, chainAccruedCents } } },
      period: reconciliationPeriod('provisional', NOW),
    }).find((v) => v.invariant === 'dao-payable-equals-accrued-minus-transferred')!;

  it('holds when the journal carries exactly the DAO share the commerce ledger accrued', () => {
    const v = daoVerdict([...ENTRIES, claimEntry(200)], 200);
    expect(v.status).toBe('ok');
    // The off-chain accrual is the Stripe payment's 500c; the chain rail's 200c comes from the Worker.
    expect(v.detail).toContain('off-chain journal 500c + final settlements 200c');
  });

  it('breaks when the journal disagrees with the independent accrual, whichever side is short', () => {
    // A mis-split claim entry: the journal credited the DAO 150c of a 200c allocation.
    expect(daoVerdict([...ENTRIES, claimEntry(150)], 200).status).toBe('broken');
    // A final batch the journal never recorded: the DAO is owed 200c the books do not show.
    expect(daoVerdict(ENTRIES, 200).status).toBe('broken');
    // The pre-D-032 self-check: with the chain accrual taken from the journal itself, the missing
    // entry would have passed. Taking it from the Worker is what makes this a break.
    expect(daoVerdict(ENTRIES, 0).status).toBe('ok');
  });
});
