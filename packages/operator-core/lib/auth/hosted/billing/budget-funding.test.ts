import { describe, expect, it, vi } from 'vitest';
import { journalEntryForMovement, type JournalEntry, type MoneyMovement } from '../../../cupboard/money-journal';
import { receiptCommitment } from '../../../cupboard/payment-receipt';
import { evaluateHostedBudget } from './budget-policy';
import { collectHostedStripeFunding, evaluateHostedPrepaidFunding, reconcileHostedStripeFunding, type HostedCashBacking,
  type HostedPrepaidFundingInput, type HostedStripeFundingRead, type HostedStripeFundingCollection,
  type HostedStripeFundingCollectorClient } from './budget-funding';
import type { StripeObservedBalanceTransaction } from './stripe-billing-client';

const T = Date.UTC(2026, 9, 2);
const START = Date.UTC(2026, 9, 1);
const END = Date.UTC(2026, 10, 1);
const KEY = 'consumption.usd_cents';
const scope = { controlWorkspaceId: 'control', organizationId: 'org-a', customerWorkspaceId: 'ws-a' };
function payment(id = 'txn_one', gross = 100, fee = 3, tax = 10, movement?: MoneyMovement) {
  const transaction = { id, amount: movement ? -gross : gross, fee, currency: 'usd', created: T / 1000 };
  const built = journalEntryForMovement({ entryId: `stripe-bt:${id}`, occurredAtMs: T, currency: 'USD',
    externalRef: { kind: 'stripe-balance-transaction', id },
    movement: movement ?? { kind: 'credit-purchase', grossCents: gross, feeCents: fee, taxCents: tax } });
  if (!built.ok) throw new Error(built.detail);
  const salt = 'a'.repeat(64);
  return { entry: built.entry, receipt: { transaction, receiptSeq: 1, salt,
    commitment: receiptCommitment(transaction, salt), sourceId: `ch_${id}`, sourceCustomer: 'cus_A' }, available: true };
}
const allocation = (changes: Partial<HostedPrepaidFundingInput['allocations'][number]> = {}) => ({
  allocationId: 'grant-a', paymentTransactionId: 'txn_one', organizationId: 'org-a',
  customerWorkspaceId: 'ws-a', budgetKey: KEY, micros: 500_000, ...changes,
});
const charge = (changes: Partial<HostedPrepaidFundingInput['priorCharges'][number]> = {}) => ({
  chargeId: 'charge-a', organizationId: 'org-a', customerWorkspaceId: 'ws-a', budgetKey: KEY,
  periodEndMs: START, costSource: 'provider-billed' as const, providerFinal: true, micros: 100_000, ...changes,
});
function journal(id: string, movement: MoneyMovement): JournalEntry {
  const built = journalEntryForMovement({ entryId: id, occurredAtMs: T, currency: 'USD',
    externalRef: { kind: 'bank-transaction', id }, movement });
  if (!built.ok) throw new Error(built.detail);
  return built.entry;
}
function cash(journalEntries: readonly JournalEntry[], changes: Partial<HostedCashBacking> = {}): HostedCashBacking {
  return { controlWorkspaceId: 'control', stripeAccountId: 'acct_A', asOfMs: T,
    livemode: true, complete: true, evidenceRef: 'cash:reconciled-pool', journalEntries,
    availableMicros: 100_000_000, unpaidProviderMicros: 0, retainedReserveMicros: 0, ...changes };
}
const capital = payment('txn_capital', 10_000, 0, 0,
  { kind: 'customer-payment', grossCents: 10_000, feeCents: 0, taxCents: 0, daoCents: 0, refundReserveCents: 0 }).entry;
function input(changes: Partial<HostedPrepaidFundingInput> = {}): HostedPrepaidFundingInput {
  const payments = changes.payments ?? [payment()];
  const reversals = changes.reversals ?? [];
  return { scope, budgetKey: KEY, windowStartMs: START, asOfMs: T,
    snapshot: { controlWorkspaceId: 'control', organizationId: 'org-a', stripeAccountId: 'acct_A',
      stripeCustomerId: 'cus_A', livemode: true, complete: true, asOfMs: T, evidenceRef: 'stripe:census-a' },
    payments, reversals, allocations: [allocation()], priorCharges: [],
    cashBacking: cash([capital, ...payments.map(p => p.entry), ...reversals.map(r => r.entry)]), ...changes };
}
const run = (changes: Partial<HostedPrepaidFundingInput> = {}) => evaluateHostedPrepaidFunding(input(changes));
function refund(id = 'txn_refund', gross = 30, fee = 0, tax = 0, chargeback = false) {
  return { ...payment(id, gross, fee, tax, chargeback
    ? { kind: 'chargeback', amountCents: gross, feeCents: fee }
    : { kind: 'refund', amountCents: gross, taxCents: tax }), paymentTransactionId: 'txn_one' };
}

