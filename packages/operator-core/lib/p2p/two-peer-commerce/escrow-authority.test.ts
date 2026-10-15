import { signPaymentTestVoucher, paymentTestVerifier } from '../_payment-voucher-fixture';
/**
 * P-036 escrow authority — the Worker + chain adjudication of federated claims.
 *
 * These cover the arithmetic and the layering (D-055) directly, at unit speed.
 * The two-real-process convergence proof lives in
 * `two-peer-commerce.integration.test.ts`, which drives this same module from
 * two separate OS processes over a real testnet DHT.
 */
import { describe, expect, it } from 'vitest';
import { createPaymentChannel } from '../payment-channel';
import { reduceCommerceEvents, type CommerceEvent } from '../commerce-events';
import { paymentVoucherDigest, unsignedVoucher, type CumulativePaymentVoucher } from '../microcharge';
import { perUseRollup } from '../../cupboard/ledger-p2p-bridge';
import {
  adjudicateEscrowClaims as rawAdjudicateEscrowClaims,
  buildUsageReceiptEvent,
  canonicalClaimOrder,
  readUsageClaims,
  type FederatedUsageClaim,
} from './escrow-authority';

const CHANNEL = 'chan-p036';
const SELLER = 'gh:seller';
const PAYER = 'gh:buyer';
const RELEASE = 'release:widget@1.0.0';

function voucher(overrides: Partial<CumulativePaymentVoucher> = {}): CumulativePaymentVoucher {
  return signPaymentTestVoucher({
    channelId: CHANNEL,
    payer: PAYER,
    seller: SELLER,
    releaseRef: RELEASE,
    usageNonce: 'nonce-1',
    meterQuantity: 10n,
    pricePerUnitMicros: 1_000n,
    priceVersion: 'price-v1',
    splitManifestHash: 'split-hash-v1',
    expiresAtMs: 10_000,
    cumulativeClaimMicros: 10_000n,
    signature: 'sig',
    ...overrides,
  }, overrides.signature);
}

function claim(
  machine: string,
  occurredAtMs: number,
  overrides: Partial<CumulativePaymentVoucher> = {},
): FederatedUsageClaim {
  const v = voucher(overrides);
  return { eventId: `usage:${paymentVoucherDigest(unsignedVoucher(v))}`, issuerMachine: machine, voucher: v, occurredAtMs };
}

const escrow = (micros: bigint) => createPaymentChannel(CHANNEL, 'evm-x402', micros);


function adjudicateEscrowClaims(input: Parameters<typeof rawAdjudicateEscrowClaims>[0]): ReturnType<typeof rawAdjudicateEscrowClaims> {
  return rawAdjudicateEscrowClaims({ verifySignature: paymentTestVerifier('chan-p036', 'gh:buyer'), ...input });
}

describe('escrow authority — duplicate receipts', () => {
  it('folds the same voucher twice as ONE admission and one duplicate', () => {
    const one = claim('machine-a', 1_000);
    const verdict = adjudicateEscrowClaims({ channel: escrow(1_000_000n), claims: [one, one], nowMs: 500 });

    expect(verdict.dispositions.map((d) => d.state)).toEqual(['admitted', 'duplicate']);
    expect(verdict.admittedMicros).toBe('10000');
    expect(verdict.channel.settledMicros).toBe(10_000n);
    expect(verdict.doubleSpend).toEqual([]);
  });

  it('a duplicate re-delivered after a partition heal does not move the escrow', () => {
    const one = claim('machine-a', 1_000);
    const first = adjudicateEscrowClaims({ channel: escrow(1_000_000n), claims: [one], nowMs: 500 });
    const healed = adjudicateEscrowClaims({ channel: escrow(1_000_000n), claims: [one, one, one], nowMs: 500 });

    expect(healed.channel.settledMicros).toBe(first.channel.settledMicros);
    expect(healed.admittedMicros).toBe(first.admittedMicros);
  });
});

describe('escrow authority — double spend across two buyer machines', () => {
  /**
   * The plan's case: ONE payer identity on TWO machines, each issuing a
   * cumulative voucher against one seller escrow while partitioned. Their
   * claims together exceed the escrow; exactly one is paid.
   */
  const escrowMicros = 12_000n;
  const a = claim('machine-a', 1_000, { usageNonce: 'nonce-a', cumulativeClaimMicros: 10_000n });
  const b = claim('machine-b', 2_000, { usageNonce: 'nonce-b', cumulativeClaimMicros: 9_000n });

  it('admits one machine and quarantines the other as a double spend', () => {
    const verdict = adjudicateEscrowClaims({ channel: escrow(escrowMicros), claims: [a, b], nowMs: 500 });

    expect(verdict.dispositions.map((d) => d.state)).toEqual(['admitted', 'double-spend']);
    expect(verdict.doubleSpend).toHaveLength(1);
    const [spend] = verdict.doubleSpend;
    expect(spend.state === 'double-spend' && spend.issuerMachine).toBe('machine-b');
    expect(spend.state === 'double-spend' && spend.collidesWithMachine).toBe('machine-a');
    // The escrow is never over-drawn: that is the property, not the code.
    expect(verdict.channel.settledMicros).toBeLessThanOrEqual(escrowMicros);
  });

  it('reaches the SAME verdict whichever order the two peers observed the fork in', () => {
    const seenByPeerOne = adjudicateEscrowClaims({ channel: escrow(escrowMicros), claims: [a, b], nowMs: 500 });
    const seenByPeerTwo = adjudicateEscrowClaims({ channel: escrow(escrowMicros), claims: [b, a], nowMs: 500 });

    expect(seenByPeerTwo.dispositions).toEqual(seenByPeerOne.dispositions);
    expect(seenByPeerTwo.channel).toEqual(seenByPeerOne.channel);
  });

  it('classifies a single machine over-drawing its OWN channel as a plain rejection, not a fork', () => {
    const first = claim('machine-a', 1_000, { usageNonce: 'nonce-a', cumulativeClaimMicros: 10_000n });
    const second = claim('machine-a', 2_000, { usageNonce: 'nonce-a2', cumulativeClaimMicros: 90_000n });
    const verdict = adjudicateEscrowClaims({ channel: escrow(escrowMicros), claims: [first, second], nowMs: 500 });

    expect(verdict.doubleSpend).toEqual([]);
    const last = verdict.dispositions.at(-1)!;
    expect(last.state).toBe('rejected');
    expect(last.state === 'rejected' && last.code).toBe('escrow-exhausted');
  });

  it('canonical order is total and independent of input order', () => {
    const sameMs = [claim('machine-b', 1_000, { usageNonce: 'z' }), claim('machine-a', 1_000, { usageNonce: 'a' })];
    expect(canonicalClaimOrder(sameMs).map((c) => c.eventId)).toEqual(
      canonicalClaimOrder([...sameMs].reverse()).map((c) => c.eventId),
    );
  });
});

