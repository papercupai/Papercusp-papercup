/**
 * The reconciliation pass end to end over injected rails (P-043, D-025 §4-§5):
 * import first, then reconcile, file breaks once, and push a signed gate that
 * the Worker can verify. The PG store and the Worker routes have their own tests.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { validateJournalEntry, type JournalEntry } from './money-journal';
import type { StripeBalanceTransaction, StripeBalanceTransactionLister } from './money-journal-producers';
import { memoryReconciliationStore, type BreakFiler, type GatePublisher } from './reconciliation';
import {
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSFER_GATE_PATH,
  parseReconciliationInputs,
  parseTransferGatePush,
  signReconciliationRequest,
  verifyReconciliationRequest,
  type ReconciliationInputs,
} from './reconciliation-hmac';
import {
  centsFromMicros,
  cupboardGatePublisher,
  cupboardInputsReader,
  parseMoneyJournalPolicy,
  parseSafeReadConfig,
  readReconciliationRuntimeConfig,
  readSafeSnapshot,
  runReconciliationPass,
  viemSafeChainReader,
  type ReconciliationRuntimeConfig,
  type SafeChainState,
} from './reconciliation-runtime';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15T12:00Z, provisional period = October
const IN_MONTH_S = Math.floor(Date.UTC(2026, 9, 3, 9, 0, 0) / 1000);
const WS = 'ws-recon';
const SECRET = 'test-reconciliation-secret';
const TX_A = `0x${'a'.repeat(64)}`;
const TX_B = `0x${'b'.repeat(64)}`;

const charge: StripeBalanceTransaction = {
  id: 'txn_charge1',
  type: 'charge',
  amount: 10_000,
  fee: 320,
  currency: 'usd',
  created: IN_MONTH_S,
  source: { id: 'ch_1', object: 'charge', invoice: null },
};
const credits: StripeBalanceTransaction = {
  id: 'txn_credits1',
  type: 'charge',
  amount: 5_000,
  fee: 175,
  currency: 'usd',
  created: IN_MONTH_S + 60,
  source: { id: 'ch_2', object: 'charge', invoice: null, metadata: { purpose: 'prepaid-credits' } },
};
const payout: StripeBalanceTransaction = { id: 'txn_payout1', type: 'payout', amount: -4_000, fee: 0, currency: 'usd', created: IN_MONTH_S + 120 };

function lister(bts: readonly StripeBalanceTransaction[]): StripeBalanceTransactionLister {
  return async () => ({ data: bts, has_more: false });
}

function config(overrides: Partial<ReconciliationRuntimeConfig> = {}): ReconciliationRuntimeConfig {
  return {
    stripeSecretKeyRef: 'env:STRIPE_TEST',
    stripeJournalWorkspace: WS,
    treasuryWorkspace: WS,
    policy: { daoBasisPoints: 1_000, refundReserveBasisPoints: 500 },
    policyError: null,
    gateSecretRef: 'env:RECON_SECRET',
    cupboardUrl: 'https://cupboard.test',
    chainRpcUrl: null,
    safe: { status: 'not-configured' },
    ...overrides,
  };
}

function inputs(overrides: Partial<ReconciliationInputs> = {}): ReconciliationInputs {
  return {
    // The credit purchase above books 5,000c to the reserve; 4,000c of credits remain owed.
    outstandingCreditsMicros: 4_000 * 10_000,
    daoTransfers: [{ transferId: 'tt-1', chainId: 84532, transactionHash: TX_A, amountMicros: 500 * 10_000, createdAtMs: NOW - 86_400_000 }],
    finalSettlementBatches: [],
    generatedAtMs: NOW,
    ...overrides,
  };
}

/** An in-memory journal with the store's idempotency semantics. */
function journal(seed: readonly JournalEntry[] = []) {
  const entries = new Map<string, JournalEntry>(seed.map((e) => [e.entryId, e]));
  return {
    entries,
    post: () => async (entry: JournalEntry) => {
      if (entries.has(entry.entryId)) return { ok: true as const, duplicate: true };
      entries.set(entry.entryId, entry);
      return { ok: true as const, duplicate: false };
    },
    read: async () => [...entries.values()],
  };
}

function recordingFiler() {
  const filed: string[] = [];
  const resolved: string[] = [];
  const filer: BreakFiler = {
    async fileBreak({ verdict }) {
      filed.push(verdict.invariant);
      return `WI-${filed.length}`;
    },
    async noteResolved({ workItemId }) {
      resolved.push(workItemId);
    },
  };
  return { filer, filed, resolved };
}

