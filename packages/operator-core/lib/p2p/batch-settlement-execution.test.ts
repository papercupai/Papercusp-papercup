import { signPaymentTestVoucher, paymentTestVerifier } from './_payment-voucher-fixture';
/**
 * P-033 batch settlement execution — pure pipeline.
 *
 * The door tests (apps/operator-public/src/__tests__/settlements.test.ts) drive
 * the same code through the real Worker route over migrated D1. These cover the
 * arithmetic and the claim-vs-finality state machine directly, including the
 * paths a door test cannot reach cheaply: a reorg at every failure shape, and a
 * split that does not add up.
 */
import { describe, expect, it } from 'vitest';
import {
  assessClaimFinality,
  buildSettlementProofEvent,
  isSettlementFrozen,
  planBatchSettlement as rawPlanBatchSettlement,
  unwindReorgedClaim,
  type EvmSettlementConfig,
} from './evm-settlement';
import { createPaymentChannel, settleVoucherBatch as rawSettleVoucherBatch } from './payment-channel';
import { paymentVoucherDigest, unsignedVoucher, type CumulativePaymentVoucher } from './microcharge';
import { revenueSplitManifest } from './revenue-settlement';
import { validateCommerceEvent } from './commerce-events';

const config: EvmSettlementConfig = {
  chainId: 84_532,
  settlementContract: '0x1111111111111111111111111111111111111111',
  stablecoin: '0x2222222222222222222222222222222222222222',
  maxBatchSize: 50,
};

const SPLIT = revenueSplitManifest({
  version: 'v1',
  sharesBps: { creator: 6_000, host: 2_000, component: 500, dao: 1_000, reserve: 300, tax: 100, operating: 100 },
});

const TREASURY = '0x3333333333333333333333333333333333333333';

function voucher(overrides: Partial<CumulativePaymentVoucher> = {}): CumulativePaymentVoucher {
  return signPaymentTestVoucher({
    channelId: 'chan-1',
    payer: 'gh:1',
    seller: 'gh:2',
    releaseRef: 'release:widget@1.0.0',
    usageNonce: 'nonce-1',
    meterQuantity: 1n,
    pricePerUnitMicros: 1_000n,
    priceVersion: 'p1',
    splitManifestHash: SPLIT.manifestHash,
    expiresAtMs: 10_000,
    cumulativeClaimMicros: 1_000n,
    signature: 'sig',
    ...overrides,
  }, overrides.signature);
}

function plan(vouchers: readonly CumulativePaymentVoucher[], overrides: { disputed?: boolean; escrow?: bigint; providerCostMicros?: bigint } = {}) {
  return planBatchSettlement({
    config,
    channel: createPaymentChannel('chan-1', 'evm-x402', overrides.escrow ?? 1_000_000n),
    vouchers,
    nowMs: 1_000,
    settlementId: 'settlement:chan-1:1',
    splitManifest: SPLIT,
    daoTreasury: TREASURY,
    providerCostMicros: overrides.providerCostMicros,
    disputed: overrides.disputed,
  });
}


function settleVoucherBatch(input: Parameters<typeof rawSettleVoucherBatch>[0]): ReturnType<typeof rawSettleVoucherBatch> {
  return rawSettleVoucherBatch({ verifySignature: paymentTestVerifier('chan-1', 'gh:1'), ...input });
}
function planBatchSettlement(input: Parameters<typeof rawPlanBatchSettlement>[0]): ReturnType<typeof rawPlanBatchSettlement> {
  return rawPlanBatchSettlement({ verifySignature: paymentTestVerifier('chan-1', 'gh:1'), ...input });
}

