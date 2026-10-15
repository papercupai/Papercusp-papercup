import { signPaymentTestVoucher, paymentTestVerifier } from './_payment-voucher-fixture';
/**
 * P2P commerce + BYOC shadow pilot (P-019).
 *
 * This is the pre-network rehearsal the plan item asks for, executed as an
 * agent-runnable pilot against the REAL code paths rather than a document: it
 * composes the shipped modules — commerce events (P-016), microcharge vouchers
 * (P-021), payment channels + EVM settlement (P-022), revenue settlement
 * (P-018), Safe treasury controls (P-023), BYOC execution (P-017) and artifact
 * distribution (P-015) — and asserts the properties that only exist at the
 * SEAMS between them.
 *
 * Unit tests already cover each module alone. What this pilot exists to catch
 * is the class of bug no single module can see: a voucher digest that does not
 * survive the hop from usage receipt to channel claim, a settlement receipt
 * hash that does not reach the treasury authorization, a split manifest that is
 * priced under one hash and settled under another, an entitlement that stays
 * resolvable after its key is revoked. Each `it` below names one clause of the
 * P-019 item.
 */
import { describe, expect, it } from 'vitest';
import {
  reduceDistributionEvents,
  resolveDistributionSources,
  type ArtifactDistributionManifest,
  type DistributionEvent,
} from './artifact-distribution';
import { reduceCommerceEvents, type CommerceEvent } from './commerce-events';
import { createByocBudget, prepareByocExecution, settleByocExecution } from './byoc-execution';
import { emptyMeteringLedger, spentOn } from './metering-ledger';
import {
  createMicrochargeChannel,
  paymentVoucherDigest,
  reserveMicrocharge,
  settleMicrocharge,
  unsignedVoucher,
  type CumulativePaymentVoucher,
} from './microcharge';
import { createPaymentChannel, refundableEscrow, settleVoucherBatch as rawSettleVoucherBatch } from './payment-channel';
import { buildEvmBatchSettlementRequest, validateEvmSettlementConfig, type EvmSettlementConfig } from './evm-settlement';
import { settleRevenue, type RevenueSplitManifest } from './revenue-settlement';
import { authorizeTreasuryTransfer, type SafeTreasuryConfig } from './treasury-controls';

// ---------------------------------------------------------------- fixtures

const HASH_PLAINTEXT = `sha256:${'a'.repeat(64)}`;
const HASH_CIPHERTEXT = `sha256:${'b'.repeat(64)}`;
const HASH_CHUNK = `sha256:${'c'.repeat(64)}`;

const SPLIT: RevenueSplitManifest = {
  version: 'v1',
  manifestHash: 'split-hash-v1',
  sharesBps: { creator: 6_000, host: 1_500, component: 500, dao: 1_000, reserve: 500, tax: 300, operating: 200 },
};

const CHANNEL_ID = 'chan-pilot-1';
const RELEASE_REF = 'plugin:demo@1.0.0';

/** Treasury controls validate real EVM address shape, so the pilot uses real-shaped ones. */
const USDC = `0x${'a1'.repeat(20)}`;
const WALLET_HOST = `0x${'b2'.repeat(20)}`;
const WALLET_DAO = `0x${'c3'.repeat(20)}`;
const WALLET_CREATOR = `0x${'d4'.repeat(20)}`;
const WALLET_STRANGER = `0x${'e5'.repeat(20)}`;
const TOKEN_UNLISTED = `0x${'f6'.repeat(20)}`;

const voucher = (overrides: Partial<CumulativePaymentVoucher> = {}): CumulativePaymentVoucher => signPaymentTestVoucher({
  channelId: CHANNEL_ID,
  payer: 'buyer-1',
  seller: 'creator-1',
  releaseRef: RELEASE_REF,
  usageNonce: 'use-1',
  meterQuantity: 10n,
  pricePerUnitMicros: 100n,
  priceVersion: 'price-v1',
  splitManifestHash: SPLIT.manifestHash,
  expiresAtMs: 10_000,
  cumulativeClaimMicros: 1_000n,
  signature: 'voucher-sig',
  ...overrides,
}, overrides.signature);