function capturingFetch(status = 200) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: String(init.body ?? '') });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('reconciliation request signing', () => {
  it('verifies a signature over the exact method, path and body, within five minutes', async () => {
    const header = await signReconciliationRequest({ secret: SECRET, method: 'PUT', pathname: TRANSFER_GATE_PATH, body: '{"a":1}', nowMs: NOW });
    const base = { secret: SECRET, header, method: 'PUT', pathname: TRANSFER_GATE_PATH, body: '{"a":1}' };
    expect(await verifyReconciliationRequest({ ...base, nowMs: NOW + 60_000 })).toEqual({ ok: true });
    expect(await verifyReconciliationRequest({ ...base, nowMs: NOW + 6 * 60_000 })).toEqual({ ok: false, reason: 'stale' });
    expect(await verifyReconciliationRequest({ ...base, body: '{"a":2}', nowMs: NOW })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyReconciliationRequest({ ...base, pathname: '/commerce/treasury/reconciliation-inputs', nowMs: NOW })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(await verifyReconciliationRequest({ ...base, secret: 'other', nowMs: NOW })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyReconciliationRequest({ ...base, secret: undefined, nowMs: NOW })).toEqual({ ok: false, reason: 'not-configured' });
    expect(await verifyReconciliationRequest({ ...base, header: 't=1,v1=zz', nowMs: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a gate push that is open with reasons, or that omits treasuryReconciled', () => {
    const push = { workspaceId: WS, open: true, reasons: [], runId: 'r1', atMs: NOW, treasuryReconciled: true };
    expect(parseTransferGatePush(push)).toEqual(push);
    expect(parseTransferGatePush({ ...push, reasons: ['break open: x'] })).toBeNull();
    const { treasuryReconciled: _omit, ...withoutFlag } = push;
    expect(parseTransferGatePush(withoutFlag)).toBeNull();
  });

  it('refuses malformed Worker inputs instead of guessing', () => {
    expect(() => parseReconciliationInputs({ outstandingCreditsMicros: -1, daoTransfers: [] })).toThrow(/outstandingCreditsMicros/);
    expect(() =>
      parseReconciliationInputs({ outstandingCreditsMicros: 0, daoTransfers: [{ transferId: 'x', chainId: 1, transactionHash: '0x12', amountMicros: 1, createdAtMs: 1 }] }),
    ).toThrow(/daoTransfers\[0\]/);
  });
});

describe('reconciliation runtime configuration', () => {
  it('reads every rail from the environment, defaulting the treasury to the Stripe workspace', () => {
    const c = readReconciliationRuntimeConfig({
      PAPERCUSP_STRIPE_SECRET_KEY_REF: 'file:/k',
      PAPERCUSP_STRIPE_JOURNAL_WORKSPACE: 'ws-a',
      PAPERCUSP_MONEY_JOURNAL_POLICY: '{"daoBasisPoints":1000,"refundReserveBasisPoints":500}',
      PAPERCUSP_RECONCILIATION_GATE_SECRET_REF: 'env:X',
      PAPERCUSP_CUPBOARD_URL: 'https://w.test/',
    });
    expect(c).toMatchObject({ stripeJournalWorkspace: 'ws-a', treasuryWorkspace: 'ws-a', cupboardUrl: 'https://w.test', policyError: null });
    expect(readReconciliationRuntimeConfig({}).treasuryWorkspace).toBeNull();
    expect(parseMoneyJournalPolicy('{"daoBasisPoints":9000,"refundReserveBasisPoints":2000}').error).toMatch(/exceed/);
    expect(centsFromMicros(1_234_999)).toBe(123);
  });
});

describe('runReconciliationPass', () => {
  it('imports Stripe and DAO transfers first, then reconciles every invariant it can and opens the gate', async () => {
    const j = journal();
    const store = memoryReconciliationStore();
    const { filer, filed } = recordingFiler();
    const { calls, fetchImpl } = capturingFetch();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config(),
        resolveSecret: async () => SECRET,
        stripeLister: lister([charge, credits, payout]),
        cupboardInputs: async () => inputs(),
        chainVerifier: async () => true,
        store,
        filer,
        post: j.post,
        readEntries: j.read,
        now: () => NOW,
        fetchImpl,
      },
    );
    const ws = result.workspaces[0]!;
    expect(ws.error).toBeNull();
    expect(ws.stripeImport).toMatchObject({ scanned: 3, posted: 2, skipped: [{ sourceId: 'txn_payout1' }] });
    expect(ws.daoTransferImport).toMatchObject({ scanned: 1, posted: 1 });
    expect([...j.entries.keys()].sort()).toEqual(['chain-tx:84532:' + TX_A, 'stripe-bt:txn_charge1', 'stripe-bt:txn_credits1']);
    const status = Object.fromEntries(ws.run!.verdicts.map((v) => [v.invariant, v.status]));
    expect(status).toEqual({
      'credit-reserve-covers-outstanding-credits': 'ok',
      'dao-payable-equals-accrued-minus-transferred': 'ok',
      'safe-balance-equals-receipts-minus-approved-spends': 'not-configured',
      'journal-matches-stripe': 'ok',
      'journal-matches-bank': 'not-configured',
      'journal-matches-chain': 'ok',
    });
    // The charge accrued 1,000c to the DAO (10% of 10,000 net); the imported 500c
    // transfer debited it, so payable 500c = accrued 1,000c - transferred 500c.
    expect(ws.run!.verdicts.find((v) => v.invariant === 'dao-payable-equals-accrued-minus-transferred')!.detail).toBe(
      'journal dao-payable 500c; accrued 1000c (off-chain journal 1000c + final settlements 0c) - transferred on chain 500c = 500c',
    );
    expect(filed).toEqual([]);
    // The gate push is signed, verifiable by the Worker, and carries treasuryReconciled.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`https://cupboard.test${TRANSFER_GATE_PATH}`);
    expect(
      await verifyReconciliationRequest({
        secret: SECRET,
        header: call.headers[RECONCILIATION_SIGNATURE_HEADER],
        method: 'PUT',
        pathname: TRANSFER_GATE_PATH,
        body: call.body,
        nowMs: NOW,
      }),
    ).toEqual({ ok: true });
    expect(parseTransferGatePush(JSON.parse(call.body))).toEqual({
      workspaceId: WS,
      open: true,
      reasons: [],
      runId: ws.run!.runId,
      atMs: NOW,
      treasuryReconciled: true,
    });
  });

  describe('final settlement claims (D-032, WI-10004709)', () => {
    const TX_C = `0x${'c'.repeat(64)}`;
    // A 20.00 claim, final in October, whose batch allocated 2.00 to the DAO.
    const claim = { batchId: 'batch-1', chainId: 84532, claimTransactionHash: TX_C, claimMicros: 2_000 * 10_000, daoMicros: 200 * 10_000, finalizedAtMs: NOW - 3_600_000 };
    const pass = (
      j: ReturnType<typeof journal>,
      verifier: () => Promise<boolean> = async () => true,
      claims: ReconciliationInputs['finalSettlementBatches'] = [claim],
    ) =>
      runReconciliationPass(
        { mode: 'provisional', workspaces: [WS] },
        {
          config: config(),
          resolveSecret: async () => SECRET,
          stripeLister: lister([charge, credits, payout]),
          cupboardInputs: async () => inputs({ finalSettlementBatches: claims }),
          chainVerifier: verifier,
          store: memoryReconciliationStore(),
          filer: recordingFiler().filer,
          post: j.post,
          readEntries: j.read,
          now: () => NOW,
          fetchImpl: capturingFetch().fetchImpl,
        },
      );
    const daoDetail = (ws: Awaited<ReturnType<typeof pass>>['workspaces'][number]) =>
      ws.run!.verdicts.find((v) => v.invariant === 'dao-payable-equals-accrued-minus-transferred')!;

    it('imports each final claim as a customer payment over the chain and reconciles the Worker accrual against it', async () => {
      const j = journal();
      const ws = (await pass(j)).workspaces[0]!;
      expect(ws.settlementClaimImport).toMatchObject({ scanned: 1, posted: 1, refused: [] });
      const entry = j.entries.get(`chain-tx:84532:${TX_C}`)!;
      expect(entry.movement).toBe('customer-payment');
      expect(entry.occurredAtMs).toBe(claim.finalizedAtMs);
      expect(entry.lines).toEqual(
        expect.arrayContaining([
          { account: 'operating', side: 'debit', cents: 2_000 },
          { account: 'dao-payable', side: 'credit', cents: 200 },
          { account: 'revenue', side: 'credit', cents: 1_800 },
        ]),
      );
      const status = Object.fromEntries(ws.run!.verdicts.map((v) => [v.invariant, v.status]));
      expect(status['dao-payable-equals-accrued-minus-transferred']).toBe('ok');
      // The claim is cash in on the chain rail, matched like the DAO transfer.
      expect(status['journal-matches-chain']).toBe('ok');
      expect(daoDetail(ws).detail).toBe(
        'journal dao-payable 700c; accrued 1200c (off-chain journal 1000c + final settlements 200c) - transferred on chain 500c = 700c',
      );
    });

    it('rounds each FINAL batch before summing DAO accrual and excludes finality at the period end', async () => {
      // Two 0.6-cent allocations round to two cents, whereas rounding their
      // combined 1.2 cents would understate the DAO liability by one cent.
      const claims = [
        { ...claim, batchId: 'round-1', claimTransactionHash: `0x${'1'.repeat(64)}`, claimMicros: 60_000, daoMicros: 6_000 },
        { ...claim, batchId: 'round-2', claimTransactionHash: `0x${'2'.repeat(64)}`, claimMicros: 60_000, daoMicros: 6_000 },
        // Accrual is cumulative: a prior-month FINAL batch still contributes.
        { ...claim, batchId: 'prior-month', claimTransactionHash: `0x${'3'.repeat(64)}`, claimMicros: 60_000, daoMicros: 6_000, finalizedAtMs: Date.UTC(2026, 8, 30) },
        { ...claim, batchId: 'at-end', claimTransactionHash: `0x${'4'.repeat(64)}`, finalizedAtMs: NOW },
      ];
      const j = journal();
      const ws = (await pass(j, async () => true, claims)).workspaces[0]!;
      expect(ws.settlementClaimImport).toMatchObject({ posted: 4, refused: [] });
      expect(daoDetail(ws)).toMatchObject({ status: 'ok' });
      expect(daoDetail(ws).detail).toContain('final settlements 3c');
      for (const c of claims.slice(0, 3)) {
        expect(j.entries.get(`chain-tx:84532:${c.claimTransactionHash}`)!.lines)
          .toContainEqual({ account: 'dao-payable', side: 'credit', cents: 1 });
      }
    });

    it('keeps a previously FINAL claim journaled and breaks DAO accrual until an explicit reversing entry', async () => {
      const j = journal();
      expect(daoDetail((await pass(j)).workspaces[0]!).status).toBe('ok');
      const original = j.entries.get(`chain-tx:84532:${TX_C}`)!;
      // The Worker omits a batch once it becomes disputed/refunded. That does
      // not erase its immutable import or silently forgive the liability.
      for (let run = 0; run < 2; run += 1) {
        const ws = (await pass(j, async () => true, [])).workspaces[0]!;
        expect(ws.settlementClaimImport).toMatchObject({ scanned: 0, posted: 0 });
        expect(j.entries.get(original.entryId)).toEqual(original);
        expect(daoDetail(ws)).toMatchObject({ status: 'broken' });
        expect(ws.run!.gate.open).toBe(false);
      }
      const reversal = validateJournalEntry({
        ...original,
        entryId: 'claim-refund-reversal',
        movement: 'refund',
        externalRef: { kind: 'chain-tx', chainId: 84532, txHash: `0x${'d'.repeat(64)}` },
        occurredAtMs: NOW - 1_000,
        memo: 'explicit reversal of refunded FINAL claim',
        lines: original.lines.map((line) => ({ ...line, side: line.side === 'credit' ? 'debit' : 'credit' })),
      });
      expect(reversal.ok).toBe(true);
      if (!reversal.ok) throw new Error(reversal.detail);
      await j.post()(reversal.entry);
      expect(daoDetail((await pass(j, async () => true, [])).workspaces[0]!).status).toBe('ok');
      expect(j.entries.get(original.entryId)).toEqual(original);
    });

    it('a journal entry for the claim that mis-splits the DAO share breaks the invariant', async () => {
      // The books already carry the claim, crediting the DAO 150c of its 200c allocation.
      const misSplit = journal();
      const seeded = (await pass(misSplit)).workspaces[0]!;
      expect(daoDetail(seeded).status).toBe('ok');
      const good = misSplit.entries.get(`chain-tx:84532:${TX_C}`)!;
      misSplit.entries.set(good.entryId, {
        ...good,
        lines: good.lines.map((l) =>
          l.account === 'dao-payable' ? { ...l, cents: 150 } : l.account === 'revenue' ? { ...l, cents: 1_850 } : l,
        ),
      });
      const ws = (await pass(misSplit)).workspaces[0]!;
      expect(ws.settlementClaimImport).toMatchObject({ duplicates: 1, posted: 0 });
      expect(daoDetail(ws).status).toBe('broken');
    });

    it('a claim the chain does not confirm is neither journaled nor accrued', async () => {
      const j = journal();
      const ws = (await pass(j, async () => false)).workspaces[0]!;
      expect(ws.settlementClaimImport).toMatchObject({ scanned: 0, posted: 0 });
      expect(j.entries.has(`chain-tx:84532:${TX_C}`)).toBe(false);
    });

    it('the parser refuses a Worker that omits the list, or lists a malformed or over-allocated batch', () => {
      const base = { outstandingCreditsMicros: 0, daoTransfers: [] };
      expect(() => parseReconciliationInputs(base)).toThrow(/finalSettlementBatches must be a list/);
      expect(() => parseReconciliationInputs({ ...base, finalSettlementBatches: [{ ...claim, daoMicros: null }] })).toThrow(
        /finalSettlementBatches\[0\]/,
      );
      expect(() => parseReconciliationInputs({ ...base, finalSettlementBatches: [{ ...claim, daoMicros: claim.claimMicros + 1 }] })).toThrow(
        /finalSettlementBatches\[0\]/,
      );
      expect(parseReconciliationInputs({ ...base, finalSettlementBatches: [{ ...claim, claimTransactionHash: TX_C.toUpperCase().replace('0X', '0x') }] }).finalSettlementBatches[0]!.claimTransactionHash).toBe(TX_C);
    });
  });

  it('a re-run is idempotent: nothing is re-posted and an open break files no second item', async () => {
    const j = journal();
    const store = memoryReconciliationStore();
    const { filer, filed } = recordingFiler();
    const deps = {
      config: config(),
      resolveSecret: async () => SECRET,
      stripeLister: lister([charge]),
      // No credit purchase was journaled, so any outstanding credit breaks the reserve invariant.
      cupboardInputs: async () => inputs({ outstandingCreditsMicros: 1, daoTransfers: [] }),
      chainVerifier: async () => true,
      store,
      filer,
      gate: { publish: async () => ({ published: true as const }) },
      post: j.post,
      readEntries: j.read,
      now: () => NOW,
    };
    const first = await runReconciliationPass({ mode: 'provisional', workspaces: [WS] }, deps);
    const second = await runReconciliationPass({ mode: 'provisional', workspaces: [WS] }, deps);
    expect(second.workspaces[0]!.stripeImport).toMatchObject({ posted: 0, duplicates: 1 });
    expect(first.workspaces[0]!.run!.opened).toEqual(['credit-reserve-covers-outstanding-credits']);
    expect(second.workspaces[0]!.run!.opened).toEqual([]);
    expect(filed).toEqual(['credit-reserve-covers-outstanding-credits']);
    expect(second.workspaces[0]!.run!.gate).toEqual({ open: false, reasons: ['break open: credit-reserve-covers-outstanding-credits'] });
    expect(store.runs).toHaveLength(2);
  });

  it('a journal entry citing a transaction the chain reports reverted breaks journal-matches-chain', async () => {
    const seeded = journal();
    // A previous run journaled TX_B; the chain now says it never succeeded.
    await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ stripeSecretKeyRef: null }),
        resolveSecret: async () => SECRET,
        cupboardInputs: async () => inputs({ daoTransfers: [{ transferId: 'tt-b', chainId: 84532, transactionHash: TX_B, amountMicros: 100 * 10_000, createdAtMs: NOW - 1000 }] }),
        chainVerifier: async () => true,
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        gate: { publish: async () => ({ published: true as const }) },
        post: seeded.post,
        readEntries: seeded.read,
        now: () => NOW,
      },
    );
    const { filer, filed } = recordingFiler();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ stripeSecretKeyRef: null }),
        resolveSecret: async () => SECRET,
        cupboardInputs: async () => inputs({ daoTransfers: [{ transferId: 'tt-b', chainId: 84532, transactionHash: TX_B, amountMicros: 100 * 10_000, createdAtMs: NOW - 1000 }] }),
        chainVerifier: async () => false,
        store: memoryReconciliationStore(),
        filer,
        gate: { publish: async () => ({ published: true as const }) },
        post: seeded.post,
        readEntries: seeded.read,
        now: () => NOW,
      },
    );
    const chain = result.workspaces[0]!.run!.verdicts.find((v) => v.invariant === 'journal-matches-chain')!;
    expect(chain.status).toBe('broken');
    expect(chain.detail).toContain(`chain-tx:84532:${TX_B}`);
    expect(filed).toContain('journal-matches-chain');
    expect(result.workspaces[0]!.run!.gate.open).toBe(false);
  });

  it('a Worker that cannot be read leaves the treasury invariants unknown, closes the gate, and says treasuryReconciled:false', async () => {
    const j = journal();
    const { calls, fetchImpl } = capturingFetch();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ stripeSecretKeyRef: null }),
        resolveSecret: async () => SECRET,
        cupboardInputs: async () => {
          throw new Error('cupboard reconciliation-inputs: status 503');
        },
        chainVerifier: null,
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        post: j.post,
        readEntries: j.read,
        now: () => NOW,
        fetchImpl,
      },
    );
    const run = result.workspaces[0]!.run!;
    const status = Object.fromEntries(run.verdicts.map((v) => [v.invariant, v.status]));
    expect(status['credit-reserve-covers-outstanding-credits']).toBe('unknown');
    expect(status['dao-payable-equals-accrued-minus-transferred']).toBe('unknown');
    expect(run.gate.open).toBe(false);
    expect(run.gate.reasons.join('\n')).toMatch(/cannot evaluate credit-reserve-covers-outstanding-credits: .*503/);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ open: false, treasuryReconciled: false });
  });

  it('a workspace that does not own the treasury never claims to have reconciled it', async () => {
    const j = journal();
    const { calls, fetchImpl } = capturingFetch();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: ['ws-other'] },
      {
        config: config({ stripeSecretKeyRef: null }),
        resolveSecret: async () => SECRET,
        cupboardInputs: async () => inputs(),
        chainVerifier: async () => true,
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        post: j.post,
        readEntries: j.read,
        now: () => NOW,
        fetchImpl,
      },
    );
    expect(result.workspaces[0]!.daoTransferImport).toMatchObject({ skipped: expect.stringMatching(/treasury/) });
    expect(j.entries.size).toBe(0);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ workspaceId: 'ws-other', open: true, treasuryReconciled: false });
  });

  it('a Stripe key without a payment policy reads Stripe as failed rather than mapping with a guessed split', async () => {
    const j = journal();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ policy: null, gateSecretRef: null }),
        resolveSecret: async () => SECRET,
        stripeLister: lister([charge]),
        cupboardInputs: null,
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        post: j.post,
        readEntries: j.read,
        now: () => NOW,
      },
    );
    const ws = result.workspaces[0]!;
    expect(ws.stripeImport).toMatchObject({ skipped: expect.stringMatching(/PAPERCUSP_MONEY_JOURNAL_POLICY/) });
    expect(ws.run!.verdicts.find((v) => v.invariant === 'journal-matches-stripe')).toMatchObject({ status: 'unknown' });
    expect(ws.run!.gatePublish).toMatchObject({ published: false, detail: expect.stringMatching(/GATE_SECRET_REF/) });
  });
});