describe('D-055 layering — the log accepts the fork, the escrow refuses it', () => {
  const signed = (event: Omit<CommerceEvent, 'signature'>): CommerceEvent => ({ ...event, signature: 'event-sig' });

  const receiptA = signed(
    buildUsageReceiptEvent({
      streamId: `channel:${CHANNEL}`,
      issuer: PAYER,
      issuerMachine: 'machine-a',
      sequence: 0,
      occurredAtMs: 1_000,
      voucher: voucher({ usageNonce: 'nonce-a', cumulativeClaimMicros: 10_000n }),
    }),
  );
  const receiptB = signed(
    buildUsageReceiptEvent({
      streamId: `channel:${CHANNEL}`,
      issuer: PAYER,
      issuerMachine: 'machine-b',
      sequence: 1,
      occurredAtMs: 2_000,
      voucher: voucher({ usageNonce: 'nonce-b', cumulativeClaimMicros: 9_000n }),
    }),
  );

  it('reduceCommerceEvents ACCEPTS both forked receipts — a double spend is not a structural conflict', () => {
    const reduction = reduceCommerceEvents([receiptA, receiptB]);
    expect(reduction.accepted).toHaveLength(2);
    expect(reduction.conflicts).toEqual([]);
    expect(reduction.invalid).toEqual([]);
  });

  it('the escrow then refuses one of them — the two layers disagree BY DESIGN', () => {
    const { accepted } = reduceCommerceEvents([receiptA, receiptB]);
    const { claims, unusable } = readUsageClaims(accepted);
    expect(unusable).toEqual([]);
    expect(claims).toHaveLength(2);

    const verdict = adjudicateEscrowClaims({ channel: escrow(12_000n), claims, nowMs: 500 });
    expect(verdict.doubleSpend).toHaveLength(1);
  });

  it('the log reducer DOES quarantine a genuine structural conflict', () => {
    // Same issuer + idempotency key, different fact: that is a fork of the
    // record itself, which is the reducer's job rather than the escrow's.
    const forged: CommerceEvent = { ...receiptB, eventId: 'usage:forged', payload: { ...receiptB.payload, amountMicros: '1' }, idempotencyKey: receiptA.idempotencyKey };
    const reduction = reduceCommerceEvents([receiptA, forged]);
    expect(reduction.conflicts.map((c) => c.reason)).toContain('idempotency-conflict');
    expect(reduction.accepted).toHaveLength(0);
  });

  it('a usage-receipt with no well-formed voucher is REPORTED, never silently dropped', () => {
    const stripped: CommerceEvent = { ...receiptA, payload: { channelId: CHANNEL, amountMicros: '10000' } };
    const { claims, unusable } = readUsageClaims([stripped]);
    expect(claims).toEqual([]);
    expect(unusable).toHaveLength(1);
  });
});

describe('claim vs finality (acceptance line 14)', () => {
  const signed = (event: Omit<CommerceEvent, 'signature'>): CommerceEvent => ({ ...event, signature: 'event-sig' });

  it('a usage receipt is money CLAIMED and never money settled', () => {
    const receipt = signed(
      buildUsageReceiptEvent({
        streamId: `channel:${CHANNEL}`,
        issuer: PAYER,
        issuerMachine: 'machine-a',
        sequence: 0,
        occurredAtMs: 1_000,
        voucher: voucher({ cumulativeClaimMicros: 10_000n }),
      }),
    );
    const rollup = perUseRollup([receipt]);
    const [position] = rollup.channels;
    expect(position.claimedMicros).toBe('10000');
    expect(position.settledMicros).toBe('0');
    expect(position.netSettledMicros).toBe('0');
  });

  it('re-federating the same receipt cannot inflate the claimed column', () => {
    const receipt = signed(
      buildUsageReceiptEvent({
        streamId: `channel:${CHANNEL}`,
        issuer: PAYER,
        issuerMachine: 'machine-a',
        sequence: 0,
        occurredAtMs: 1_000,
        voucher: voucher({ cumulativeClaimMicros: 10_000n }),
      }),
    );
    // Two copies of one fact: the reducer collapses them before the rollup sees them.
    const { accepted, duplicates } = reduceCommerceEvents([receipt, receipt]);
    expect(duplicates).toEqual([receipt.eventId]);
    expect(perUseRollup(accepted).channels[0].claimedMicros).toBe('10000');
  });
});