const commerceEvent = (overrides: Partial<CommerceEvent> = {}): CommerceEvent => ({
  eventId: 'c-1',
  streamId: 'order-1',
  kind: 'order',
  version: 1,
  issuer: 'buyer-1',
  sequence: 0,
  occurredAtMs: 1_000,
  idempotencyKey: 'c-idem-1',
  payload: { releaseRef: RELEASE_REF },
  signature: 'sig',
  ...overrides,
});

const privateRelease = (): ArtifactDistributionManifest => ({
  schemaVersion: 1,
  release: {
    schemaVersion: 1,
    listingKind: 'plugin',
    listingRef: 'demo',
    releaseVersion: '1.0.0',
    contentHash: HASH_PLAINTEXT,
    signature: 'release-sig',
    dependencies: [],
    compatibility: { runtime: 'papercusp>=1' },
    permissions: ['network:read'],
    capabilities: ['tool:invoke'],
    license: 'MIT',
    publisher: { githubUserId: 42 },
    reviewStatus: 'approved',
  },
  rootHash: HASH_CIPHERTEXT,
  totalSizeBytes: 100,
  chunks: [{ index: 0, contentHash: HASH_CHUNK, sizeBytes: 100 }],
  visibility: 'private',
  encryption: { scheme: 'aes-256-gcm', keyVersion: 1, ciphertextHash: HASH_CIPHERTEXT, wrappedKeyIds: ['wk-buyer-1'] },
  pinning: { minReplicas: 1, advertisementTtlMs: 60_000, offlineGraceMs: 60_000, yankRetentionMs: 60_000 },
  signature: 'dist-sig',
});

const distEvent = (overrides: Partial<DistributionEvent> = {}): DistributionEvent => ({
  eventId: 'd-1',
  streamId: 'dist:plugin:demo@1.0.0',
  kind: 'release-published',
  version: 1,
  issuer: 'creator-1',
  sequence: 0,
  occurredAtMs: 1_000,
  idempotencyKey: 'd-idem-1',
  payload: { manifest: privateRelease() },
  signature: 'sig',
  ...overrides,
});

/** Publish + one pinner, so the release is genuinely deliverable before we revoke anything. */
const entitledStream = (extra: DistributionEvent[] = []) =>
  reduceDistributionEvents([
    distEvent(),
    distEvent({
      eventId: 'd-2',
      kind: 'pin-committed',
      sequence: 1,
      idempotencyKey: 'd-idem-2',
      payload: { source: { sourceId: 'pin-1', class: 'pinner', providerId: 'r2', locator: 'opaque', advertisedAtMs: 1_000, expiresAtMs: null } },
    }),
    ...extra,
  ]).states[0];

// ------------------------------------------------------------------ pilot


function settleVoucherBatch(input: Parameters<typeof rawSettleVoucherBatch>[0]): ReturnType<typeof rawSettleVoucherBatch> {
  return rawSettleVoucherBatch({ verifySignature: paymentTestVerifier('chan-pilot-1', 'buyer-1'), ...input });
}