describe('planBatchSettlement', () => {
  it('drives settleVoucherBatch output into the EVM request and an integer-atomic split', () => {
    const vouchers = [voucher(), voucher({ usageNonce: 'nonce-2', cumulativeClaimMicros: 3_000n })];
    const result = plan(vouchers);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The claim is the DELTA of the cumulative watermark, not the sum of the
    // vouchers — that is the whole point of a cumulative voucher.
    expect(result.plan.claimMicros).toBe(3_000n);
    expect(result.plan.cumulativeClaimMicros).toBe(3_000n);
    expect(result.plan.request.amountMicros).toBe(3_000n);
    expect(result.plan.request.chainId).toBe(config.chainId);

    // Exactly the digests settleVoucherBatch admitted, in its order.
    expect(result.plan.voucherDigests).toEqual(vouchers.map((v) => paymentVoucherDigest(unsignedVoucher(v))));

    // Integer-atomic: every distributable micro-unit lands in exactly one share.
    const allocations = Object.values(result.plan.receipt.allocationsMicros);
    expect(allocations.reduce((sum, value) => sum + value, 0n)).toBe(result.plan.receipt.distributableMicros);
    expect(result.plan.receipt.distributableMicros).toBe(3_000n);
    expect(result.plan.receipt.splitManifestHash).toBe(SPLIT.manifestHash);
  });

  it('assigns the rounding remainder to the DAO so no micro-unit is lost', () => {
    // 1 micro cannot be split 60/20/5/10/3/1/1 without a remainder.
    const result = plan([voucher({ cumulativeClaimMicros: 1n })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { allocationsMicros, distributableMicros } = result.plan.receipt;
    expect(distributableMicros).toBe(1n);
    expect(Object.values(allocationsMicros).reduce((sum, value) => sum + value, 0n)).toBe(1n);
    expect(allocationsMicros.dao).toBe(1n);
  });

  it('subtracts provider cost before splitting, and refuses a cost above gross', () => {
    const ok = plan([voucher({ cumulativeClaimMicros: 10_000n })], { providerCostMicros: 4_000n });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.plan.claimMicros).toBe(10_000n);
      expect(ok.plan.receipt.distributableMicros).toBe(6_000n);
    }
    expect(plan([voucher()], { providerCostMicros: 5_000n })).toMatchObject({ ok: false, code: 'cost-exceeds-gross' });
  });

  it('never reaches the rail when the channel refuses the batch', () => {
    expect(plan([])).toMatchObject({ ok: false, code: 'empty-batch' });
    expect(plan([voucher()], { disputed: true })).toMatchObject({ ok: false, code: 'dispute' });
    expect(plan([voucher({ signature: '   ' })])).toMatchObject({ ok: false, code: 'invalid-signature' });
    expect(plan([voucher({ expiresAtMs: 10 })])).toMatchObject({ ok: false, code: 'expired' });
    expect(plan([voucher(), voucher({ usageNonce: 'nonce-2' })])).toMatchObject({ ok: false, code: 'non-monotonic' });
    expect(plan([voucher()], { escrow: 10n })).toMatchObject({ ok: false, code: 'escrow-exhausted' });
  });

  it('produces the same request hash for the same batch and a different one for a different batch', () => {
    const a = plan([voucher()]);
    const b = plan([voucher()]);
    const c = plan([voucher({ cumulativeClaimMicros: 2_000n })]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.plan.request.requestHash).toBe(b.plan.request.requestHash);
    expect(a.plan.request.requestHash).not.toBe(c.plan.request.requestHash);
  });
});

describe('claim versus finality (acceptance line 14)', () => {
  const claim = { transactionHash: `0x${'a'.repeat(64)}`, blockNumber: 100n, blockHash: `0x${'b'.repeat(64)}` };

  it('reports a shallow claim as a claim, not as finality', () => {
    const verdict = assessClaimFinality({
      claim,
      observation: { present: true, blockNumber: 100n, blockHash: claim.blockHash, headBlockNumber: 103n },
      requiredConfirmations: 12,
    });
    expect(verdict).toMatchObject({ state: 'claimed', final: false, confirmations: 4 });
  });

  it('reports finality only once the required depth is reached', () => {
    const shallow = assessClaimFinality({
      claim,
      observation: { present: true, blockNumber: 100n, blockHash: claim.blockHash, headBlockNumber: 110n },
      requiredConfirmations: 12,
    });
    expect(shallow.final).toBe(false);
    const deep = assessClaimFinality({
      claim,
      observation: { present: true, blockNumber: 100n, blockHash: claim.blockHash, headBlockNumber: 111n },
      requiredConfirmations: 12,
    });
    expect(deep).toMatchObject({ state: 'final', final: true, confirmations: 12 });
  });

  it('treats a dropped, reverted, or re-mined transaction as a reorg', () => {
    expect(
      assessClaimFinality({ claim, observation: { present: false, headBlockNumber: 130n }, requiredConfirmations: 12 }),
    ).toMatchObject({ state: 'reorged', reason: 'dropped', final: false });
    expect(
      assessClaimFinality({
        claim,
        observation: { present: true, blockNumber: 100n, blockHash: claim.blockHash, headBlockNumber: 130n, reverted: true },
        requiredConfirmations: 12,
      }),
    ).toMatchObject({ state: 'reorged', reason: 'reverted' });
    expect(
      assessClaimFinality({
        claim,
        observation: { present: true, blockNumber: 101n, blockHash: `0x${'c'.repeat(64)}`, headBlockNumber: 130n },
        requiredConfirmations: 12,
      }),
    ).toMatchObject({ state: 'reorged', reason: 'block-hash-changed' });
  });

  it('never reports a negative or fractional confirmation depth', () => {
    const behindHead = assessClaimFinality({
      claim,
      observation: { present: true, blockNumber: 100n, blockHash: claim.blockHash, headBlockNumber: 98n },
      requiredConfirmations: 12,
    });
    expect(behindHead).toMatchObject({ state: 'claimed', confirmations: 0 });
  });
});

