/**
 * agent-economy-flywheel-2026-08-30 P-042 / R-30 / D-023: real money movements
 * reach the journal. Each Stripe balance-transaction type maps to one balanced
 * entry carrying its balance-transaction id (or is skipped/unmapped WITH a
 * reason); a treasury transfer maps to a dao-transfer keyed by its tx hash; the
 * importer pages, posts idempotently and never drops a movement silently.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { emptyMoneyJournal, postJournalEntry, trialBalance, type JournalEntry, type MoneyJournalState } from './money-journal';
import {
  PREPAID_CREDITS_PURPOSE,
  importStripeBalanceTransactions,
  journalVerdictForStripeBalanceTransaction,
  journalVerdictForTreasuryTransfer,
  stripeBalanceTransactionLister,
  validatePolicy,
  type JournalPoster,
  type StripeBalanceTransaction,
} from './money-journal-producers';

const POLICY = { daoBasisPoints: 1_000, refundReserveBasisPoints: 500 };
const CREATED = 1_790_000_000;

function bt(over: Partial<StripeBalanceTransaction> & { id: string; type: string; amount: number }): StripeBalanceTransaction {
  return { fee: 0, currency: 'usd', created: CREATED, source: null, ...over };
}

function entryOf(t: StripeBalanceTransaction): JournalEntry {
  const verdict = journalVerdictForStripeBalanceTransaction(t, POLICY);
  if (verdict.disposition !== 'entry') throw new Error(`expected an entry, got ${verdict.disposition}: ${'reason' in verdict ? verdict.reason : ''}`);
  return verdict.entry;
}

function totals(entry: JournalEntry) {
  let debit = 0;
  let credit = 0;
  const byAccount: Record<string, number> = {};
  for (const line of entry.lines) {
    if (line.side === 'debit') debit += line.cents;
    else credit += line.cents;
    byAccount[`${line.account}:${line.side}`] = (byAccount[`${line.account}:${line.side}`] ?? 0) + line.cents;
  }
  return { debit, credit, byAccount };
}

describe('Stripe balance transaction -> journal entry', () => {
  it('a subscription charge books gross, fee, invoice tax, DAO share and refund provision, balanced, keyed by the BT id', () => {
    const entry = entryOf(
      bt({
        id: 'txn_charge1',
        type: 'charge',
        amount: 11_000,
        fee: 349,
        source: { id: 'ch_1', object: 'charge', invoice: { id: 'in_1', total_taxes: [{ amount: 600 }, { amount: 400 }] } },
      }),
    );
    expect(entry.entryId).toBe('stripe-bt:txn_charge1');
    expect(entry.externalRef).toEqual({ kind: 'stripe-balance-transaction', id: 'txn_charge1' });
    expect(entry.movement).toBe('customer-payment');
    expect(entry.currency).toBe('USD');
    expect(entry.occurredAtMs).toBe(CREATED * 1000);
    const { debit, credit, byAccount } = totals(entry);
    expect(debit).toBe(credit);
    // net revenue = 11,000 - 1,000 tax = 10,000; DAO 10% = 1,000; provision 5% = 500
    expect(byAccount['tax-reserve:credit']).toBe(1_000);
    expect(byAccount['dao-payable:credit']).toBe(1_000);
    expect(byAccount['refund-chargeback-reserve:credit']).toBe(500);
    expect(byAccount['provider-cost:debit']).toBe(349);
  });

  it('the older invoice `tax` field is read when total_taxes is absent', () => {
    const entry = entryOf(
      bt({ id: 'txn_old', type: 'charge', amount: 5_000, source: { id: 'ch_2', object: 'charge', invoice: { id: 'in_2', tax: 250 } } }),
    );
    expect(totals(entry).byAccount['tax-reserve:credit']).toBe(250);
  });

  it('a charge whose invoice was not expanded is UNMAPPED, never booked with tax guessed as zero', () => {
    const verdict = journalVerdictForStripeBalanceTransaction(
      bt({ id: 'txn_noexp', type: 'charge', amount: 5_000, source: { id: 'ch_3', object: 'charge', invoice: 'in_3' } }),
      POLICY,
    );
    expect(verdict).toMatchObject({ disposition: 'unmapped', sourceId: 'txn_noexp' });
  });

  it('a prepaid-credit purchase is held as customer credit reserve, not revenue', () => {
    const entry = entryOf(
      bt({
        id: 'txn_credits',
        type: 'payment',
        amount: 2_000,
        fee: 88,
        source: { id: 'py_1', object: 'charge', metadata: { purpose: PREPAID_CREDITS_PURPOSE } },
      }),
    );
    expect(entry.movement).toBe('credit-purchase');
    const { debit, credit, byAccount } = totals(entry);
    expect(debit).toBe(credit);
    expect(byAccount['revenue:credit']).toBeUndefined();
    expect(byAccount['customer-credit-reserve:credit']).toBeGreaterThan(0);
  });

  it.each(['refund', 'payment_refund'])('%s draws the exact refund from the provision and leaves operating with its BT reference', (type) => {
    const id = `txn_${type.replaceAll('_', '')}`;
    const entry = entryOf(bt({ id, type, amount: -1_500, source: { id: 're_1', object: 'refund' } }));
    expect(entry.entryId).toBe(`stripe-bt:${id}`);
    expect(entry.externalRef).toEqual({ kind: 'stripe-balance-transaction', id });
    expect(entry.movement).toBe('refund');
    expect(entry.lines).toEqual([
      { account: 'refund-chargeback-reserve', side: 'debit', cents: 1_500 },
      { account: 'operating', side: 'credit', cents: 1_500 },
    ]);
  });

  it('a lost dispute is a chargeback carrying the dispute fee; a won dispute reversal is unmapped, not invented', () => {
    const lost = entryOf(bt({ id: 'txn_dp', type: 'adjustment', amount: -3_000, fee: 1_500, source: { id: 'dp_1', object: 'dispute' } }));
    expect(lost.movement).toBe('chargeback');
    expect(totals(lost).debit).toBe(totals(lost).credit);
    expect(totals(lost).byAccount['operating:credit']).toBe(4_500);
    const won = journalVerdictForStripeBalanceTransaction(
      bt({ id: 'txn_won', type: 'adjustment', amount: 3_000, source: { id: 'dp_1', object: 'dispute' } }),
      POLICY,
    );
    expect(won.disposition).toBe('unmapped');
  });

  it.each(['stripe_fee', 'tax_fee'])('%s is an exact provider payment with its BT reference', (type) => {
    const id = `txn_${type.replaceAll('_', '')}`;
    const entry = entryOf(bt({ id, type, amount: -199 }));
    expect(entry.entryId).toBe(`stripe-bt:${id}`);
    expect(entry.externalRef).toEqual({ kind: 'stripe-balance-transaction', id });
    expect(entry.movement).toBe('provider-payment');
    expect(entry.lines).toEqual([
      { account: 'provider-cost', side: 'debit', cents: 199 },
      { account: 'operating', side: 'credit', cents: 199 },
    ]);
  });

  it.each([
    { type: 'payment_refund', amount: 1_500, fee: 0 },
    { type: 'payment_refund', amount: -1_500, fee: 1 },
    { type: 'tax_fee', amount: 199, fee: 0 },
  ])('$type with amount=$amount and fee=$fee reports an unmapped BT with a reason', (movement) => {
    const verdict = journalVerdictForStripeBalanceTransaction(bt({ id: 'txn_invalidalias', ...movement }), POLICY);
    expect(verdict).toMatchObject({ disposition: 'unmapped', sourceId: 'txn_invalidalias', reason: expect.stringContaining(movement.type) });
  });

  it('a payout is skipped with its reason (Stripe balance and bank are both operating)', () => {
    expect(journalVerdictForStripeBalanceTransaction(bt({ id: 'txn_po', type: 'payout', amount: -9_000 }), POLICY)).toMatchObject({
      disposition: 'skip',
      sourceId: 'txn_po',
    });
  });

  it('an unknown type is unmapped with a reason, never silently dropped', () => {
    const verdict = journalVerdictForStripeBalanceTransaction(bt({ id: 'txn_x', type: 'climate_order_purchase', amount: -50 }), POLICY);
    expect(verdict).toMatchObject({ disposition: 'unmapped', sourceId: 'txn_x' });
    expect('reason' in verdict && verdict.reason).toMatch(/climate_order_purchase/);
  });

  it('PROPERTY: every mapped charge, refund, dispute and fee balances to the cent and posts into a balanced journal', () => {
    const arbBt = fc.oneof(
      fc.record({
        type: fc.constantFrom('charge', 'payment'),
        amount: fc.integer({ min: 1, max: 5_000_000 }),
        feePct: fc.integer({ min: 0, max: 100 }),
        taxPct: fc.integer({ min: 0, max: 100 }),
        credits: fc.boolean(),
      }).map((r) => {
        const tax = Math.floor((r.amount * r.taxPct) / 100);
        return {
          type: r.type,
          amount: r.amount,
          fee: Math.floor((r.amount * r.feePct) / 100),
          source: {
            id: 'ch',
            object: 'charge',
            metadata: r.credits ? { purpose: PREPAID_CREDITS_PURPOSE } : {},
            invoice: { id: 'in', total_taxes: [{ amount: tax }] },
          },
        };
      }),
      fc.record({ type: fc.constantFrom('refund', 'payment_refund'), a: fc.integer({ min: 1, max: 5_000_000 }) })
        .map((r) => ({ type: r.type, amount: -r.a, fee: 0, source: null })),
      fc.record({ a: fc.integer({ min: 1, max: 5_000_000 }), f: fc.integer({ min: 0, max: 5_000 }) }).map((r) => ({
        type: 'adjustment',
        amount: -r.a,
        fee: r.f,
        source: { id: 'dp', object: 'dispute' },
      })),
      fc.record({ type: fc.constantFrom('stripe_fee', 'tax_fee'), a: fc.integer({ min: 1, max: 100_000 }) })
        .map((r) => ({ type: r.type, amount: -r.a, fee: 0, source: null })),
    );
    const policyArb = fc
      .record({ dao: fc.integer({ min: 0, max: 10_000 }), reserve: fc.integer({ min: 0, max: 10_000 }) })
      .filter((p) => p.dao + p.reserve <= 10_000);
    fc.assert(
      fc.property(fc.array(arbBt, { minLength: 1, maxLength: 30 }), policyArb, (txns, p) => {
        const policy = { daoBasisPoints: p.dao, refundReserveBasisPoints: p.reserve };
        let state: MoneyJournalState = emptyMoneyJournal('USD');
        txns.forEach((t, i) => {
          const verdict = journalVerdictForStripeBalanceTransaction(
            { id: `txn_p${i}`, currency: 'usd', created: CREATED + i, ...t } as StripeBalanceTransaction,
            policy,
          );
          // A charge whose fee exceeds its gross is a legitimate refusal; nothing else may fail to map.
          if (verdict.disposition !== 'entry') {
            expect(t.type === 'charge' || t.type === 'payment').toBe(true);
            return;
          }
          const { debit, credit } = totals(verdict.entry);
          expect(debit).toBe(credit);
          const posted = postJournalEntry(state, verdict.entry);
          expect(posted.ok).toBe(true);
          if (posted.ok) state = posted.state;
        });
        expect(trialBalance(state.entries).balanced).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('treasury transfer -> dao-transfer entry', () => {
  const HASH = `0x${'ab'.repeat(32)}`;
  it('pays DAO payable from operating, keyed by chain id + tx hash', () => {
    const verdict = journalVerdictForTreasuryTransfer({ chainId: 84532, txHash: HASH.toUpperCase().replace('0X', '0x'), amountCents: 12_345, occurredAtMs: 1 });
    expect(verdict.disposition).toBe('entry');
    if (verdict.disposition !== 'entry') return;
    expect(verdict.entry.entryId).toBe(`chain-tx:84532:${HASH}`);
    expect(verdict.entry.externalRef).toEqual({ kind: 'chain-tx', chainId: 84532, txHash: HASH });
    const { debit, credit, byAccount } = totals(verdict.entry);
    expect(debit).toBe(credit);
    expect(byAccount['dao-payable:debit']).toBe(12_345);
    expect(byAccount['operating:credit']).toBe(12_345);
  });

  it('a malformed hash or a fractional amount is unmapped, not booked', () => {
    expect(journalVerdictForTreasuryTransfer({ chainId: 84532, txHash: '0x12', amountCents: 1, occurredAtMs: 1 }).disposition).toBe('unmapped');
    expect(journalVerdictForTreasuryTransfer({ chainId: 84532, txHash: HASH, amountCents: 1.5, occurredAtMs: 1 }).disposition).toBe('unmapped');
  });
});

describe('importStripeBalanceTransactions', () => {
  function pages(all: StripeBalanceTransaction[], size: number) {
    const calls: Array<{ startingAfter?: string; createdGte?: number }> = [];
    const list = async (p: { limit: number; startingAfter?: string; createdGte?: number }) => {
      calls.push({ startingAfter: p.startingAfter, createdGte: p.createdGte });
      const start = p.startingAfter ? all.findIndex((t) => t.id === p.startingAfter) + 1 : 0;
      const data = all.slice(start, start + Math.min(size, p.limit));
      return { data, has_more: start + data.length < all.length };
    };
    return { list, calls };
  }
  function memoryPoster() {
    let state = emptyMoneyJournal('USD');
    const post: JournalPoster = async (entry) => {
      if (state.entryIds.has(entry.entryId)) return { ok: true, duplicate: true };
      const r = postJournalEntry(state, entry);
      if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
      state = r.state;
      return { ok: true, duplicate: false };
    };
    return { post, get state() { return state; } };
  }
  const ACCOUNT: StripeBalanceTransaction[] = [
    bt({ id: 'txn_a', type: 'charge', amount: 1_000, fee: 59, source: { id: 'ch_a', object: 'charge' } }),
    bt({ id: 'txn_b', type: 'refund', amount: -400 }),
    bt({ id: 'txn_c', type: 'payout', amount: -500 }),
    bt({ id: 'txn_d', type: 'issuing_transaction', amount: -10 }),
    bt({ id: 'txn_e', type: 'stripe_fee', amount: -25 }),
  ];

  it('pages the whole window, posts each entry, and reports skips and unmapped with reasons', async () => {
    const { list, calls } = pages(ACCOUNT, 2);
    const journal = memoryPoster();
    const report = await importStripeBalanceTransactions({ list, post: journal.post, policy: POLICY, createdGte: 100, pageSize: 2 });
    expect(report).toMatchObject({ scanned: 5, posted: 3, duplicates: 0, truncated: false });
    expect(report.skipped.map((s) => s.sourceId)).toEqual(['txn_c']);
    expect(report.unmapped.map((s) => s.sourceId)).toEqual(['txn_d']);
    expect(calls).toEqual([
      { startingAfter: undefined, createdGte: 100 },
      { startingAfter: 'txn_b', createdGte: 100 },
      { startingAfter: 'txn_d', createdGte: 100 },
    ]);
    expect(trialBalance(journal.state.entries).balanced).toBe(true);
  });

  it('re-running over the same window posts nothing new (idempotent on the BT id)', async () => {
    const journal = memoryPoster();
    await importStripeBalanceTransactions({ list: pages(ACCOUNT, 10).list, post: journal.post, policy: POLICY });
    const again = await importStripeBalanceTransactions({ list: pages(ACCOUNT, 10).list, post: journal.post, policy: POLICY });
    expect(again).toMatchObject({ posted: 0, duplicates: 3 });
    expect(journal.state.entries).toHaveLength(3);
  });

  it('shifted overlapping Stripe windows import the unseen BTs once and retain the shared prefix without duplicate journal entries', async () => {
    const history = [
      bt({ id: 'txn_overlapnew', type: 'charge', amount: 1_000, created: CREATED + 4 }),
      bt({ id: 'txn_overlaprefund', type: 'payment_refund', amount: -400, created: CREATED + 3 }),
      bt({ id: 'txn_overlapfee', type: 'tax_fee', amount: -25, created: CREATED + 2 }),
      bt({ id: 'txn_overlapoldrefund', type: 'refund', amount: -100, created: CREATED + 1 }),
      bt({ id: 'txn_overlapoldfee', type: 'stripe_fee', amount: -10, created: CREATED }),
    ];
    const journal = memoryPoster();
    const importWindow = (createdGte: number) => importStripeBalanceTransactions({
      list: pages(history.filter((t) => t.created >= createdGte), 2).list,
      post: journal.post, policy: POLICY, createdGte, pageSize: 2,
    });
    expect(await importWindow(CREATED + 2)).toEqual({ scanned: 3, posted: 3, duplicates: 0, skipped: [], unmapped: [], refused: [], truncated: false });
    const prefix = journal.state.entries.slice();
    expect(await importWindow(CREATED)).toEqual({ scanned: 5, posted: 2, duplicates: 3, skipped: [], unmapped: [], refused: [], truncated: false });
    expect(journal.state.entries.slice(0, 3)).toEqual(prefix);
    expect(journal.state.entries.map((e) => e.entryId)).toEqual(history.map((t) => `stripe-bt:${t.id}`));
    expect(journal.state.entries.map((e) => e.externalRef)).toEqual(history.map((t) => ({ kind: 'stripe-balance-transaction', id: t.id })));
    expect(trialBalance(journal.state.entries).balanced).toBe(true);
    expect(await importWindow(CREATED + 1)).toMatchObject({ scanned: 4, posted: 0, duplicates: 4, truncated: false });
    expect(journal.state.entries).toHaveLength(5);
  });

  it('a page budget that runs out is reported as truncated, not as a complete window', async () => {
    const report = await importStripeBalanceTransactions({
      list: pages(ACCOUNT, 1).list,
      post: memoryPoster().post,
      policy: POLICY,
      pageSize: 1,
      maxPages: 2,
    });
    expect(report).toMatchObject({ scanned: 2, truncated: true });
  });

  it('an invalid policy is refused before any page is read', async () => {
    expect(validatePolicy({ daoBasisPoints: 6_000, refundReserveBasisPoints: 5_000 })).toMatch(/exceed/);
    const { list, calls } = pages(ACCOUNT, 10);
    await expect(
      importStripeBalanceTransactions({ list, post: memoryPoster().post, policy: { daoBasisPoints: 6_000, refundReserveBasisPoints: 5_000 } }),
    ).rejects.toThrow(/exceed/);
    expect(calls).toHaveLength(0);
  });
});

describe('stripeBalanceTransactionLister', () => {
  it('GETs one page with source + invoice expanded, the cursor and the window, and maps has_more', async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'txn_1' }], has_more: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const page = await stripeBalanceTransactionLister({ secretKey: 'sk_test_x', fetchImpl })({ limit: 50, startingAfter: 'txn_0', createdGte: 7 });
    expect(page).toEqual({ data: [{ id: 'txn_1' }], has_more: true });
    const url = new URL(seen!.url);
    expect(url.pathname).toBe('/v1/balance_transactions');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('starting_after')).toBe('txn_0');
    expect(url.searchParams.get('created[gte]')).toBe('7');
    expect(url.searchParams.getAll('expand[]')).toEqual(['data.source', 'data.source.invoice']);
    expect(seen!.init?.method).toBe('GET');
    expect((seen!.init?.headers as Record<string, string>).authorization).toBe('Bearer sk_test_x');
  });

  it('a provider error throws with Stripe\'s message, so a run never records a partial window as complete', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 })) as unknown as typeof fetch;
    await expect(stripeBalanceTransactionLister({ secretKey: 'sk_test_x', fetchImpl })({ limit: 1 })).rejects.toThrow(/Invalid API Key/);
  });
});