describe('P2P commerce + BYOC pilot — end-to-end happy path', () => {
  it('carries one purchase from voucher to usage receipt to channel claim to treasury payout with no value invented or lost', () => {
    const v = voucher();

    // 1. Reserve against the microcharge channel, execute, settle actual usage.
    const channel = createMicrochargeChannel(CHANNEL_ID, 5_000n);
    const reserved = reserveMicrocharge(channel, v, 1_000);
    expect(reserved).toMatchObject({ ok: true, deltaMicros: 1_000n });
    if (!reserved.ok) return;

    const settled = settleMicrocharge({ channel: reserved.channel, voucher: v, actualAmountMicros: 800n, occurredAtMs: 2_000, receiptSignature: 'receipt-sig' });
    expect(settled).toMatchObject({ ok: true });
    if (!settled.ok) return;
    // Under-use releases the unspent reservation rather than charging the reserved delta.
    expect(settled.channel.committedMicros).toBe(800n);
    expect(settled.channel.reservations).toEqual({});

    // 2. THE SEAM: the receipt's voucher digest must be the very digest the
    //    payment channel later claims against. If these two ever diverge, a
    //    settled receipt could be replayed as an unclaimed voucher.
    const digest = paymentVoucherDigest(unsignedVoucher(v));
    expect(settled.receipt.voucherDigest).toBe(digest);

    const rail = createPaymentChannel(CHANNEL_ID, 'evm-x402', 5_000n);
    const batch = settleVoucherBatch({ channel: rail, vouchers: [v], nowMs: 2_000 });
    expect(batch).toMatchObject({ ok: true, claimMicros: 1_000n });
    if (!batch.ok) return;
    expect(batch.voucherDigests).toEqual([digest]);

    // 3. Settle revenue on the claimed amount under the SAME split hash the
    //    voucher was priced with — a price/settle hash mismatch is how a payout
    //    silently uses a different split than the buyer agreed to.
    expect(v.splitManifestHash).toBe(SPLIT.manifestHash);
    const revenue = settleRevenue({ settlementId: 'settle-1', grossMicros: batch.claimMicros, providerCostMicros: 200n, splitManifest: SPLIT, daoTreasury: WALLET_DAO });
    expect(revenue).toMatchObject({ ok: true });
    if (!revenue.ok) return;
    const receipt = revenue.receipt;
    expect(receipt.splitManifestHash).toBe(v.splitManifestHash);
    expect(receipt.distributableMicros).toBe(800n);
    // Conservation: allocations must sum EXACTLY to the distributable amount.
    const allocated = Object.values(receipt.allocationsMicros).reduce((a, b) => a + b, 0n);
    expect(allocated).toBe(receipt.distributableMicros);

    // 4. THE SEAM: the treasury may only move money against THIS settlement's
    //    receipt hash, so a payout cannot be authorized without a settlement.
    const authorized = authorizeTreasuryTransfer(treasury(), {
      role: 'host-payout',
      token: USDC,
      recipient: WALLET_HOST,
      amountMicros: receipt.allocationsMicros.host,
      settlementReceiptHash: receipt.receiptHash,
      policyApproved: true,
    });
    expect(authorized).toMatchObject({ ok: true });
    if (!authorized.ok) return;
    expect(authorized.request.settlementReceiptHash).toBe(receipt.receiptHash);
  });

  it('builds an on-chain batch settlement request bound to the same channel and voucher digests', () => {
    const config: EvmSettlementConfig = { chainId: 8453, settlementContract: `0x${'1'.repeat(40)}`, stablecoin: `0x${'2'.repeat(40)}`, maxBatchSize: 10 };
    expect(validateEvmSettlementConfig(config)).toMatchObject({ ok: true });

    const rail = createPaymentChannel(CHANNEL_ID, 'evm-x402', 5_000n);
    const batch = settleVoucherBatch({ channel: rail, vouchers: [voucher()], nowMs: 2_000 });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;

    const request = buildEvmBatchSettlementRequest({ config, channel: batch.channel, amountMicros: batch.claimMicros, voucherDigests: batch.voucherDigests });
    expect(request).toMatchObject({ ok: true });
    if (!request.ok) return;
    expect(request.request.channelId).toBe(CHANNEL_ID);
    expect(request.request.voucherDigests).toEqual(batch.voucherDigests);
    expect(request.request.amountMicros).toBe(batch.claimMicros);
  });
});