describe('reorg recovery', () => {
  it('restores the channel exactly, so the same vouchers can be re-claimed', () => {
    const vouchers = [voucher(), voucher({ usageNonce: 'nonce-2', cumulativeClaimMicros: 3_000n })];
    const before = createPaymentChannel('chan-1', 'evm-x402', 1_000_000n);
    const settled = settleVoucherBatch({ channel: before, vouchers, nowMs: 1_000 });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    const unwound = unwindReorgedClaim({
      channel: settled.channel,
      claimMicros: settled.claimMicros,
      voucherDigests: settled.voucherDigests,
      priorCumulativeMicros: before.lastCumulativeMicros,
    });
    expect(unwound.ok).toBe(true);
    if (!unwound.ok) return;
    expect(unwound.channel).toEqual(before);

    // The recovery is only meaningful if the batch becomes claimable again.
    const reclaimed = settleVoucherBatch({ channel: unwound.channel, vouchers, nowMs: 1_000 });
    expect(reclaimed).toMatchObject({ ok: true, claimMicros: 3_000n });
  });

  it('refuses an unwind the channel cannot support rather than corrupting it', () => {
    const channel = createPaymentChannel('chan-1', 'evm-x402', 1_000n);
    expect(
      unwindReorgedClaim({ channel, claimMicros: 5n, voucherDigests: [], priorCumulativeMicros: 0n }),
    ).toMatchObject({ ok: false, code: 'unwind-mismatch' });

    const settled = settleVoucherBatch({ channel, vouchers: [voucher()], nowMs: 1_000 });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(
      unwindReorgedClaim({
        channel: settled.channel,
        claimMicros: settled.claimMicros,
        voucherDigests: ['a-digest-this-channel-never-claimed'],
        priorCumulativeMicros: 0n,
      }),
    ).toMatchObject({ ok: false, code: 'unwind-mismatch' });
  });
});

describe('settlement freeze', () => {
  it('freezes on a dispute and on an un-recovered reorg, and thaws once recovered', () => {
    expect(isSettlementFrozen([])).toEqual({ frozen: false });
    expect(isSettlementFrozen([{ state: 'claimed' }, { state: 'final' }])).toEqual({ frozen: false });
    expect(isSettlementFrozen([{ state: 'disputed' }])).toMatchObject({ frozen: true, reason: 'dispute' });
    expect(isSettlementFrozen([{ state: 'reorged', recovered: false }])).toMatchObject({ frozen: true, reason: 'reorg' });
    expect(isSettlementFrozen([{ state: 'reorged', recovered: true }])).toEqual({ frozen: false });
    // A dispute outranks a recovered reorg.
    expect(
      isSettlementFrozen([{ state: 'reorged', recovered: true }, { state: 'disputed' }]),
    ).toMatchObject({ frozen: true, reason: 'dispute' });
  });
});

describe('settlement proof events', () => {
  const transaction = { transactionHash: `0x${'a'.repeat(64)}`, blockNumber: 100n, blockHash: `0x${'b'.repeat(64)}` };

  it('emits a valid P-016 event that reports claim and finality distinctly', () => {
    const planned = plan([voucher()]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const claimed = { ...buildSettlementProofEvent({ streamId: 'settlement:chan-1', issuer: '0xsigner', sequence: 0, occurredAtMs: 5, plan: planned.plan, finality: 'claimed', confirmations: 1, chainId: config.chainId, transaction }), signature: 'sig' };
    const final = { ...buildSettlementProofEvent({ streamId: 'settlement:chan-1', issuer: '0xsigner', sequence: 1, occurredAtMs: 9, plan: planned.plan, finality: 'final', confirmations: 12, chainId: config.chainId, transaction }), signature: 'sig' };

    expect(validateCommerceEvent(claimed)).toMatchObject({ ok: true });
    expect(validateCommerceEvent(final)).toMatchObject({ ok: true });
    expect(claimed.kind).toBe('settlement-proof');
    expect(claimed.payload.final).toBe(false);
    expect(final.payload.final).toBe(true);

    // Two distinct, individually idempotent facts about one claim.
    expect(claimed.eventId).not.toBe(final.eventId);
    expect(claimed.idempotencyKey).toContain(planned.plan.request.requestHash);

    // Amounts cross the wire as decimal strings; JSON cannot carry a bigint.
    expect(claimed.payload.claimMicros).toBe('1000');
    expect(claimed.payload.allocationsMicros).toMatchObject({ creator: '600', dao: '100' });
    expect(claimed.payload.receiptHash).toBe(planned.plan.receipt.receiptHash);
  });

  it('is byte-stable for the same claim, so a replay cannot inflate the stream', () => {
    const planned = plan([voucher()]);
    if (!planned.ok) throw new Error('plan failed');
    const args = { streamId: 'settlement:chan-1', issuer: '0xsigner', sequence: 0, occurredAtMs: 5, plan: planned.plan, finality: 'claimed' as const, confirmations: 1, chainId: config.chainId, transaction };
    expect(buildSettlementProofEvent(args)).toEqual(buildSettlementProofEvent(args));
  });
});