describe('prepaid allocation rules (verified server census and durable transaction still required)', () => {
  it('partitions one payment across workspaces without counting organization funding twice', () => {
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', customerWorkspaceId: 'ws-b', micros: 370_000 })] }))
      .toEqual({ ok: true, organization: { fundedMicros: 870_000 }, workspace: { fundedMicros: 500_000 }, evidenceRef: 'stripe:census-a' });
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', customerWorkspaceId: 'ws-b', micros: 370_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('deducts payment fees and collected tax before allocating cash', () => {
    expect(run({ allocations: [allocation({ micros: 870_000 })] })).toMatchObject({ ok: true, organization: { fundedMicros: 870_000 } });
    expect(run({ allocations: [allocation({ micros: 870_001 })] })).toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(run({ payments: [payment('txn_one', 100, 100, 10)], allocations: [] })).toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('allows organization funding without inventing a separate workspace allowance', () => {
    expect(run({ allocations: [allocation({ customerWorkspaceId: null })], priorCharges: [charge()] }))
      .toEqual({ ok: true, organization: { fundedMicros: 400_000 }, workspace: null, evidenceRef: 'stripe:census-a' });
    expect(run({ allocations: [] })).toMatchObject({ ok: true, organization: { fundedMicros: 0 }, workspace: null });
  });

  it('checks each source independently, so a second payment cannot cover duplicate use of the first', () => {
    expect(run({ payments: [payment(), payment('txn_two')], allocations: [allocation({ micros: 870_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(run({ payments: [payment(), payment('txn_two')], allocations: [allocation(),
      allocation({ allocationId: 'grant-b', paymentTransactionId: 'txn_two', micros: 600_000 })] }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 1_100_000 } });
  });

  it('counts allocations of other keys against the same source capacity', () => {
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', budgetKey: 'storage.usd_cents', micros: 370_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', budgetKey: 'storage.usd_cents', micros: 370_000 })] }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 500_000 } });
  });

  it('does not assign the customer payment to a second organization or an absent source', () => {
    for (const a of [allocation({ organizationId: 'org-b' }), allocation({ paymentTransactionId: 'txn_missing' })]) {
      expect(run({ allocations: [a] })).toEqual({ ok: false, reason: 'funding-scope-mismatch' });
    }
  });

  it.each(['livemode', 'complete'] as const)('refuses an unverified %s snapshot', field => {
    expect(run({ snapshot: { ...input().snapshot, [field]: false } })).toEqual({ ok: false, reason: 'unverified-funding' });
  });

  it.each([-1, 1])('refuses a snapshot with a different cutoff (%s)', delta => {
    expect(run({ snapshot: { ...input().snapshot, asOfMs: T + delta } })).toEqual({ ok: false, reason: 'unverified-funding' });
  });

  it.each(['stripeAccountId', 'stripeCustomerId', 'evidenceRef'] as const)('requires a pinned %s', field => {
    expect(run({ snapshot: { ...input().snapshot, [field]: '' } })).toEqual({ ok: false, reason: 'unverified-funding' });
  });

  it.each(['controlWorkspaceId', 'organizationId'] as const)('refuses a foreign snapshot %s', field => {
    expect(run({ snapshot: { ...input().snapshot, [field]: 'foreign' } })).toEqual({ ok: false, reason: 'funding-scope-mismatch' });
  });

  it('refuses an allocation of pending cash, while leaving unrelated pending receipts unfunded', () => {
    expect(run({ payments: [{ ...payment(), available: false }] })).toEqual({ ok: false, reason: 'unavailable-payment' });
    expect(run({ payments: [payment(), { ...payment('txn_two'), available: false }] })).toMatchObject({ ok: true });
  });

  it('does not treat subscription revenue or an arbitrary balanced posting as prepaid funding', () => {
    const p = payment('txn_one', 100, 3, 10,
      { kind: 'customer-payment', grossCents: 100, feeCents: 3, taxCents: 10, daoCents: 0, refundReserveCents: 0 });
    // Replace the fixture's signed amount; the receipt itself must remain valid.
    const transaction = { ...p.receipt.transaction, amount: 100 };
    expect(() => run({ payments: [{ ...p, receipt: { ...p.receipt, transaction,
      commitment: receiptCommitment(transaction, p.receipt.salt) } }] })).toThrow(/not a prepaid/);
    const balanced = payment();
    expect(() => run({ payments: [{ ...balanced, entry: { ...balanced.entry,
      lines: [{ account: 'operating', side: 'debit', cents: 100 }, { account: 'customer-credit-reserve', side: 'credit', cents: 100 }] } }] }))
      .toThrow(/posting mismatch/);
  });

  it('requires the receipt commitment, transaction, customer, currency and timestamp to match the journal', () => {
    const p = payment();
    expect(() => run({ payments: [{ ...p, receipt: { ...p.receipt, commitment: '0'.repeat(64) } }] })).toThrow(/receipt/);
    expect(() => run({ payments: [{ ...p, receipt: { ...p.receipt, sourceCustomer: 'cus_B' } }] })).toThrow(/binding/);
    expect(() => run({ payments: [{ ...p, entry: { ...p.entry, externalRef: { kind: 'stripe-balance-transaction', id: 'txn_other' } } }] })).toThrow(/binding/);
    expect(() => run({ payments: [{ ...p, entry: { ...p.entry, currency: 'EUR' } }] })).toThrow(/binding/);
    expect(() => run({ payments: [{ ...p, entry: { ...p.entry, occurredAtMs: T - 1 } }] })).toThrow(/binding/);
  });

  it('refuses future or duplicate source postings even under a new journal id', () => {
    const p = payment();
    expect(() => run({ payments: [p, p] })).toThrow(/duplicate/);
    expect(() => run({ payments: [p, { ...p, entry: { ...p.entry, entryId: 'alias' } }] })).toThrow(/duplicate/);
    expect(() => run({ asOfMs: T - 1, snapshot: { ...input().snapshot, asOfMs: T - 1 } })).toThrow(/future/);
  });

  it('deducts linked refunds from backing and suspends existing allocations above the reduced cash', () => {
    expect(run({ reversals: [refund()], allocations: [allocation({ micros: 570_000 })] })).toMatchObject({ ok: true });
    expect(run({ reversals: [refund()], allocations: [allocation({ micros: 570_001 })] })).toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(run({ reversals: [refund('txn_refund', 100)], allocations: [] })).toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('deducts chargeback fees as well as the disputed principal', () => {
    expect(run({ reversals: [refund('txn_dispute', 30, 2, 0, true)], allocations: [allocation({ micros: 550_000 })] })).toMatchObject({ ok: true });
    expect(run({ reversals: [refund('txn_dispute', 30, 2, 0, true)], allocations: [allocation({ micros: 550_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('releases only documented returned tax from the withheld tax portion', () => {
    expect(run({ reversals: [refund('txn_refund', 30, 0, 10)], allocations: [allocation({ micros: 670_000 })] })).toMatchObject({ ok: true });
    expect(run({ reversals: [refund('txn_refund', 30, 0, 10)], allocations: [allocation({ micros: 670_001 })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(() => run({ reversals: [refund('txn_refund', 30, 0, 11)] })).toThrow(/refund fee or tax/);
    expect(() => run({ reversals: [refund('txn_refund', 20, 0, 6), refund('txn_refund2', 20, 0, 5)] })).toThrow(/refund fee or tax/);
  });

  it('requires an authenticated original-source link and rejects replayed reversal postings', () => {
    expect(run({ reversals: [{ ...refund(), paymentTransactionId: 'txn_missing' }] })).toEqual({ ok: false, reason: 'unmatched-reversal' });
    expect(() => run({ reversals: [refund(), refund()] })).toThrow(/duplicate/);
  });

  it('does not round fractional allocations before checking source capacity', () => {
    expect(run({ allocations: [allocation({ micros: 869_999, microsExact: '869999.9999999999999999999' }),
      allocation({ allocationId: 'tiny', micros: 0, microsExact: '0.0000000000000000001' })] }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 870_000 } });
    expect(run({ allocations: [allocation({ micros: 870_000 }),
      allocation({ allocationId: 'tiny', micros: 0, microsExact: '0.0000000000000000001' })] }))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
  });

  it('aggregates exact old liabilities before netting each organization/workspace allowance', () => {
    expect(run({ priorCharges: [charge({ micros: 0, microsExact: '0.6' }), charge({ chargeId: 'charge-b', micros: 0, microsExact: '0.6' })] }))
      .toEqual({ ok: true, organization: { fundedMicros: 499_998, fundedMicrosExact: '499998.8' },
        workspace: { fundedMicros: 499_998, fundedMicrosExact: '499998.8' }, evidenceRef: 'stripe:census-a' });
  });

  it('retains sibling workspace spend in the organization total while netting only the requested workspace', () => {
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', customerWorkspaceId: 'ws-b', micros: 300_000 })],
      priorCharges: [charge(), charge({ chargeId: 'charge-b', customerWorkspaceId: 'ws-b', micros: 200_000 })] }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 500_000 }, workspace: { fundedMicros: 400_000 } });
  });

  it('cannot conceal another key or workspace overspend by changing the requested scope', () => {
    expect(run({ priorCharges: [charge({ budgetKey: 'storage.usd_cents', micros: 1 })] })).toEqual({ ok: false, reason: 'funding-overspent' });
    expect(run({ allocations: [allocation(), allocation({ allocationId: 'grant-b', customerWorkspaceId: 'ws-b', micros: 300_000 })],
      priorCharges: [charge({ customerWorkspaceId: 'ws-b', micros: 300_001 })] })).toEqual({ ok: false, reason: 'funding-overspent' });
  });

  it.each([{ providerFinal: false }, { periodEndMs: START + 1 }, { costSource: 'provider-reported' as 'provider-billed' }])
    ('refuses a prior charge that is not an earlier final bill (%j)', change => {
      expect(() => run({ priorCharges: [charge(change)] })).toThrow(/prior prepaid charge/);
    });

  it('rejects duplicate/conflicting allocation or bill ids instead of treating them as new funding/spend', () => {
    expect(() => run({ allocations: [allocation(), allocation({ micros: 1 })] })).toThrow(/duplicate/);
    expect(() => run({ priorCharges: [charge(), charge({ micros: 1 })] })).toThrow(/duplicate/);
    expect(run({ priorCharges: [charge({ organizationId: 'org-b' })] })).toEqual({ ok: false, reason: 'funding-scope-mismatch' });
  });

  it.each(['500000.00', '500001.1', '-1', '1e-3', '9007199254740991.1'])('rejects unsafe or noncanonical exact allocation %s', microsExact => {
    expect(() => run({ allocations: [allocation({ microsExact })] })).toThrow();
  });

  it('feeds exact net funding into the existing admission policy without turning a large cap into money', () => {
    const funding = run({ allocations: [allocation({ micros: 1 })], priorCharges: [charge({ micros: 0, microsExact: '0.1' })] });
    if (!funding.ok) throw new Error(funding.reason);
    const decision = evaluateHostedBudget({ entitlements: { budgets: { [KEY]: 10_000 } },
      policy: { policyId: 'policy-a', revision: 1, budgetKey: KEY, effectiveFromMs: START, effectiveUntilMs: END, warningBps: 8000 },
      position: { ...funding.organization, spentMicros: 0, openReservedMicros: 0, retainedReserveMicros: 0, unreconciled: false },
      maximumCostMicros: 1, asOfMs: T });
    expect(decision).toMatchObject({ admitted: false, reason: 'budget-exhausted', capMicros: 0, capMicrosExact: '0.9' });
  });

  it('requires independently verified pool backing in addition to a valid customer receipt', () => {
    expect(run({ cashBacking: null })).toEqual({ ok: false, reason: 'unverified-cash-backing' });
    expect(run({ cashBacking: cash([payment().entry]) })).toEqual({ ok: false, reason: 'insufficient-cash-backing' });
    // The processor fee leaves cash below the face value of the credits owed.
    expect(run({ cashBacking: cash([capital, payment().entry]) })).toMatchObject({ ok: true });
  });

  it.each(['livemode', 'complete'] as const)('refuses cash evidence without verified %s', field => {
    expect(run({ cashBacking: { ...input().cashBacking!, [field]: false } }))
      .toEqual({ ok: false, reason: 'unverified-cash-backing' });
  });

  it.each(['controlWorkspaceId', 'stripeAccountId', 'evidenceRef'] as const)('refuses unbound cash %s', field => {
    expect(run({ cashBacking: { ...input().cashBacking!, [field]: '' } }))
      .toEqual({ ok: false, reason: 'unverified-cash-backing' });
  });

  it.each([-1, 1])('refuses cash evidence at a different cutoff (%s)', delta => {
    expect(run({ cashBacking: { ...input().cashBacking!, asOfMs: T + delta } }))
      .toEqual({ ok: false, reason: 'unverified-cash-backing' });
  });

  it('refuses unknown retained exposure and insufficient independent liquid cash', () => {
    expect(run({ cashBacking: { ...input().cashBacking!, retainedReserveMicros: null } }))
      .toEqual({ ok: false, reason: 'unverified-cash-backing' });
    expect(run({ cashBacking: { ...input().cashBacking!, availableMicros: 999_999 } }))
      .toEqual({ ok: false, reason: 'insufficient-cash-backing' });
  });

  it('includes every customer credit obligation rather than only this customer allocation', () => {
    const other = payment('txn_other', 10_000, 0, 0).entry;
    expect(run({ cashBacking: cash([capital, payment().entry, other]) }))
      .toEqual({ ok: false, reason: 'insufficient-cash-backing' });
    expect(run({ cashBacking: cash([capital, payment().entry, other], { availableMicros: 101_000_000 }) }))
      .toMatchObject({ ok: true });
  });

  it.each([10_001, 10_098])('subtracts %s cents of provider outflows before admitting valid allocations', amountCents => {
    const paid = journal('bank-provider', { kind: 'provider-payment', amountCents });
    expect(run({ cashBacking: cash([capital, payment().entry, paid]) }))
      .toEqual({ ok: false, reason: 'insufficient-cash-backing' });
  });

  it('does not offset another obligation using a debit refund-provision balance', () => {
    const refundDebit = refund().entry;
    expect(run({ cashBacking: cash([capital, payment().entry, refundDebit], { availableMicros: 900_000 }) }))
      .toEqual({ ok: false, reason: 'insufficient-cash-backing' });
  });

  it('reserves tax, DAO and refund obligations without treating subscription revenue as prepaid funding', () => {
    const other = payment('txn_subscription', 10_000, 0, 0,
      { kind: 'customer-payment', grossCents: 10_000, feeCents: 0, taxCents: 3000, daoCents: 3000, refundReserveCents: 4000 }).entry;
    expect(run({ cashBacking: cash([capital, payment().entry, other]) }))
      .toEqual({ ok: false, reason: 'insufficient-cash-backing' });
    expect(run({ cashBacking: cash([capital, payment().entry, other], { availableMicros: 101_000_000 }) }))
      .toMatchObject({ ok: true, organization: { fundedMicros: 500_000 } });
  });

  it('aggregates exact unpaid costs and continuing exposure before comparing backing', () => {
    const backing = cash([capital, payment().entry], { availableMicros: 1_000_001,
      unpaidProviderMicros: 0, unpaidProviderMicrosExact: '0.6', retainedReserveMicros: 1 });
    expect(run({ cashBacking: backing })).toEqual({ ok: false, reason: 'insufficient-cash-backing' });
    expect(run({ cashBacking: { ...backing, availableMicros: 1_000_002 } })).toMatchObject({ ok: true });
    expect(run({ cashBacking: { ...backing, retainedReserveMicros: 0, availableMicrosExact: '1000001.6' } }))
      .toMatchObject({ ok: true });
  });

  it.each(['9007199254740991.1', '100000000.0', '-1', '1e6'])('rejects unsafe/noncanonical exact cash %s', availableMicrosExact => {
    expect(() => run({ cashBacking: { ...input().cashBacking!, availableMicrosExact } })).toThrow(/micro amount/);
  });

  it('does not accept scoped source postings absent from or changed in the global journal', () => {
    expect(() => run({ cashBacking: cash([capital]) })).toThrow(/prepaid posting mismatch/);
    const p = payment().entry;
    expect(() => run({ cashBacking: cash([capital, { ...p, lines: capital.lines }]) })).toThrow(/prepaid posting mismatch/);
  });

  it.each(['duplicate', 'reference-replay', 'future', 'currency', 'unbalanced'] as const)('refuses %s cash journal evidence', kind => {
    const p = payment().entry;
    const entries = kind === 'duplicate' ? [capital, p, p]
      : kind === 'reference-replay' ? [capital, p, { ...p, entryId: 'alias' }]
      : [capital, { ...p, ...(kind === 'future' ? { occurredAtMs: T + 1 }
        : kind === 'currency' ? { currency: 'EUR' }
        : { lines: p.lines.slice(1) }) }];
    expect(() => run({ cashBacking: cash(entries) })).toThrow(/cash backing/);
  });
});

function stripeRead(changes: Partial<HostedStripeFundingRead> = {}): HostedStripeFundingRead {
  const created = (T - 1000) / 1000;
  const bt: StripeObservedBalanceTransaction = { object: 'balance_transaction', id: 'txn_Charge', type: 'charge',
    amount: 100, fee: 3, net: 97, currency: 'usd', created, status: 'available', available_on: created,
    source: { object: 'charge', id: 'ch_A', customer: 'cus_A', metadata: { purpose: 'prepaid-credits' }, invoice: null } };
  const built = journalEntryForMovement({ entryId: 'stripe-bt:txn_Charge', occurredAtMs: created * 1000,
    currency: 'USD', externalRef: { kind: 'stripe-balance-transaction', id: 'txn_Charge' },
    movement: { kind: 'credit-purchase', grossCents: 100, feeCents: 3, taxCents: 0 } });
  if (!built.ok) throw new Error('fixture');
  const transaction = { id: bt.id, amount: bt.amount, fee: bt.fee, currency: bt.currency, created };
  const salt = 'a'.repeat(64);
  const sources = { accountId: 'acct_A', livemode: true, requestIds: ['req_Source'], evidenceRef: 'stripe:sources',
    charges: [{ id: 'ch_A', customerId: 'cus_A', currency: 'usd', amountCents: 100, capturedCents: 100,
      refundedCents: 0, paid: true, captured: true, status: 'succeeded', created,
      balanceTransactionId: bt.id, failureBalanceTransactionId: null }], refunds: [], disputes: [] };
  const tx = { accountId: 'acct_A', requestIds: ['req_Transactions'], evidenceRef: 'stripe:transactions', transactions: [bt] };
  const cashEvidence = { accountId: 'acct_A', customerId: 'cus_A', organizationId: 'org-a', livemode: true,
    availableUsdCents: 97, pendingUsdCents: 0, requestIds: ['req_Cash'], evidenceRef: 'stripe:cash' };
  return { scope, accountId: 'acct_A', customerId: 'cus_A', asOfMs: T, maximumAgeMs: 1000,
    policy: { daoBasisPoints: 0, refundReserveBasisPoints: 0 },
    cashBefore: { ...cashEvidence, observedAtMs: T - 9 }, cashAfter: { ...cashEvidence, observedAtMs: T - 1 },
    sourcesBefore: { ...sources, collectionStartedAtMs: T - 8, observedAtMs: T - 7 },
    sourcesAfter: { ...sources, collectionStartedAtMs: T - 3, observedAtMs: T - 2 },
    transactionsBefore: { ...tx, observedAtMs: T - 6 }, transactionsAfter: { ...tx, observedAtMs: T - 4 },
    lineages: [{ accountId: 'acct_A', customerId: 'cus_A', organizationId: 'org-a', livemode: true,
      charge: { id: 'ch_A', capturedUsdCents: 100, refundedUsdCents: 0, balanceTransaction: bt },
      source: { kind: 'charge', id: 'ch_A', status: 'succeeded', amountUsdCents: 100, balanceTransactions: [bt] },
      observedAtMs: T - 5, requestIds: ['req_Lineage'], evidenceRef: 'stripe:lineage' }],
    entries: [built.entry], receipts: [{ transaction, salt, commitment: receiptCommitment(transaction, salt),
      receiptSeq: 1, sourceId: 'ch_A', sourceCustomer: 'cus_A' }], ...changes };
}

function collection(s = stripeRead()): HostedStripeFundingCollection {
  return { scope: s.scope, accountId: s.accountId, customerId: s.customerId, maximumAgeMs: s.maximumAgeMs,
    policy: s.policy, entries: s.entries, receipts: s.receipts,
    customers: [...new Map(s.lineages.map(l => [l.customerId,
      { stripeCustomerId: l.customerId, organizationId: l.organizationId, livemode: true }])).values()] };
}
function collectorClient(s = stripeRead(), options: { failAt?: number; throwAt?: number; beforeRead?: (index: number) => void } = {}) {
  const steps = [
    { kind: 'cash', evidence: s.cashBefore }, { kind: 'sources', evidence: s.sourcesBefore },
    { kind: 'transactions', evidence: s.transactionsBefore },
    ...s.lineages.map(evidence => ({ kind: 'lineage', evidence })),
    { kind: 'transactions', evidence: s.transactionsAfter }, { kind: 'sources', evidence: s.sourcesAfter },
    { kind: 'cash', evidence: s.cashAfter },
  ];
  const calls: { kind: string; args: unknown }[] = [];
  async function take<T>(kind: string, args: unknown): Promise<{ ok: true; evidence: T }
    | { ok: false; code: 'provider-error'; status: number; detail: string }> {
    const index = calls.length;
    calls.push({ kind, args: structuredClone(args) });
    expect(steps[index]?.kind).toBe(kind);
    options.beforeRead?.(index);
    if (options.throwAt === index) throw new Error('upstream secret must not escape');
    if (options.failAt === index) return { ok: false, code: 'provider-error', status: 503, detail: 'upstream secret must not escape' };
    return { ok: true, evidence: steps[index]!.evidence as T };
  }
  const client: HostedStripeFundingCollectorClient = {
    livemode: true,
    readAccountCash: vi.fn(args => take<HostedStripeFundingRead['cashBefore']>('cash', args)),
    readAccountPaymentSources: vi.fn(args => take<HostedStripeFundingRead['sourcesBefore']>('sources', args)),
    readAccountTransactions: vi.fn(args => take<HostedStripeFundingRead['transactionsBefore']>('transactions', args)),
    readPaymentLineage: vi.fn(args => take<HostedStripeFundingRead['lineages'][number]>('lineage', args)),
  };
  return { client, calls };
}

describe('authenticated Stripe funding collection (locked server population still required)', () => {
  it('collects brackets in order and pins the original stored receipt before reconciliation', async () => {
    const s = stripeRead(); const { client, calls } = collectorClient(s);
    const result = await collectHostedStripeFunding(collection(s), { client, now: () => T });
    expect(result).toEqual(reconcileHostedStripeFunding(s));
    expect(calls.map(c => c.kind)).toEqual(['cash', 'sources', 'transactions', 'lineage', 'transactions', 'sources', 'cash']);
    expect(calls[3]!.args).toEqual({ accountId: 'acct_A', customerId: 'cus_A', organizationId: 'org-a',
      chargeId: 'ch_A', chargeBalanceTransactionId: 'txn_Charge', source: { kind: 'charge', id: 'ch_A' } });
    if (!result.ok) throw new Error('fixture');
    expect(evaluateHostedPrepaidFunding(input({ ...result, allocations: [], cashBacking: null })))
      .toEqual({ ok: false, reason: 'unverified-cash-backing' });
    expect(Object.isFrozen(result.payments[0]!.receipt.transaction)).toBe(true);
  });
  it.each([0, 1, 2, 3, 4, 5, 6])('refuses provider error at stage %s without granting a partial read', async failAt => {
    const { client, calls } = collectorClient(stripeRead(), { failAt });
    expect(await collectHostedStripeFunding(collection(), { client, now: () => T }))
      .toEqual({ ok: false, reason: 'unverified-stripe-read' });
    expect(calls).toHaveLength(failAt + 1);
  });
  it.each([0, 1, 2, 3, 4, 5, 6])('refuses thrown provider error at stage %s without leaking its message', async throwAt => {
    const { client } = collectorClient(stripeRead(), { throwAt });
    expect(await collectHostedStripeFunding(collection(), { client, now: () => T }))
      .toEqual({ ok: false, reason: 'unverified-stripe-read' });
  });
  it.each(['missing', 'foreign', 'test', 'duplicate'] as const)('refuses %s persisted customer binding before a provider call', async variant => {
    const { client, calls } = collectorClient(); const c = collection();
    const customers = variant === 'missing' ? [] : variant === 'foreign' ? [{ ...c.customers[0]!, organizationId: 'org-b' }]
      : variant === 'test' ? [{ ...c.customers[0]!, livemode: false }] : [c.customers[0]!, c.customers[0]!];
    expect(await collectHostedStripeFunding({ ...c, customers }, { client, now: () => T }))
      .toEqual({ ok: false, reason: 'unverified-stripe-read' });
    expect(calls).toHaveLength(0);
  });
  it('refuses a test-mode client before any network operation', async () => {
    const { client, calls } = collectorClient();
    expect(await collectHostedStripeFunding(collection(), { client: { ...client, livemode: false } }))
      .toEqual({ ok: false, reason: 'unverified-stripe-read' });
    expect(calls).toHaveLength(0);
  });
  it.each(['missing', 'source', 'customer', 'duplicate'] as const)('refuses %s original receipt pins before lineage collection', async variant => {
    const c = collection(); const r = c.receipts[0]!;
    const receipts = variant === 'missing' ? [] : variant === 'source' ? [{ ...r, sourceId: 'ch_Wrong' }]
      : variant === 'customer' ? [{ ...r, sourceCustomer: 'cus_Wrong' }] : [r, r];
    const { client, calls } = collectorClient();
    expect(await collectHostedStripeFunding({ ...c, receipts }, { client, now: () => T }))
      .toEqual({ ok: false, reason: 'unreconciled-stripe-source' });
    expect(calls.map(x => x.kind)).not.toContain('lineage');
  });
  it('snapshots the local inputs before the first await', async () => {
    const c = structuredClone(collection());
    const { client, calls } = collectorClient(stripeRead(), { beforeRead: i => {
      if (i === 0) { (c.scope as { organizationId: string }).organizationId = 'org-other';
        (c.receipts[0]! as { sourceId: string }).sourceId = 'ch_Other'; }
    } });
    expect(await collectHostedStripeFunding(c, { client, now: () => T })).toMatchObject({ ok: true,
      snapshot: { organizationId: 'org-a' } });
    expect(calls[3]!.args).toMatchObject({ organizationId: 'org-a', chargeId: 'ch_A' });
  });
  it('detaches the before census when a client reuses and changes its response objects', async () => {
    const s = stripeRead();
    const { client } = collectorClient(s, { beforeRead: i => {
      if (i === 5) (s.sourcesAfter.charges[0]! as { capturedCents: number }).capturedCents = 99;
    } });
    expect(await collectHostedStripeFunding(collection(s), { client, now: () => T }))
      .toEqual({ ok: false, reason: 'stripe-read-changed' });
  });
  it.each([T - 2, T + 1001, NaN])('refuses observations outside the server completion clock %s', async timestamp => {
    expect(await collectHostedStripeFunding(collection(), { client: collectorClient().client, now: () => timestamp }))
      .toEqual({ ok: false, reason: 'unverified-stripe-read' });
  });
  it('collects another customer with its own persisted organization and refuses a missing foreign binding', async () => {
    const s = stripeRead(); const original = s.transactionsAfter.transactions[0]!;
    const bt: StripeObservedBalanceTransaction = { ...original, id: 'txn_Other',
      source: { object: 'charge', id: 'ch_Other', customer: 'cus_Other', metadata: { purpose: 'prepaid-credits' }, invoice: null } };
    const built = journalEntryForMovement({ entryId: 'stripe-bt:txn_Other', occurredAtMs: bt.created * 1000,
      currency: 'USD', externalRef: { kind: 'stripe-balance-transaction', id: bt.id },
      movement: { kind: 'credit-purchase', grossCents: 100, feeCents: 3, taxCents: 0 } });
    if (!built.ok) throw new Error('fixture');
    const transaction = { ...s.receipts[0]!.transaction, id: bt.id };
    const r = { ...s.receipts[0]!, transaction, sourceId: 'ch_Other', sourceCustomer: 'cus_Other',
      commitment: receiptCommitment(transaction, s.receipts[0]!.salt) };
    const charge = { ...s.sourcesBefore.charges[0]!, id: 'ch_Other', customerId: 'cus_Other', balanceTransactionId: bt.id };
    const l = { ...s.lineages[0]!, customerId: 'cus_Other', organizationId: 'org-other',
      charge: { ...s.lineages[0]!.charge, id: charge.id, balanceTransaction: bt },
      source: { ...s.lineages[0]!.source, id: charge.id, balanceTransactions: [bt] } };
    const full = stripeRead({ sourcesBefore: { ...s.sourcesBefore, charges: [...s.sourcesBefore.charges, charge] },
      sourcesAfter: { ...s.sourcesAfter, charges: [...s.sourcesAfter.charges, charge] },
      transactionsBefore: { ...s.transactionsBefore, transactions: [original, bt] },
      transactionsAfter: { ...s.transactionsAfter, transactions: [original, bt] },
      entries: [...s.entries, built.entry], receipts: [...s.receipts, r], lineages: [...s.lineages, l] });
    const { client, calls } = collectorClient(full);
    const result = await collectHostedStripeFunding(collection(full), { client, now: () => T });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('fixture');
    expect(result.payments).toHaveLength(1);
    expect(calls[4]!.args).toMatchObject({ customerId: 'cus_Other', organizationId: 'org-other', chargeId: 'ch_Other' });
    expect(await collectHostedStripeFunding({ ...collection(full), customers: collection(s).customers },
      { client: collectorClient(full).client, now: () => T })).toEqual({ ok: false, reason: 'unreconciled-stripe-source' });
    expect(await collectHostedStripeFunding(collection(full),
      { client: collectorClient(full).client, now: () => T, maximumLineages: 1 }))
      .toEqual({ ok: false, reason: 'unreconciled-stripe-source' });
  });
  it('collects successful refunds with the original charge pins and preserves linked backing reductions', async () => {
    const s = stripeRead(); const original = s.transactionsBefore.transactions[0]!;
    const bt: StripeObservedBalanceTransaction = { ...original, id: 'txn_Refund', type: 'refund', amount: -30, fee: 0, net: -30,
      source: { object: 'refund', id: 're_A', customer: 'cus_A' } };
    const built = journalEntryForMovement({ entryId: 'stripe-bt:txn_Refund', occurredAtMs: bt.created * 1000, currency: 'USD',
      externalRef: { kind: 'stripe-balance-transaction', id: bt.id }, movement: { kind: 'refund', amountCents: 30, taxCents: 0 } });
    if (!built.ok) throw new Error('fixture');
    const transaction = { id: bt.id, amount: bt.amount, fee: bt.fee, currency: bt.currency, created: bt.created };
    const r = { ...s.receipts[0]!, transaction, sourceId: 're_A', commitment: receiptCommitment(transaction, s.receipts[0]!.salt) };
    const charge = { ...s.sourcesBefore.charges[0]!, refundedCents: 30 };
    const refund = { id: 're_A', chargeId: 'ch_A', currency: 'usd', amountCents: 30, status: 'succeeded', created: bt.created,
      balanceTransactionId: bt.id, failureBalanceTransactionId: null };
    const chargeLineage = { ...s.lineages[0]!, charge: { ...s.lineages[0]!.charge, refundedUsdCents: 30 } };
    const refundLineage = { ...chargeLineage, source: { kind: 'refund' as const, id: 're_A', status: 'succeeded',
      amountUsdCents: 30, balanceTransactions: [bt] } };
    const full = stripeRead({ sourcesBefore: { ...s.sourcesBefore, charges: [charge], refunds: [refund] },
      sourcesAfter: { ...s.sourcesAfter, charges: [charge], refunds: [refund] },
      transactionsBefore: { ...s.transactionsBefore, transactions: [original, bt] },
      transactionsAfter: { ...s.transactionsAfter, transactions: [original, bt] },
      entries: [...s.entries, built.entry], receipts: [...s.receipts, r], lineages: [chargeLineage, refundLineage] });
    const { client, calls } = collectorClient(full);
    expect(await collectHostedStripeFunding(collection(full), { client, now: () => T }))
      .toMatchObject({ ok: true, reversals: [{ paymentTransactionId: 'txn_Charge' }] });
    expect(calls[4]!.args).toMatchObject({ chargeId: 'ch_A', chargeBalanceTransactionId: 'txn_Charge',
      source: { kind: 'refund', id: 're_A' } });
  });
  it('never treats an unsupported dispute population as permission to spend', async () => {
    const s = stripeRead(); const dispute = { id: 'dp_A', chargeId: 'ch_A', currency: 'usd', amountCents: 100,
      status: 'won', created: (T - 1000) / 1000, balanceTransactionIds: [] };
    const { client, calls } = collectorClient({ ...s, sourcesBefore: { ...s.sourcesBefore, disputes: [dispute] } });
    expect(await collectHostedStripeFunding(collection(s), { client, now: () => T }))
      .toEqual({ ok: false, reason: 'unreconciled-stripe-source' });
    expect(calls).toHaveLength(3);
  });

  it.each([0, -1, 0.5, NaN, Infinity, 10_001])('rejects an invalid whole-collection deadline %s', async maximumDurationMs => {
    const { client, calls } = collectorClient();
    await expect(collectHostedStripeFunding(collection(), { client, maximumDurationMs })).rejects.toThrow('invalid Stripe funding collection');
    expect(calls).toHaveLength(0);
  });

  it('shares one cancellation signal through every account, census and lineage read', async () => {
    const { client } = collectorClient();
    const parent = new AbortController();
    expect(await collectHostedStripeFunding(collection(), { client, now: () => T, signal: parent.signal })).toMatchObject({ ok: true });
    const signals = [client.readAccountCash, client.readAccountPaymentSources, client.readAccountTransactions,
      client.readPaymentLineage].flatMap(fn => vi.mocked(fn).mock.calls.map(call => call[1]));
    expect(signals).toHaveLength(7);
    expect(signals.every(signal => signal instanceof AbortSignal && signal === signals[0])).toBe(true);
    parent.abort();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('refuses a pre-cancelled collection without reading any provider stage', async () => {
    const { client, calls } = collectorClient();
    const parent = new AbortController(); parent.abort(new Error('private cancellation'));
    expect(await collectHostedStripeFunding(collection(), { client, signal: parent.signal }))
      .toEqual({ ok: false, reason: 'unverified-stripe-read' });
    expect(calls).toHaveLength(0);
  });

  it('uses one deadline across successive reads instead of restarting it for each stage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const { client, calls } = collectorClient();
      let cancelled = false;
      const delay = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        if (!signal) throw new Error('missing transport cancellation');
        signal.throwIfAborted();
        const abort = () => { cancelled = true; clearTimeout(timer); reject(new Error('private cancellation')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 6);
        signal.addEventListener('abort', abort, { once: true });
      });
      const delayed: HostedStripeFundingCollectorClient = {
        livemode: true,
        readAccountCash: async (args, signal) => { await delay(signal); return client.readAccountCash(args, signal); },
        readAccountPaymentSources: async (args, signal) => { await delay(signal); return client.readAccountPaymentSources(args, signal); },
        readAccountTransactions: async (args, signal) => { await delay(signal); return client.readAccountTransactions(args, signal); },
        readPaymentLineage: async (args, signal) => { await delay(signal); return client.readPaymentLineage(args, signal); },
      };
      const pending = collectHostedStripeFunding(collection(), { client: delayed, now: () => T, maximumDurationMs: 20 });
      await vi.advanceTimersByTimeAsync(19);
      expect(calls.map(call => call.kind)).toEqual(['cash', 'sources', 'transactions']);
      expect(cancelled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: false, reason: 'unverified-stripe-read' });
      expect(cancelled).toBe(true);
      expect(calls).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['final-read', 'reconciliation'] as const)('refuses completion past the monotonic collection deadline at %s before timer delivery', async phase => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const { client, calls } = collectorClient(stripeRead(), { beforeRead: index => { if (phase === 'final-read' && index === 6) elapsed = 20; } });
      expect(await collectHostedStripeFunding(collection(), { client, now: () => { if (phase === 'reconciliation') elapsed = 20; return T; }, maximumDurationMs: 20 }))
        .toEqual({ ok: false, reason: 'unverified-stripe-read' });
      expect(calls).toHaveLength(7);
    } finally { clock.mockRestore(); }
  });
});

describe('Stripe funding reconciliation against the complete journal and receipt population', () => {
  const rejected = (changes: Partial<HostedStripeFundingRead>, reason: string) =>
    expect(reconcileHostedStripeFunding(stripeRead(changes))).toEqual({ ok: false, reason });

  it('derives scoped prepaid inputs from matched current evidence, while cash authority remains separate', () => {
    const s = stripeRead(); const result = reconcileHostedStripeFunding(s);
    expect(result).toMatchObject({ ok: true, payments: [{ available: true }], reversals: [],
      snapshot: { stripeAccountId: 'acct_A', stripeCustomerId: 'cus_A', complete: true, asOfMs: T },
      evidenceRef: expect.stringMatching(/^stripe-funding-read:[a-f0-9]{64}$/) });
    if (!result.ok) throw new Error('fixture');
    const prepaid = input({ ...result, allocations: [allocation({ paymentTransactionId: 'txn_Charge', micros: 970_000 })],
      cashBacking: null });
    expect(evaluateHostedPrepaidFunding(prepaid)).toEqual({ ok: false, reason: 'unverified-cash-backing' });
    // Matching Stripe evidence still cannot cover credit obligations larger
    // than actual pool cash (the payment fee consumed three cents).
    expect(evaluateHostedPrepaidFunding({ ...prepaid, cashBacking: cash(s.entries, { availableMicros: 970_000 }) }))
      .toEqual({ ok: false, reason: 'insufficient-cash-backing' });
  });

  it.each(['cashBefore', 'cashAfter', 'sourcesBefore', 'sourcesAfter', 'transactionsBefore', 'transactionsAfter'] as const)
    ('requires fresh pinned %s evidence', field => {
      const s = stripeRead();
      rejected({ [field]: { ...s[field], accountId: 'acct_Other' } }, 'unverified-stripe-read');
      rejected({ [field]: { ...s[field], observedAtMs: T - 1001 } }, 'unverified-stripe-read');
      rejected({ [field]: { ...s[field], observedAtMs: T + 1 } }, 'unverified-stripe-read');
      rejected({ [field]: { ...s[field], evidenceRef: '' } }, 'unverified-stripe-read');
    });

  it('requires live customer/org cash pins and ordered bracketing around every lineage read', () => {
    const s = stripeRead();
    for (const change of [{ customerId: 'cus_Other' }, { organizationId: 'org-b' }, { livemode: false }]) {
      rejected({ cashBefore: { ...s.cashBefore, ...change } }, 'unverified-stripe-read');
      rejected({ cashAfter: { ...s.cashAfter, ...change } }, 'unverified-stripe-read');
    }
    rejected({ sourcesAfter: { ...s.sourcesAfter, livemode: false } }, 'unverified-stripe-read');
    rejected({ sourcesBefore: { ...s.sourcesBefore, collectionStartedAtMs: T - 10 } }, 'unverified-stripe-read');
    rejected({ sourcesAfter: { ...s.sourcesAfter, collectionStartedAtMs: T - 5 } }, 'unverified-stripe-read');
    rejected({ lineages: [{ ...s.lineages[0]!, observedAtMs: T - 7 }] }, 'unverified-stripe-read');
    rejected({ lineages: [{ ...s.lineages[0]!, observedAtMs: T - 3 }] }, 'unverified-stripe-read');
  });

  it('detects changed source states, transaction state and liquid cash during collection', () => {
    const s = stripeRead();
    rejected({ sourcesAfter: { ...s.sourcesAfter, charges: [{ ...s.sourcesAfter.charges[0]!, refundedCents: 1 }] } }, 'stripe-read-changed');
    rejected({ transactionsAfter: { ...s.transactionsAfter, transactions: [{ ...s.transactionsAfter.transactions[0]!, status: 'pending' }] } }, 'stripe-read-changed');
    rejected({ cashAfter: { ...s.cashAfter, availableUsdCents: 96 } }, 'stripe-read-changed');
    rejected({ cashAfter: { ...s.cashAfter, pendingUsdCents: 1 } }, 'stripe-read-changed');
  });

  it('refuses missing, aliased, future or balanced-but-wrong postings and omitted receipt history', () => {
    const s = stripeRead();
    rejected({ entries: [] }, 'unreconciled-stripe-movement');
    rejected({ entries: [...s.entries, { ...s.entries[0]!, entryId: 'alias' }] }, 'unreconciled-stripe-movement');
    rejected({ entries: [{ ...s.entries[0]!, occurredAtMs: T + 1 }] }, 'unreconciled-stripe-movement');
    rejected({ entries: [{ ...s.entries[0]!, lines: [{ account: 'operating', side: 'debit', cents: 100 },
      { account: 'customer-credit-reserve', side: 'credit', cents: 100 }] }] }, 'unreconciled-stripe-movement');
    rejected({ receipts: [] }, 'unreconciled-stripe-receipt');
    rejected({ receipts: [...s.receipts, s.receipts[0]!] }, 'unreconciled-stripe-receipt');
    rejected({ receipts: [{ ...s.receipts[0]!, sourceId: 'ch_Other' }] }, 'unreconciled-stripe-receipt');
    rejected({ receipts: [{ ...s.receipts[0]!, commitment: '0'.repeat(64) }] }, 'unreconciled-stripe-receipt');
  });

  it('requires exact current lineage, customer ownership and accounting pins', () => {
    const s = stripeRead(); const l = s.lineages[0]!;
    rejected({ lineages: [] }, 'unreconciled-stripe-source');
    rejected({ lineages: [l, l] }, 'unreconciled-stripe-source');
    rejected({ lineages: [{ ...l, organizationId: 'org-b' }] }, 'unreconciled-stripe-source');
    rejected({ lineages: [{ ...l, customerId: 'cus_Other' }] }, 'unreconciled-stripe-source');
    rejected({ lineages: [{ ...l, charge: { ...l.charge, capturedUsdCents: 101 } }] }, 'unreconciled-stripe-source');
    rejected({ lineages: [{ ...l, charge: { ...l.charge, balanceTransaction: { ...l.charge.balanceTransaction, net: 98 } } }] }, 'unreconciled-stripe-source');
    rejected({ receipts: [{ ...s.receipts[0]!, sourceCustomer: 'cus_Other' }] }, 'unreconciled-stripe-receipt');
  });

  it('detects an omitted source transaction even when journal and receipt history were omitted with it', () => {
    const s = stripeRead();
    rejected({ transactionsBefore: { ...s.transactionsBefore, transactions: [] },
      transactionsAfter: { ...s.transactionsAfter, transactions: [] }, entries: [], receipts: [] }, 'unreconciled-stripe-source');
  });

  it.each(['pending', 'requires_action', 'succeeded'])('refuses an unposted %s refund anywhere in the shared pool', status => {
    const s = stripeRead(); const refunds = [{ id: 're_A', chargeId: 'ch_A', currency: 'usd', amountCents: 10,
      status, created: (T - 1000) / 1000, balanceTransactionId: null, failureBalanceTransactionId: null }];
    rejected({ sourcesBefore: { ...s.sourcesBefore, refunds }, sourcesAfter: { ...s.sourcesAfter, refunds } }, 'unreconciled-stripe-source');
  });

  it('requires the successful refund population to sum to the current original charge total', () => {
    const s = stripeRead(); const charges = [{ ...s.sourcesAfter.charges[0]!, refundedCents: 1 }];
    const lineages = [{ ...s.lineages[0]!, charge: { ...s.lineages[0]!.charge, refundedUsdCents: 1 } }];
    rejected({ sourcesBefore: { ...s.sourcesBefore, charges }, sourcesAfter: { ...s.sourcesAfter, charges }, lineages }, 'unreconciled-stripe-source');
  });

  it('does not manufacture postings for payouts or unsupported dispute reinstatements', () => {
    const s = stripeRead(); const extra = { ...s.transactionsAfter.transactions[0]!, id: 'txn_Payout', type: 'payout', amount: -20, fee: 0, net: -20 };
    rejected({ transactionsBefore: { ...s.transactionsBefore, transactions: [...s.transactionsBefore.transactions, extra] },
      transactionsAfter: { ...s.transactionsAfter, transactions: [...s.transactionsAfter.transactions, extra] } }, 'unreconciled-stripe-movement');
    const disputes = [{ id: 'du_A', chargeId: 'ch_A', currency: 'usd', amountCents: 20,
      status: 'won', created: (T - 1000) / 1000, balanceTransactionIds: [] }];
    rejected({ sourcesBefore: { ...s.sourcesBefore, disputes }, sourcesAfter: { ...s.sourcesAfter, disputes } }, 'unreconciled-stripe-source');
  });

  it('derives pending payment availability and lets the existing allocation guard refuse it', () => {
    const s = stripeRead(); const bt = { ...s.transactionsAfter.transactions[0]!, status: 'pending' as const };
    const result = reconcileHostedStripeFunding(stripeRead({
      transactionsBefore: { ...s.transactionsBefore, transactions: [bt] }, transactionsAfter: { ...s.transactionsAfter, transactions: [bt] },
      lineages: [{ ...s.lineages[0]!, charge: { ...s.lineages[0]!.charge, balanceTransaction: bt },
        source: { ...s.lineages[0]!.source, balanceTransactions: [bt] } }],
    }));
    expect(result).toMatchObject({ ok: true, payments: [{ available: false }] });
    if (!result.ok) throw new Error('fixture');
    expect(evaluateHostedPrepaidFunding(input({ ...result,
      allocations: [allocation({ paymentTransactionId: 'txn_Charge' })], cashBacking: cash(s.entries) })))
      .toEqual({ ok: false, reason: 'unavailable-payment' });
  });

  it('requires other customers sharing the pool to have reconciled receipts, postings and lineage', () => {
    const s = stripeRead(); const original = s.transactionsAfter.transactions[0]!;
    const bt = { ...original, id: 'txn_Other', source: { object: 'charge', id: 'ch_Other', customer: 'cus_Other',
      metadata: { purpose: 'prepaid-credits' }, invoice: null } };
    const charge = { ...s.sourcesAfter.charges[0]!, id: 'ch_Other', customerId: 'cus_Other', balanceTransactionId: bt.id };
    const p = s.entries[0]!; const entry = { ...p, entryId: 'stripe-bt:txn_Other',
      externalRef: { kind: 'stripe-balance-transaction' as const, id: bt.id } };
    const transaction = { ...s.receipts[0]!.transaction, id: bt.id };
    const receipt = { ...s.receipts[0]!, transaction, sourceId: 'ch_Other', sourceCustomer: 'cus_Other',
      commitment: receiptCommitment(transaction, s.receipts[0]!.salt) };
    const l = { ...s.lineages[0]!, organizationId: 'org-other', customerId: 'cus_Other',
      charge: { ...s.lineages[0]!.charge, id: 'ch_Other', balanceTransaction: bt },
      source: { ...s.lineages[0]!.source, id: 'ch_Other', balanceTransactions: [bt] } };
    const full = stripeRead({ transactionsBefore: { ...s.transactionsBefore, transactions: [original, bt] },
      transactionsAfter: { ...s.transactionsAfter, transactions: [bt, original] },
      sourcesBefore: { ...s.sourcesBefore, charges: [...s.sourcesBefore.charges, charge] },
      sourcesAfter: { ...s.sourcesAfter, charges: [charge, ...s.sourcesAfter.charges] },
      lineages: [s.lineages[0]!, l], entries: [...s.entries, entry], receipts: [...s.receipts, receipt] });
    const result = reconcileHostedStripeFunding(full);
    expect(result).toMatchObject({ ok: true, payments: [{ receipt: { sourceCustomer: 'cus_A' } }] });
    if (!result.ok) throw new Error('fixture');
    expect(result.payments).toHaveLength(1);
    expect(reconcileHostedStripeFunding({ ...full, entries: s.entries })).toEqual({ ok: false, reason: 'unreconciled-stripe-movement' });
    expect(reconcileHostedStripeFunding({ ...full, receipts: s.receipts })).toEqual({ ok: false, reason: 'unreconciled-stripe-receipt' });
    expect(reconcileHostedStripeFunding({ ...full, lineages: s.lineages })).toEqual({ ok: false, reason: 'unreconciled-stripe-source' });
    const refunds = [{ id: 're_Other', chargeId: 'ch_Other', currency: 'usd', amountCents: 10, status: 'pending',
      created: original.created, balanceTransactionId: null, failureBalanceTransactionId: null }];
    expect(reconcileHostedStripeFunding({ ...full, sourcesBefore: { ...full.sourcesBefore, refunds },
      sourcesAfter: { ...full.sourcesAfter, refunds } })).toEqual({ ok: false, reason: 'unreconciled-stripe-source' });
  });

  it('links a fully posted successful refund to its original prepaid receipt and rejects conflicting totals', () => {
    const s = stripeRead(); const original = s.transactionsAfter.transactions[0]!;
    const bt: StripeObservedBalanceTransaction = { ...original, id: 'txn_Refund', type: 'refund', amount: -30, fee: 0, net: -30,
      source: { object: 'refund', id: 're_A', customer: 'cus_A' } };
    const built = journalEntryForMovement({ entryId: 'stripe-bt:txn_Refund', occurredAtMs: bt.created * 1000,
      currency: 'USD', externalRef: { kind: 'stripe-balance-transaction', id: bt.id },
      movement: { kind: 'refund', amountCents: 30, taxCents: 0 } });
    if (!built.ok) throw new Error('fixture');
    const transaction = { id: bt.id, amount: bt.amount, fee: bt.fee, currency: bt.currency, created: bt.created };
    const r = { ...s.receipts[0]!, transaction, sourceId: 're_A', commitment: receiptCommitment(transaction, s.receipts[0]!.salt) };
    const c = { ...s.sourcesAfter.charges[0]!, refundedCents: 30 };
    const refund = { id: 're_A', chargeId: 'ch_A', currency: 'usd', amountCents: 30, status: 'succeeded',
      created: bt.created, balanceTransactionId: bt.id, failureBalanceTransactionId: null };
    const chargeLineage = { ...s.lineages[0]!, charge: { ...s.lineages[0]!.charge, refundedUsdCents: 30 } };
    const refundLineage = { ...chargeLineage, source: { kind: 'refund' as const, id: 're_A', status: 'succeeded',
      amountUsdCents: 30, balanceTransactions: [bt] } };
    const full = stripeRead({ transactionsBefore: { ...s.transactionsBefore, transactions: [original, bt] },
      transactionsAfter: { ...s.transactionsAfter, transactions: [original, bt] },
      sourcesBefore: { ...s.sourcesBefore, charges: [c], refunds: [refund] },
      sourcesAfter: { ...s.sourcesAfter, charges: [c], refunds: [refund] },
      entries: [...s.entries, built.entry], receipts: [...s.receipts, r], lineages: [chargeLineage, refundLineage] });
    const result = reconcileHostedStripeFunding(full);
    expect(result).toMatchObject({ ok: true, reversals: [{ paymentTransactionId: 'txn_Charge', receipt: { transaction: { id: 'txn_Refund' } } }] });
    if (!result.ok) throw new Error('fixture');
    expect(evaluateHostedPrepaidFunding(input({ ...result, cashBacking: null,
      allocations: [allocation({ paymentTransactionId: 'txn_Charge', micros: 670_001 })] })))
      .toEqual({ ok: false, reason: 'funding-overallocated' });
    expect(evaluateHostedPrepaidFunding(input({ ...result, cashBacking: null,
      allocations: [allocation({ paymentTransactionId: 'txn_Charge', micros: 670_000 })] })))
      .toEqual({ ok: false, reason: 'unverified-cash-backing' });
    expect(reconcileHostedStripeFunding({ ...full, lineages: [chargeLineage,
      { ...refundLineage, source: { ...refundLineage.source, amountUsdCents: 29 } }] })).toEqual({ ok: false, reason: 'unreconciled-stripe-source' });
    expect(reconcileHostedStripeFunding({ ...full, sourcesBefore: { ...full.sourcesBefore, refunds: [refund, refund] },
      sourcesAfter: { ...full.sourcesAfter, refunds: [refund, refund] } })).toEqual({ ok: false, reason: 'unreconciled-stripe-source' });
  });

  it('keeps selected results detached and frozen when caller-owned stored receipt values change', () => {
    const s = stripeRead(); const result = reconcileHostedStripeFunding(s);
    if (!result.ok) throw new Error('fixture');
    const receipt = s.receipts[0]! as { sourceCustomer: string | null; transaction: { amount: number } };
    receipt.sourceCustomer = 'cus_Other'; receipt.transaction.amount = 999;
    expect(result.payments[0]!.receipt).toMatchObject({ sourceCustomer: 'cus_A', transaction: { amount: 100 } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.payments)).toBe(true);
    expect(Object.isFrozen(result.payments[0]!.entry.lines)).toBe(true);
    expect(Object.isFrozen(result.payments[0]!.receipt.transaction)).toBe(true);
  });
});