describe('P2P commerce + BYOC pilot — offline convergence', () => {
  it('lets two peers that observed the same facts in different orders reach byte-identical commerce state', () => {
    const log: CommerceEvent[] = [
      commerceEvent(),
      commerceEvent({ eventId: 'c-2', kind: 'entitlement', sequence: 1, idempotencyKey: 'c-idem-2' }),
      commerceEvent({ eventId: 'c-3', kind: 'usage-receipt', sequence: 2, idempotencyKey: 'c-idem-3' }),
      commerceEvent({ eventId: 'c-4', streamId: 'order-2', kind: 'order', sequence: 0, issuer: 'buyer-2', idempotencyKey: 'c-idem-4' }),
    ];
    const peerA = reduceCommerceEvents(log);
    const peerB = reduceCommerceEvents([log[3], log[2], log[0], log[1]]);
    expect(peerB.accepted).toEqual(peerA.accepted);
    expect(peerA.accepted.map((e) => e.eventId)).toEqual(['c-1', 'c-2', 'c-3', 'c-4']);
    expect(peerA.conflicts).toEqual([]);
  });

  it('converges distribution state across partitioned peers and quarantines a divergent history instead of merging it', () => {
    const published = distEvent();
    const pin = distEvent({ eventId: 'd-2', kind: 'pin-committed', sequence: 1, idempotencyKey: 'd-idem-2', payload: { source: { sourceId: 'pin-1', class: 'pinner', providerId: 'r2', locator: 'opaque', advertisedAtMs: 1_000, expiresAtMs: null } } });
    expect(reduceDistributionEvents([pin, published]).states).toEqual(reduceDistributionEvents([published, pin]).states);

    // Two peers each claim sequence 1 with a DIFFERENT fact: neither wins.
    const rival = distEvent({ eventId: 'd-3', kind: 'peer-advertised', sequence: 1, issuer: 'other-peer', idempotencyKey: 'd-idem-3', payload: { source: { sourceId: 'peer-9', class: 'peer', providerId: 'libp2p', locator: 'opaque', advertisedAtMs: 1_000, expiresAtMs: null } } });
    const diverged = reduceDistributionEvents([published, pin, rival]);
    expect(diverged.conflicts).toEqual([expect.objectContaining({ reason: 'sequence-conflict', sequence: 1 })]);
    expect(diverged.states[0].sources).toEqual([]);
  });
});

