/**
 * agent-economy-flywheel-2026-08-30 P-042 / R-30: the money journal always
 * balances, to the cent. Property tests over random movement sequences, plus
 * one test per falsifier (unbalanced, lost or invented residue, sub-cent or
 * micro amounts in the journal, an entry without its external reference).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MICROS_PER_CENT,
  MONEY_JOURNAL_ACCOUNTS,
  accrueMicros,
  daoShareCents,
  emptyMicrosRollup,
  emptyMoneyJournal,
  entryTotalCents,
  externalRefKey,
  journalEntryForMovement,
  journalLinesForMovement,
  postJournalEntry,
  rollupInvariant,
  settleRollupIntoJournal,
  trialBalance,
  validateJournalEntry,
  type ExternalRef,
  type JournalEntry,
  type MicrosRollup,
  type MoneyJournalState,
  type MoneyMovement,
  type MovementKind,
} from './money-journal';

const hex64 = (n: number): string => n.toString(16).padStart(64, '0');
const stripeRef = (n: number): ExternalRef => ({ kind: 'stripe-balance-transaction', id: `txn_${n}` });
const bankRef = (n: number): ExternalRef => ({ kind: 'bank-transaction', id: `bank-${n}` });
const chainRef = (n: number): ExternalRef => ({ kind: 'chain-tx', chainId: 84532, txHash: `0x${hex64(n)}` });

function refFor(kind: MovementKind, n: number): ExternalRef {
  if (kind === 'dao-transfer') return chainRef(n);
  if (kind === 'tax-remittance' || kind === 'provider-payment') return bankRef(n);
  return stripeRef(n);
}

const amount = fc.integer({ min: 1, max: 5_000_000 });

/** A movement that is valid by construction (every split fits inside its gross). */
const movementArb: fc.Arbitrary<MoneyMovement> = fc.oneof(
  fc
    .tuple(amount, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
    .map(([gross, f, t, d, r]) => {
      const taxCents = Math.floor(gross * t * 0.3);
      const daoCents = Math.floor((gross - taxCents) * d * 0.3);
      const refundReserveCents = Math.floor((gross - taxCents - daoCents) * r * 0.3);
      return { kind: 'customer-payment', grossCents: gross, feeCents: Math.floor(gross * f * 0.1), taxCents, daoCents, refundReserveCents } as const;
    }),
  fc
    .tuple(fc.integer({ min: 2, max: 5_000_000 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
    .map(([gross, f, t]) => ({ kind: 'credit-purchase', grossCents: gross, feeCents: Math.floor(gross * f * 0.1), taxCents: Math.floor((gross - 1) * t * 0.3) }) as const),
  fc.tuple(amount, fc.double({ min: 0, max: 1, noNaN: true })).map(([a, t]) => ({ kind: 'refund', amountCents: a, taxCents: Math.floor(a * t * 0.3) }) as const),
  fc.tuple(amount, fc.integer({ min: 0, max: 2_500 })).map(([a, fee]) => ({ kind: 'chargeback', amountCents: a, feeCents: fee }) as const),
  amount.map((a) => ({ kind: 'provider-payment', amountCents: a }) as const),
  amount.map((a) => ({ kind: 'dao-transfer', amountCents: a }) as const),
  amount.map((a) => ({ kind: 'tax-remittance', amountCents: a }) as const),
);

type Op =
  | { op: 'movement'; movement: MoneyMovement }
  | { op: 'accrue'; rollup: number; micros: number; accrual: number }
  | { op: 'settle'; rollup: number; bps: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  movementArb.map((movement) => ({ op: 'movement', movement }) as const),
  fc
    .record({ rollup: fc.integer({ min: 0, max: 2 }), micros: fc.integer({ min: 1, max: 120_000 }), accrual: fc.integer({ min: 0, max: 40 }) })
    .map((r) => ({ op: 'accrue', ...r }) as const),
  fc.record({ rollup: fc.integer({ min: 0, max: 2 }), bps: fc.integer({ min: 0, max: 10_000 }) }).map((r) => ({ op: 'settle', ...r }) as const),
);

function assertJournalInvariants(journal: MoneyJournalState, rollups: readonly MicrosRollup[]): void {
  // Debits equal credits, recomputed from the entries themselves.
  const tb = trialBalance(journal.entries, journal.currency);
  expect(tb.balanced).toBe(true);
  expect(tb.debitCents).toBe(journal.totalDebitCents);
  expect(tb.creditCents).toBe(journal.totalCreditCents);
  expect(Object.values(journal.balancesCents).reduce((s, v) => s + v, 0)).toBe(0);
  for (const entry of journal.entries) {
    // Every entry balances on its own, carries a reference, and holds only whole cents.
    const debits = entry.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.cents, 0);
    const credits = entry.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.cents, 0);
    expect(debits).toBe(credits);
    expect(externalRefKey(entry.externalRef).length).toBeGreaterThan(0);
    for (const line of entry.lines) {
      expect(Number.isSafeInteger(line.cents) && line.cents > 0).toBe(true);
      expect(Object.keys(line).sort()).toEqual(['account', 'cents', 'side']);
    }
  }
  // Cents settled into the journal plus each rounding balance equal the micros accrued, exactly.
  for (const rollup of rollups) {
    const inv = rollupInvariant(journal.entries, rollup);
    expect(inv.holds).toBe(true);
    expect(inv.journalCents * MICROS_PER_CENT + inv.roundingMicros).toBe(rollup.totalMicros);
    expect(rollup.roundingMicros).toBeGreaterThanOrEqual(0);
  }
}

describe('money journal (P-042, R-30)', () => {
  it('property: after every entry of a random movement sequence, debits equal credits and cents plus rounding equal micros', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        let journal = emptyMoneyJournal('USD');
        const rollups: MicrosRollup[] = [0, 1, 2].map((i) => emptyMicrosRollup(`rollup-${i}`));
        let seq = 0;
        let accruedMicros = 0;
        const observedAccruals = new Map<string, number>();
        for (const op of ops) {
          seq += 1;
          if (op.op === 'movement') {
            const built = journalEntryForMovement({
              entryId: `e-${seq}`,
              occurredAtMs: seq,
              currency: 'USD',
              externalRef: refFor(op.movement.kind, seq),
              movement: op.movement,
            });
            expect(built.ok).toBe(true);
            if (!built.ok) return;
            const posted = postJournalEntry(journal, built.entry);
            expect(posted.ok).toBe(true);
            if (posted.ok) journal = posted.state;
          } else if (op.op === 'accrue') {
            const before = rollups[op.rollup]!;
            const accrualId = `a-${op.rollup}-${op.accrual}`;
            const res = accrueMicros(before, { accrualId, micros: op.micros });
            const priorAmount = observedAccruals.get(accrualId);
            if (priorAmount !== undefined && priorAmount !== op.micros) {
              expect(res).toMatchObject({ ok: false, detail: 'accrual replay mismatch' });
            } else {
              expect(res.ok).toBe(true);
              if (!res.ok) return;
              if (priorAmount === undefined) { accruedMicros += op.micros; observedAccruals.set(accrualId, op.micros); }
              else expect(res.rollup).toBe(before); // a byte-identical repeat changes nothing
              rollups[op.rollup] = res.rollup;
            }
          } else {
            const res = settleRollupIntoJournal(journal, rollups[op.rollup]!, {
              entryId: `s-${seq}`,
              occurredAtMs: seq,
              externalRef: chainRef(seq),
              daoBasisPoints: op.bps,
            });
            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res.rollup.roundingMicros).toBeLessThan(MICROS_PER_CENT);
            journal = res.journal;
            rollups[op.rollup] = res.rollup;
          }
          assertJournalInvariants(journal, rollups);
        }
        expect(rollups.reduce((s, r) => s + r.totalMicros, 0)).toBe(accruedMicros);
      }),
      { numRuns: 300 },
    );
  });

  it('property: any entry whose debits differ from its credits is refused as unbalanced', () => {
    fc.assert(
      fc.property(amount, amount, (debit, credit) => {
        fc.pre(debit !== credit);
        const result = validateJournalEntry({
          entryId: 'x',
          occurredAtMs: 1,
          currency: 'USD',
          movement: 'provider-payment',
          externalRef: bankRef(1),
          lines: [
            { account: 'provider-cost', side: 'debit', cents: debit },
            { account: 'operating', side: 'credit', cents: credit },
          ],
        });
        expect(result).toMatchObject({ ok: false, code: 'unbalanced' });
      }),
      { numRuns: 200 },
    );
  });

  it('property: every movement posting rule produces a balanced entry of positive whole cents', () => {
    fc.assert(
      fc.property(movementArb, (movement) => {
        const built = journalLinesForMovement(movement);
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        const debits = built.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.cents, 0);
        const credits = built.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.cents, 0);
        expect(debits).toBe(credits);
        expect(built.lines.every((l) => Number.isSafeInteger(l.cents) && l.cents > 0)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  const base = {
    entryId: 'e-1',
    occurredAtMs: 1,
    currency: 'USD',
    movement: 'provider-payment',
    externalRef: bankRef(1),
    lines: [
      { account: 'provider-cost', side: 'debit', cents: 500 },
      { account: 'operating', side: 'credit', cents: 500 },
    ],
  };

  it('refuses an entry with no external reference', () => {
    const { externalRef: _drop, ...noRef } = base;
    expect(validateJournalEntry(noRef)).toMatchObject({ ok: false, code: 'missing-external-reference' });
    expect(validateJournalEntry({ ...base, externalRef: null })).toMatchObject({ ok: false, code: 'missing-external-reference' });
    const built = journalEntryForMovement({
      entryId: 'p',
      occurredAtMs: 1,
      currency: 'USD',
      externalRef: undefined as unknown as ExternalRef,
      movement: { kind: 'provider-payment', amountCents: 10 },
    });
    expect(built).toMatchObject({ ok: false, code: 'missing-external-reference' });
  });

  it('refuses malformed references and references that cannot evidence the movement', () => {
    expect(validateJournalEntry({ ...base, externalRef: { kind: 'stripe-balance-transaction', id: 'ch_123' } })).toMatchObject({
      code: 'invalid-external-reference',
    });
    expect(validateJournalEntry({ ...base, externalRef: { kind: 'chain-tx', chainId: 84532, txHash: '0xABC' } })).toMatchObject({
      code: 'invalid-external-reference',
    });
    expect(validateJournalEntry({ ...base, externalRef: { kind: 'bank-transaction', id: '  ' } })).toMatchObject({
      code: 'invalid-external-reference',
    });
    // A DAO transfer happens on chain; a Stripe id cannot evidence it.
    const dao = journalEntryForMovement({
      entryId: 'd',
      occurredAtMs: 1,
      currency: 'USD',
      externalRef: stripeRef(1),
      movement: { kind: 'dao-transfer', amountCents: 100 },
    });
    expect(dao).toMatchObject({ ok: false, code: 'external-reference-kind-not-allowed' });
  });

  it('refuses a sub-cent amount and any micros-denominated line', () => {
    const fractional = { ...base, lines: [{ ...base.lines[0], cents: 12.5 }, { ...base.lines[1], cents: 12.5 }] };
    expect(validateJournalEntry(fractional)).toMatchObject({ ok: false, code: 'sub-cent-amount' });
    const micros = { ...base, lines: [{ account: 'provider-cost', side: 'debit', micros: 5_000_000 }, base.lines[1]] };
    expect(validateJournalEntry(micros)).toMatchObject({ ok: false, code: 'micros-in-journal' });
    const unitMicros = { ...base, lines: [{ ...base.lines[0], unit: 'micros' }, base.lines[1]] };
    expect(validateJournalEntry(unitMicros)).toMatchObject({ ok: false, code: 'micros-in-journal' });
    expect(journalLinesForMovement({ kind: 'provider-payment', amountCents: 0.5 })).toMatchObject({ ok: false, code: 'sub-cent-amount' });
  });

  it('refuses unknown accounts, single-sided entries, zero amounts and duplicates', () => {
    expect(validateJournalEntry({ ...base, lines: [{ ...base.lines[0], account: 'suspense' }, base.lines[1]] })).toMatchObject({
      code: 'unknown-account',
    });
    expect(validateJournalEntry({ ...base, lines: [base.lines[0]] })).toMatchObject({ code: 'too-few-lines' });
    expect(validateJournalEntry({ ...base, lines: [{ ...base.lines[0], cents: 0 }, { ...base.lines[1], cents: 0 }] })).toMatchObject({
      code: 'non-positive-amount',
    });
    const once = postJournalEntry(emptyMoneyJournal(), base);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(postJournalEntry(once.state, base)).toMatchObject({ ok: false, code: 'duplicate-entry' });
    expect(postJournalEntry(emptyMoneyJournal('EUR'), base)).toMatchObject({ ok: false, code: 'currency-mismatch' });
  });

  it('a rollupId is required on a usage settlement and forbidden elsewhere', () => {
    expect(validateJournalEntry({ ...base, rollupId: 'r' })).toMatchObject({ code: 'invalid-entry' });
    const settlement = journalLinesForMovement({ kind: 'usage-settlement', cents: 10, daoCents: 1 });
    if (!settlement.ok) throw new Error('expected lines');
    expect(
      validateJournalEntry({ ...base, movement: 'usage-settlement', externalRef: chainRef(1), lines: settlement.lines }),
    ).toMatchObject({ code: 'invalid-entry' });
  });

  it('micros below a cent stay in the rounding balance and settle only once they make a whole cent', () => {
    let journal = emptyMoneyJournal();
    let rollup = emptyMicrosRollup('per-use:identity-1');
    for (let i = 0; i < 3; i += 1) {
      const res = accrueMicros(rollup, { accrualId: `nonce-${i}`, micros: 3_333 });
      if (!res.ok) throw new Error(res.detail);
      rollup = res.rollup;
    }
    let settled = settleRollupIntoJournal(journal, rollup, { entryId: 's1', occurredAtMs: 1, externalRef: chainRef(1), daoBasisPoints: 1_000 });
    if (!settled.ok) throw new Error(settled.detail);
    expect(settled.entry).toBeNull();
    expect(settled.rollup.roundingMicros).toBe(9_999);
    expect(settled.journal.entries).toHaveLength(0);

    const more = accrueMicros(settled.rollup, { accrualId: 'nonce-3', micros: 25_001 });
    if (!more.ok) throw new Error(more.detail);
    settled = settleRollupIntoJournal(settled.journal, more.rollup, { entryId: 's2', occurredAtMs: 2, externalRef: chainRef(2), daoBasisPoints: 1_000 });
    if (!settled.ok) throw new Error(settled.detail);
    expect(settled.settledCents).toBe(3); // 35,000 micros = 3 cents + 5,000 micros of residue
    expect(settled.rollup.roundingMicros).toBe(5_000);
    expect(entryTotalCents(settled.entry!)).toBe(3);
    expect(rollupInvariant(settled.journal.entries, settled.rollup).holds).toBe(true);
    journal = settled.journal;
    expect(trialBalance(journal.entries).balanced).toBe(true);
  });

  it('a repeated accrual nonce is not double-counted, and fractional micros are refused', () => {
    const r1 = accrueMicros(emptyMicrosRollup('r'), { accrualId: 'n', micros: 7 });
    if (!r1.ok) throw new Error(r1.detail);
    const r2 = accrueMicros(r1.rollup, { accrualId: 'n', micros: 7 });
    expect(r2).toMatchObject({ ok: true, duplicate: true });
    if (r2.ok) expect(r2.rollup.totalMicros).toBe(7);
    expect(accrueMicros(r1.rollup, { accrualId: 'm', micros: 0.5 })).toMatchObject({ ok: false, code: 'invalid-micros' });
    expect(accrueMicros(r1.rollup, { accrualId: 'm', micros: -3 })).toMatchObject({ ok: false, code: 'invalid-micros' });
  });

  it('preserves exact submicro accruals and settlement residue, refusing changed replays', () => {
    let rollup = emptyMicrosRollup('exact');
    for (const [accrualId, micros, microsExact] of [['a', 4999, '4999.6'], ['b', 5000, '5000.6']] as const) {
      const result = accrueMicros(rollup, { accrualId, micros, microsExact });
      if (!result.ok) throw new Error(result.detail); rollup = result.rollup;
    }
    expect(rollup).toMatchObject({ totalMicros: 10000, totalMicrosExact: '10000.2', roundingMicrosExact: '10000.2' });
    expect(accrueMicros(rollup, { accrualId: 'a', micros: 4999, microsExact: '4999.6' })).toMatchObject({ ok: true, duplicate: true });
    expect(accrueMicros(rollup, { accrualId: 'a', micros: 4999, microsExact: '4999.7' })).toMatchObject({ ok: false });
    const settled = settleRollupIntoJournal(emptyMoneyJournal(), rollup, { entryId: 'exact-s', occurredAtMs: 1,
      externalRef: chainRef(1), daoBasisPoints: 0 });
    if (!settled.ok) throw new Error(settled.detail);
    expect(settled).toMatchObject({ settledCents: 1, rollup: { roundingMicros: 0, roundingMicrosExact: '0.2' } });
    expect(rollupInvariant(settled.journal.entries, settled.rollup).holds).toBe(true);
    expect(rollupInvariant(settled.journal.entries, { ...settled.rollup, roundingMicrosExact: '0.3' }).holds).toBe(false);
    expect(accrueMicros(rollup, { accrualId: 'bad', micros: 1, microsExact: '0.1' }).ok).toBe(false);
  });

  it('the invariant check catches lost and invented residue', () => {
    const accrued = accrueMicros(emptyMicrosRollup('r'), { accrualId: 'n', micros: 25_000 });
    if (!accrued.ok) throw new Error(accrued.detail);
    const settled = settleRollupIntoJournal(emptyMoneyJournal(), accrued.rollup, { entryId: 's', occurredAtMs: 1, externalRef: chainRef(9), daoBasisPoints: 0 });
    if (!settled.ok) throw new Error(settled.detail);
    expect(rollupInvariant(settled.journal.entries, settled.rollup).holds).toBe(true);
    const lost: MicrosRollup = { ...settled.rollup, roundingMicros: 0 };
    const invented: MicrosRollup = { ...settled.rollup, roundingMicros: settled.rollup.roundingMicros + 1 };
    expect(rollupInvariant(settled.journal.entries, lost).holds).toBe(false);
    expect(rollupInvariant(settled.journal.entries, invented).holds).toBe(false);
    // A settlement entry missing from the journal is also caught.
    expect(rollupInvariant([] as JournalEntry[], settled.rollup).holds).toBe(false);
  });

  it('the DAO share of a settlement rounds down in whole cents and revenue keeps the rest', () => {
    expect(daoShareCents(7, 1_000)).toBe(0);
    expect(daoShareCents(10, 1_000)).toBe(1);
    expect(daoShareCents(199, 1_000)).toBe(19);
    expect(() => daoShareCents(10, 10_001)).toThrow();
  });

  it('customer payment, credit purchase and refund post to the documented accounts', () => {
    const pay = journalLinesForMovement({ kind: 'customer-payment', grossCents: 10_000, feeCents: 320, taxCents: 800, daoCents: 920, refundReserveCents: 100 });
    if (!pay.ok) throw new Error(pay.detail);
    expect(pay.lines).toEqual([
      { account: 'operating', side: 'debit', cents: 9_680 },
      { account: 'provider-cost', side: 'debit', cents: 320 },
      { account: 'tax-reserve', side: 'credit', cents: 800 },
      { account: 'dao-payable', side: 'credit', cents: 920 },
      { account: 'refund-chargeback-reserve', side: 'credit', cents: 100 },
      { account: 'revenue', side: 'credit', cents: 8_180 },
    ]);
    const credits = journalLinesForMovement({ kind: 'credit-purchase', grossCents: 2_000, feeCents: 0, taxCents: 0 });
    if (!credits.ok) throw new Error(credits.detail);
    expect(credits.lines).toEqual([
      { account: 'operating', side: 'debit', cents: 2_000 },
      { account: 'customer-credit-reserve', side: 'credit', cents: 2_000 },
    ]);
    expect(journalLinesForMovement({ kind: 'customer-payment', grossCents: 100, feeCents: 0, taxCents: 60, daoCents: 30, refundReserveCents: 20 })).toMatchObject({
      ok: false,
      code: 'invalid-movement',
    });
    expect(MONEY_JOURNAL_ACCOUNTS).toHaveLength(7);
  });
});