describe('Worker clients', () => {
  it('the inputs reader signs a GET the Worker can verify, and parses the body', async () => {
    let seen: { url: string; header: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, header: (init.headers as Record<string, string>)[RECONCILIATION_SIGNATURE_HEADER]! };
      return Response.json(inputs());
    }) as unknown as typeof fetch;
    const read = cupboardInputsReader({ baseUrl: 'https://cupboard.test', secret: SECRET, fetchImpl, now: () => NOW });
    expect((await read()).daoTransfers).toHaveLength(1);
    expect(seen!.url).toBe('https://cupboard.test/commerce/treasury/reconciliation-inputs');
    expect(
      await verifyReconciliationRequest({ secret: SECRET, header: seen!.header, method: 'GET', pathname: '/commerce/treasury/reconciliation-inputs', body: '', nowMs: NOW }),
    ).toEqual({ ok: true });
  });

  it('the gate publisher reports a Worker refusal instead of claiming it published', async () => {
    const { fetchImpl } = capturingFetch(401);
    const publisher: GatePublisher = cupboardGatePublisher({ baseUrl: 'https://cupboard.test', secret: SECRET, treasuryReconciled: true, fetchImpl, now: () => NOW });
    const out = await publisher.publish({ workspaceId: WS, gate: { open: true, reasons: [] }, runId: 'r', atMs: NOW });
    expect(out).toMatchObject({ published: false, detail: expect.stringMatching(/401/) });
  });
});