describe('P2P commerce + BYOC pilot — duplicate and double-spend prevention', () => {
  it('refuses to charge the same usage nonce twice', () => {
    const v = voucher();
    const first = reserveMicrocharge(createMicrochargeChannel(CHANNEL_ID, 5_000n), v, 1_000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(reserveMicrocharge(first.channel, v, 1_000)).toMatchObject({ ok: false, code: 'duplicate-nonce' });
  });

  it('refuses a replayed voucher digest and a non-monotonic cumulative claim on the settlement rail', () => {
    const v = voucher();
    const rail = createPaymentChannel(CHANNEL_ID, 'evm-x402', 5_000n);
    const first = settleVoucherBatch({ channel: rail, vouchers: [v], nowMs: 2_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Same voucher again: the digest is already claimed.
    expect(settleVoucherBatch({ channel: first.channel, vouchers: [v], nowMs: 2_000 })).toMatchObject({ ok: false, code: 'duplicate-claim' });
    // A DIFFERENT voucher that does not advance the cumulative total is a rewind, not a charge.
    expect(
      settleVoucherBatch({ channel: first.channel, vouchers: [voucher({ usageNonce: 'use-2', cumulativeClaimMicros: 900n })], nowMs: 2_000 }),
    ).toMatchObject({ ok: false, code: 'non-monotonic' });
  });

  it('never lets cumulative claims exceed the escrow that backs them', () => {
    const rail = createPaymentChannel(CHANNEL_ID, 'evm-x402', 500n);
    expect(settleVoucherBatch({ channel: rail, vouchers: [voucher()], nowMs: 2_000 })).toMatchObject({ ok: false, code: 'escrow-exhausted' });
    expect(reserveMicrocharge(createMicrochargeChannel(CHANNEL_ID, 500n), voucher(), 1_000)).toMatchObject({ ok: false, code: 'cap-exhausted' });
  });

  it('deduplicates an exactly-retried commerce fact rather than counting the money twice', () => {
    const retried = commerceEvent({ kind: 'usage-receipt' });
    const result = reduceCommerceEvents([retried, retried, retried]);
    expect(result.duplicates).toEqual(['c-1', 'c-1']);
    expect(result.accepted).toHaveLength(1);
  });
});

describe('P2P commerce + BYOC pilot — signed receipt verification', () => {
  it('rejects a voucher whose signature fails the verifier, and accepts the one that passes', () => {
    const rail = createPaymentChannel(CHANNEL_ID, 'evm-x402', 5_000n);
    const verifySignature = paymentTestVerifier(CHANNEL_ID, 'buyer-1');
    expect(settleVoucherBatch({ channel: rail, vouchers: [voucher({ signature: 'forged' })], nowMs: 2_000, verifySignature })).toMatchObject({ ok: false, code: 'invalid-signature' });
    expect(settleVoucherBatch({ channel: rail, vouchers: [voucher()], nowMs: 2_000, verifySignature })).toMatchObject({ ok: true });
  });

  it('requires a signature on the usage receipt and refuses an expired voucher', () => {
    const v = voucher();
    const reserved = reserveMicrocharge(createMicrochargeChannel(CHANNEL_ID, 5_000n), v, 1_000);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(settleMicrocharge({ channel: reserved.channel, voucher: v, occurredAtMs: 2_000, receiptSignature: '  ' })).toMatchObject({ ok: false, code: 'invalid-voucher' });
    expect(reserveMicrocharge(createMicrochargeChannel(CHANNEL_ID, 5_000n), v, 99_000)).toMatchObject({ ok: false, code: 'expired' });
  });

  it('detects a tampered voucher through its digest, so a mutated field cannot ride an old signature', () => {
    const original = voucher();
    const tampered = voucher({ cumulativeClaimMicros: 9_000n });
    expect(paymentVoucherDigest(unsignedVoucher(tampered))).not.toBe(paymentVoucherDigest(unsignedVoucher(original)));
  });
});

describe('P2P commerce + BYOC pilot — provider reconciliation', () => {
  it('reconciles a BYOC reservation against actual provider spend and credits only what was used', () => {
    const context = { hostRef: 'host-a', fleetSlug: 'fleet-a', axis: 'remote' as const, unit: 'usd-micros' as const, billedAmount: 10, reservationId: 'call-1', billingMode: 'host-pays' as const };
    const prepared = prepareByocExecution({ budget: createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' }), context });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const settled = settleByocExecution({ budget: prepared.ledger, metering: emptyMeteringLedger(), context, actualAmount: 6 });
    expect(settled).toMatchObject({ ok: true, committedAmount: 6 });
    if (!settled.ok) return;
    // The metering ledger — the reconciliation surface — records ACTUAL, not reserved.
    expect(spentOn(settled.metering, 'host-a', 'fleet-a', 'remote')).toBe(6);
  });

  it('keeps gross, provider cost and distributable reconciled, and refuses a cost above gross', () => {
    const ok = settleRevenue({ settlementId: 's-1', grossMicros: 1_000n, providerCostMicros: 250n, splitManifest: SPLIT, daoTreasury: WALLET_DAO });
    expect(ok).toMatchObject({ ok: true });
    if (!ok.ok) return;
    expect(ok.receipt.grossMicros - ok.receipt.providerCostMicros).toBe(ok.receipt.distributableMicros);
    expect(settleRevenue({ settlementId: 's-2', grossMicros: 100n, providerCostMicros: 500n, splitManifest: SPLIT, daoTreasury: WALLET_DAO })).toMatchObject({ ok: false, code: 'cost-exceeds-gross' });
  });
});

describe('P2P commerce + BYOC pilot — entitlement revocation, privacy and key rotation', () => {
  it('delivers a private release to an entitled key version and refuses it once that version is revoked', () => {
    const live = entitledStream();
    expect(resolveDistributionSources(live, { nowMs: 2_000, keyVersion: 1 })).toMatchObject({ deliverable: true, reason: 'ok' });

    const revoked = entitledStream([distEvent({ eventId: 'd-3', kind: 'revoked', sequence: 2, idempotencyKey: 'd-idem-3', payload: { keyVersion: 1 } })]);
    expect(resolveDistributionSources(revoked, { nowMs: 2_000, keyVersion: 1 })).toMatchObject({ deliverable: false, reason: 'key-revoked' });
  });

  it('rotates keys forward only, so a revoked version cannot be reinstated by replaying an older rotation', () => {
    const rotated = entitledStream([
      distEvent({ eventId: 'd-3', kind: 'key-rotated', sequence: 2, idempotencyKey: 'd-idem-3', payload: { keyVersion: 2 } }),
      distEvent({ eventId: 'd-4', kind: 'revoked', sequence: 3, idempotencyKey: 'd-idem-4', payload: { keyVersion: 1 } }),
      distEvent({ eventId: 'd-5', kind: 'key-rotated', sequence: 4, idempotencyKey: 'd-idem-5', payload: { keyVersion: 1 } }),
    ]);
    // keyVersion staying at 2 IS the proof the replayed older rotation was refused;
    // had it applied, this would read 1 and the revoked version would be live again.
    expect(rotated.keyVersion).toBe(2);
    expect(rotated.revokedKeyVersions).toEqual([1]);
    expect(resolveDistributionSources(rotated, { nowMs: 2_000, keyVersion: 2 })).toMatchObject({ deliverable: true });
    expect(resolveDistributionSources(rotated, { nowMs: 2_000, keyVersion: 1 })).toMatchObject({ deliverable: false, reason: 'key-revoked' });
  });

  it('PRIVACY: replicating the distribution log to a peer carries key IDENTIFIERS but no key material, and points only at ciphertext', () => {
    const state = entitledStream();
    const manifest = state.manifest;
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    // What the envelope MAY carry: opaque wrapped-key identifiers. The wrapped keys
    // themselves are delivered per-entitlement out of band, so a peer holding a full
    // log replica still cannot decrypt anything.
    expect(manifest.encryption?.wrappedKeyIds).toEqual(['wk-buyer-1']);
    const envelopeKeys = Object.keys(manifest.encryption ?? {}).sort();
    expect(envelopeKeys).toEqual(['ciphertextHash', 'keyVersion', 'scheme', 'wrappedKeyIds']);

    // What it distributes: ciphertext, never the plaintext bytes. Note the plaintext
    // contentHash IS present — deliberately. It is the P-006 public RELEASE IDENTITY
    // (what you bought), not key material and not the content, and every party needs
    // it to agree on which release this is. The privacy property is that the
    // DISTRIBUTED root is the ciphertext, so the hash cannot be used to fetch bytes.
    expect(manifest.rootHash).toBe(HASH_CIPHERTEXT);
    expect(manifest.rootHash).not.toBe(manifest.release.contentHash);
    expect(manifest.release.contentHash).toBe(HASH_PLAINTEXT);
  });

  it('PRIVACY: a private release yanked from official delivery does not claim the copied bytes were erased', () => {
    const yanked = entitledStream([distEvent({ eventId: 'd-3', kind: 'yanked', sequence: 2, idempotencyKey: 'd-idem-3', payload: { reason: 'key compromise' } })]);
    expect(resolveDistributionSources(yanked, { nowMs: 2_000, keyVersion: 1 })).toMatchObject({ deliverable: false, reason: 'yanked' });
    // A revocation is still admitted AFTER the yank, so the release can be locked down further.
    const lockedDown = entitledStream([
      distEvent({ eventId: 'd-3', kind: 'yanked', sequence: 2, idempotencyKey: 'd-idem-3', payload: { reason: 'key compromise' } }),
      distEvent({ eventId: 'd-4', kind: 'revoked', sequence: 3, idempotencyKey: 'd-idem-4', payload: { keyVersion: 1 } }),
    ]);
    expect(lockedDown.revokedKeyVersions).toEqual([1]);
  });
});

describe('P2P commerce + BYOC pilot — dispute and refund', () => {
  it('freezes settlement while a dispute is open and leaves the escrow refundable', () => {
    const rail = createPaymentChannel(CHANNEL_ID, 'evm-x402', 5_000n);
    expect(settleVoucherBatch({ channel: rail, vouchers: [voucher()], nowMs: 2_000, disputed: true })).toMatchObject({ ok: false, code: 'dispute' });
    // Nothing settled, so the entire escrow is still owed back to the payer.
    expect(refundableEscrow(rail)).toBe(5_000n);
  });

  it('refunds only the unsettled remainder after a partial claim', () => {
    const rail = createPaymentChannel(CHANNEL_ID, 'evm-x402', 5_000n);
    const claimed = settleVoucherBatch({ channel: rail, vouchers: [voucher()], nowMs: 2_000 });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(refundableEscrow(claimed.channel)).toBe(4_000n);
  });

  it('records refund and reversal as new append-only facts rather than deleting the original charge', () => {
    const charge = commerceEvent({ eventId: 'c-1', kind: 'usage-receipt', sequence: 0, idempotencyKey: 'c-idem-1' });
    const result = reduceCommerceEvents([
      charge,
      commerceEvent({ eventId: 'c-2', kind: 'refund', sequence: 1, idempotencyKey: 'c-idem-2' }),
      commerceEvent({ eventId: 'c-3', kind: 'reversal', sequence: 2, idempotencyKey: 'c-idem-3' }),
    ]);
    expect(result.accepted.map((e) => e.kind)).toEqual(['usage-receipt', 'refund', 'reversal']);
    expect(result.conflicts).toEqual([]);
  });
});

describe('P2P commerce + BYOC pilot — treasury accounting', () => {
  it('authorizes a payout only within its role cap, allowlists and approved policy', () => {
    const config = treasury();
    const request = { role: 'host-payout' as const, token: USDC, recipient: WALLET_HOST, amountMicros: 100n, settlementReceiptHash: 'receipt-hash', policyApproved: true };
    expect(authorizeTreasuryTransfer(config, request)).toMatchObject({ ok: true });
    expect(authorizeTreasuryTransfer(config, { ...request, policyApproved: false })).toMatchObject({ ok: false, code: 'policy-not-approved' });
    expect(authorizeTreasuryTransfer(config, { ...request, amountMicros: 10_000_000n })).toMatchObject({ ok: false, code: 'amount-exceeds-role-cap' });
    expect(authorizeTreasuryTransfer(config, { ...request, recipient: WALLET_STRANGER })).toMatchObject({ ok: false, code: 'recipient-not-allowed' });
    expect(authorizeTreasuryTransfer(config, { ...request, token: TOKEN_UNLISTED })).toMatchObject({ ok: false, code: 'token-not-allowed' });
  });

  it('refuses a disabled role even when every other check would pass', () => {
    const paused: SafeTreasuryConfig = { ...treasury(), roles: { ...treasury().roles, 'host-payout': { ...treasury().roles['host-payout'], enabled: false } } };
    expect(
      authorizeTreasuryTransfer(paused, { role: 'host-payout', token: USDC, recipient: WALLET_HOST, amountMicros: 100n, settlementReceiptHash: 'receipt-hash', policyApproved: true }),
    ).toMatchObject({ ok: false, code: 'role-disabled' });
  });

  it('keeps DAO accounting whole: the rounding remainder lands in the DAO share, never vanishing', () => {
    // 999 distributable against bps that do not divide evenly forces a remainder.
    const result = settleRevenue({ settlementId: 's-round', grossMicros: 999n, providerCostMicros: 0n, splitManifest: SPLIT, daoTreasury: WALLET_DAO });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const total = Object.values(result.receipt.allocationsMicros).reduce((a, b) => a + b, 0n);
    expect(total).toBe(999n);
    // The DAO share is at least its nominal 10% floor, having absorbed the remainder.
    expect(result.receipt.allocationsMicros.dao).toBeGreaterThanOrEqual((999n * 1_000n) / 10_000n);
  });
});

function treasury(): SafeTreasuryConfig {
  const role = { enabled: true, maxAmountMicros: 1_000_000n, allowedRecipients: [WALLET_HOST, WALLET_DAO, WALLET_CREATOR], allowedTokens: [USDC] };
  return {
    chainId: 8453,
    safeAddress: `0x${'3'.repeat(40)}`,
    owners: [`0x${'4'.repeat(40)}`, `0x${'5'.repeat(40)}`, `0x${'6'.repeat(40)}`],
    threshold: 2,
    // Deliberately outside `owners`: the automation may spend within its role
    // bounds and may NOT contribute to the owner threshold (P-034).
    automationSigner: `0x${'7'.repeat(40)}`,
    roles: { settlement: role, 'host-payout': role, 'reserve-transfer': role, 'emergency-pause': role },
  };
}
