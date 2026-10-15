import { signPaymentTestVoucher, paymentTestVerifier } from './_payment-voucher-fixture';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { paymentVoucherSigningBytes, unsignedVoucher } from './microcharge';
import { describe, expect, it } from 'vitest';
import { createPaymentChannel, refundableEscrow, settleVoucherBatch as rawSettleVoucherBatch } from './payment-channel';
import type { CumulativePaymentVoucher } from './microcharge';

const voucher = (overrides: Partial<CumulativePaymentVoucher> = {}): CumulativePaymentVoucher => signPaymentTestVoucher({
  channelId: 'c-1', payer: 'buyer', seller: 'host', releaseRef: 'plugin@1', usageNonce: 'n-1', meterQuantity: 1n,
  pricePerUnitMicros: 2n, priceVersion: 'p1', splitManifestHash: 'split', expiresAtMs: 10_000, cumulativeClaimMicros: 2n, signature: 'sig', ...overrides,
}, overrides.signature);


function settleVoucherBatch(input: Parameters<typeof rawSettleVoucherBatch>[0]): ReturnType<typeof rawSettleVoucherBatch> {
  return rawSettleVoucherBatch({ verifySignature: paymentTestVerifier('c-1', 'buyer'), ...input });
}

describe('payment-channel adapter', () => {
  it('fails closed without a verifier and when the verifier throws', () => {
    const channel = createPaymentChannel('c-1', 'evm-x402', 100n);
    const input = { channel, vouchers: [voucher()], nowMs: 1_000 };
    expect(rawSettleVoucherBatch(input)).toMatchObject({ ok: false, code: 'invalid-signature' });
    expect(rawSettleVoucherBatch({ ...input, verifySignature: () => { throw new Error('unavailable authority'); } }))
      .toMatchObject({ ok: false, code: 'invalid-signature' });
    expect(channel.settledMicros).toBe(0n);
  });

  it.each([NaN, Infinity, -1, 1.5])('refuses invalid signed expiry %s', (expiresAtMs) => {
    expect(settleVoucherBatch({ channel: createPaymentChannel('c-1', 'evm-x402', 100n),
      vouchers: [voucher({ expiresAtMs })], nowMs: 1_000 })).toMatchObject({ ok: false, code: 'expired' });
  });

  it.each([
    { payer: 'attacker' }, { seller: 'other-host' }, { releaseRef: 'plugin@2' },
    { usageNonce: 'substituted' }, { meterQuantity: 2n }, { pricePerUnitMicros: 3n },
    { priceVersion: 'p2' }, { splitManifestHash: 'other-split' }, { expiresAtMs: 20_000 },
    { cumulativeClaimMicros: 3n }, { signature: 'forged' },
  ])('refuses changed signed payment terms %#', (change) => {
    const signed = voucher();
    expect(settleVoucherBatch({ channel: createPaymentChannel('c-1', 'evm-x402', 100n),
      vouchers: [{ ...signed, ...change }], nowMs: 1_000 })).toMatchObject({ ok: false, code: 'invalid-signature' });
  });

  it('refuses a signature for a different payer', () => {
    expect(rawSettleVoucherBatch({ channel: createPaymentChannel('c-1', 'evm-x402', 100n), vouchers: [voucher()],
      nowMs: 1_000, verifySignature: paymentTestVerifier('c-1', 'another-payer') }))
      .toMatchObject({ ok: false, code: 'invalid-signature' });
  });

  it('refuses a real signature from an unbound key for the same payer', () => {
    const stranger = generateEd25519KeypairDer(); const signed = voucher();
    const forged = { ...signed, signature: signWithPrivateKeyDer(stranger.privateKeyDer,
      paymentVoucherSigningBytes(unsignedVoucher(signed))).toString('base64') };
    expect(settleVoucherBatch({ channel: createPaymentChannel('c-1', 'evm-x402', 100n),
      vouchers: [forged], nowMs: 1_000 })).toMatchObject({ ok: false, code: 'invalid-signature' });
  });

  it('settles cumulative vouchers in a batch and exposes refundable escrow', () => {
    const channel = createPaymentChannel('c-1', 'evm-x402', 10n);
    const result = settleVoucherBatch({ channel, vouchers: [voucher(), voucher({ usageNonce: 'n-2', cumulativeClaimMicros: 5n })], nowMs: 1_000 });
    expect(result).toMatchObject({ ok: true, claimMicros: 5n });
    if (result.ok) expect(refundableEscrow(result.channel)).toBe(5n);
  });

  it('rejects duplicate, non-monotonic, expired, disputed, and cap-exceeding batches', () => {
    const channel = createPaymentChannel('c-1', 'lightning', 10n);
    expect(settleVoucherBatch({ channel, vouchers: [voucher(), voucher()], nowMs: 1_000 })).toMatchObject({ ok: false, code: 'duplicate-claim' });
    expect(settleVoucherBatch({ channel, vouchers: [voucher({ usageNonce: 'n-2', cumulativeClaimMicros: 1n })], nowMs: 1_000 })).toMatchObject({ ok: true });
    expect(settleVoucherBatch({ channel, vouchers: [voucher({ expiresAtMs: 1 })], nowMs: 2_000 })).toMatchObject({ ok: false, code: 'expired' });
    expect(settleVoucherBatch({ channel, vouchers: [voucher()], nowMs: 1_000, disputed: true })).toMatchObject({ ok: false, code: 'dispute' });
    expect(settleVoucherBatch({ channel: createPaymentChannel('c-1', 'evm-x402', 1n), vouchers: [voucher()], nowMs: 1_000 })).toMatchObject({ ok: false, code: 'escrow-exhausted' });
  });
});