// ---------------------------------------------------------------------------
// The DAO Safe (D-025 §1, WI-10004708): balance + receipts on chain, approved
// spends from the Worker's confirmed treasury transfers.
// ---------------------------------------------------------------------------

const SAFE = `0x${'5a'.repeat(20)}` as const;
const TOKEN = `0x${'70'.repeat(20)}` as const;
const PAYER = `0x${'11'.repeat(20)}`;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const topicFor = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

interface FakeTransfer {
  readonly block: number;
  readonly from: string;
  readonly value: bigint;
}

/** A JSON-RPC endpoint for one ERC-20: chain 84532, a fixed head, a Safe balance and its incoming Transfer logs. */
async function withFakeTokenRpc<T>(
  opts: { readonly head: number; readonly balance: bigint; readonly decimals?: number; readonly transfers: readonly FakeTransfer[] },
  fn: (rpc: { url: string; logWindows: Array<[number, number]>; callBlocks: string[] }) => Promise<T>,
): Promise<T> {
  const logWindows: Array<[number, number]> = [];
  const callBlocks: string[] = [];
  const answer = (method: string, params: unknown[]): unknown => {
    if (method === 'eth_chainId') return '0x14a34';
    if (method === 'eth_blockNumber') return `0x${opts.head.toString(16)}`;
    if (method === 'eth_call') {
      const call = params[0] as { data: string };
      callBlocks.push(String(params[1]));
      if (call.data.startsWith('0x70a08231')) return word(opts.balance);
      if (call.data.startsWith('0x313ce567')) return word(BigInt(opts.decimals ?? 6));
      throw new Error(`unexpected eth_call ${call.data.slice(0, 10)}`);
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: string; toBlock: string; topics: Array<string | null> };
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      logWindows.push([from, to]);
      expect(filter.topics[0]).toBe(TRANSFER_TOPIC);
      expect(String(filter.topics[2]).toLowerCase()).toBe(topicFor(SAFE));
      return opts.transfers
        .filter((t) => t.block >= from && t.block <= to)
        .map((t, i) => ({
          address: TOKEN,
          topics: [TRANSFER_TOPIC, topicFor(t.from), topicFor(SAFE)],
          data: word(t.value),
          blockNumber: `0x${t.block.toString(16)}`,
          blockHash: `0x${'b'.repeat(64)}`,
          transactionHash: `0x${t.block.toString(16).padStart(64, '0')}`,
          transactionIndex: '0x0',
          logIndex: `0x${i.toString(16)}`,
          removed: false,
        }));
    }
    throw new Error(`unexpected method ${method}`);
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const one = (r: { id: number; method: string; params?: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: r.id, result: answer(r.method, r.params ?? []) };
        } catch (error) {
          return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: String(error) } };
        }
      };
      const parsed = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn({ url: `http://127.0.0.1:${port}`, logWindows, callBlocks });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const SAFE_CONFIG = { status: 'configured', safeAddress: SAFE, tokenAddress: TOKEN, fromBlock: 100n } as const;
// 7,000,000 + 3,000,000 micros in; the Safe paying itself (block 231) is not a receipt.
const SAFE_RECEIPTS: readonly FakeTransfer[] = [
  { block: 105, from: PAYER, value: 7_000_000n },
  { block: 230, from: PAYER, value: 3_000_000n },
  { block: 231, from: SAFE, value: 9n },
];

describe('the DAO Safe source', () => {
  it('parses the Safe configuration, refusing a partial or malformed one', () => {
    expect(parseSafeReadConfig({})).toEqual({ status: 'not-configured' });
    expect(parseSafeReadConfig({ PAPERCUSP_RECONCILIATION_SAFE_ADDRESS: SAFE })).toMatchObject({ status: 'invalid', detail: expect.stringMatching(/TOKEN_ADDRESS/) });
    expect(
      parseSafeReadConfig({ PAPERCUSP_RECONCILIATION_SAFE_ADDRESS: SAFE, PAPERCUSP_RECONCILIATION_SAFE_TOKEN_ADDRESS: TOKEN, PAPERCUSP_RECONCILIATION_SAFE_FROM_BLOCK: '1e5' }),
    ).toMatchObject({ status: 'invalid', detail: expect.stringMatching(/FROM_BLOCK/) });
    expect(
      parseSafeReadConfig({
        PAPERCUSP_RECONCILIATION_SAFE_ADDRESS: SAFE.toUpperCase().replace('0X', '0x'),
        PAPERCUSP_RECONCILIATION_SAFE_TOKEN_ADDRESS: TOKEN,
        PAPERCUSP_RECONCILIATION_SAFE_FROM_BLOCK: '100',
      }),
    ).toEqual(SAFE_CONFIG);
  });

  it('reads the balance at one pinned block and sums incoming transfers across log windows', async () => {
    await withFakeTokenRpc({ head: 300, balance: 9_000_000n, transfers: SAFE_RECEIPTS }, async ({ url, logWindows, callBlocks }) => {
      const state = await viemSafeChainReader(url, { blockSpan: 50n })({ safeAddress: SAFE, tokenAddress: TOKEN, fromBlock: 100n });
      expect(state).toEqual({ chainId: 84532, blockNumber: 300n, decimals: 6, balance: 9_000_000n, received: 10_000_000n });
      expect(logWindows).toEqual([[100, 149], [150, 199], [200, 249], [250, 299], [300, 300]]);
      expect(new Set(callBlocks)).toEqual(new Set(['0x12c']));
      await expect(
        viemSafeChainReader(url, { blockSpan: 50n, maxSpans: 4 })({ safeAddress: SAFE, tokenAddress: TOKEN, fromBlock: 100n }),
      ).rejects.toThrow(/exceed the limit of 4/);
    });
  });

  it('fails closed on a non-6-decimal token, a transfer from another chain, or an unreadable chain', async () => {
    const state: SafeChainState = { chainId: 84532, blockNumber: 300n, decimals: 6, balance: 5n, received: 10n };
    const spend = inputs().daoTransfers;
    const read = (s: Partial<SafeChainState>, spends = spend) =>
      readSafeSnapshot({ reader: async () => ({ ...state, ...s }), safeAddress: SAFE, tokenAddress: TOKEN, fromBlock: 100n, approvedSpends: spends });
    expect(await read({ decimals: 18 })).toMatchObject({ status: 'failed', detail: expect.stringMatching(/18 decimals/) });
    expect(await read({ chainId: 8453 })).toMatchObject({ status: 'failed', detail: expect.stringMatching(/chain 84532, but the Safe is read on chain 8453/) });
    expect(
      await readSafeSnapshot({
        reader: async () => {
          throw new Error('rpc down');
        },
        safeAddress: SAFE,
        tokenAddress: TOKEN,
        fromBlock: 100n,
        approvedSpends: [],
      }),
    ).toEqual({ status: 'failed', detail: 'the Safe could not be read on chain: rpc down' });
    expect(await read({ balance: 5_000_000n, received: 10_000_000n })).toEqual({
      status: 'ok',
      value: { balanceMicros: 5_000_000, receiptsMicros: 10_000_000, approvedSpendsMicros: 5_000_000 },
    });
  });

  async function passOverFakeChain(balance: bigint) {
    return withFakeTokenRpc({ head: 300, balance, transfers: SAFE_RECEIPTS }, async ({ url }) => {
      const j = journal();
      const { filer, filed } = recordingFiler();
      const { calls, fetchImpl } = capturingFetch();
      const result = await runReconciliationPass(
        { mode: 'provisional', workspaces: [WS] },
        {
          config: config({ chainRpcUrl: url, safe: SAFE_CONFIG }),
          resolveSecret: async () => SECRET,
          stripeLister: lister([charge, credits, payout]),
          // One approved spend of 5,000,000 micros (500c), confirmed on chain 84532.
          cupboardInputs: async () => inputs(),
          chainVerifier: async () => true,
          store: memoryReconciliationStore(),
          filer,
          post: j.post,
          readEntries: j.read,
          now: () => NOW,
          fetchImpl,
        },
      );
      const ws = result.workspaces[0]!;
      const safe = ws.run!.verdicts.find((v) => v.invariant === 'safe-balance-equals-receipts-minus-approved-spends')!;
      const push = parseTransferGatePush(JSON.parse(calls[0]!.body));
      if (!push) throw new Error('the pass pushed no parseable gate');
      return { ws, safe, filed, push };
    });
  }

  it('a Safe holding receipts minus approved spends reconciles and leaves the gate open', async () => {
    const { ws, safe, filed, push } = await passOverFakeChain(5_000_000n);
    expect(ws.error).toBeNull();
    expect(safe).toMatchObject({ status: 'ok', detail: 'Safe balance 5000000 micros; receipts 10000000 - approved spends 5000000 = 5000000 micros' });
    expect(filed).toEqual([]);
    expect(push).toMatchObject({ open: true, treasuryReconciled: true });
  });

  it('a Safe short of receipts minus approved spends (an unapproved spend) opens a break and closes the gate', async () => {
    const { safe, filed, push } = await passOverFakeChain(4_000_000n);
    expect(safe).toMatchObject({ status: 'broken', detail: 'Safe balance 4000000 micros; receipts 10000000 - approved spends 5000000 = 5000000 micros' });
    expect(filed).toEqual(['safe-balance-equals-receipts-minus-approved-spends']);
    expect(push.open).toBe(false);
    expect(push.reasons.join(' ')).toMatch(/safe-balance-equals-receipts-minus-approved-spends/);
  });

  it('a configured Safe with no way to read approved spends is a failed source, not a pass', async () => {
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ chainRpcUrl: 'http://127.0.0.1:9', safe: SAFE_CONFIG, gateSecretRef: null }),
        resolveSecret: async () => SECRET,
        stripeLister: lister([]),
        safeReader: async () => {
          throw new Error('must not be read without approved spends');
        },
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        gate: { publish: async () => ({ published: true as const }) },
        post: journal().post,
        readEntries: journal().read,
        now: () => NOW,
      },
    );
    const safe = result.workspaces[0]!.run!.verdicts.find((v) => v.invariant === 'safe-balance-equals-receipts-minus-approved-spends')!;
    expect(safe.status).toBe('unknown');
    expect(safe.detail).toMatch(/approved spends could not be read/);
  });
});
