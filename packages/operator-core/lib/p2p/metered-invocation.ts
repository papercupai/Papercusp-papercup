/**
 * Metering interception on every billable unit (shared-pot DAO plan P-031).
 *
 * P-020 (`microcharge.ts`) owns the ARITHMETIC and the refusal semantics —
 * duplicate nonce, cumulative regression, cap exhaustion, expiry, and the
 * settle-side reservation ceiling. This module owns the INTERCEPTION: it turns
 * a per-use offer's published terms (P-028 `PerUseOfferTerms`) plus ONE
 * billable unit into the cumulative voucher that is reserved BEFORE execution
 * and the `SignedUsageReceipt` that is settled AFTER it, then records the
 * served units on the P-205 metering ledger.
 *
 * Every field P-031 requires a voucher to bind — payer, seller/host, release,
 * nonce, quantity, price version, split-manifest hash — is a
 * `CumulativePaymentVoucher` field, so the binding is STRUCTURAL: a caller
 * cannot forget one and still produce a voucher.
 *
 * Pure by construction: no IO, no clock, no signing key. The caller injects
 * `nowMs` and the two signers, so the same core runs at the hosted Worker door,
 * in the BYOC honor path (`byoc-execution.ts`, P-017), and in tests.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { verifyEd25519 } from '../identity/ed25519';
import {
  paymentVoucherDigest,
  paymentVoucherSigningBytes,
  reserveMicrocharge,
  settleMicrocharge,
  unsignedVoucher,
  type CumulativePaymentVoucher,
  type MicrochargeChannel,
  type MicrochargeRefusalCode,
  type SignedUsageReceipt,
} from './microcharge';
import { recordContribution, recordSpend, type MeteringLedger } from './metering-ledger';
import type { BudgetAxis, BudgetUnit } from './offer-budget';
import { quoteIdentityInferenceTurn, type IdentityPerUseOfferTerms } from '../cupboard/identity-per-use-offer';

/** A `sha256:<64 hex>` split-manifest hash, exactly as `cupboard:publish-offer` accepts it. */
const SPLIT_MANIFEST_HASH = /^sha256:[0-9a-f]{64}$/i;

/**
 * The declared meter for a per-use item: the price terms every voucher for it
 * is signed against. Amounts are bigint micro-units so a tiny per-call charge
 * never passes through floating point.
 */
export interface MeterDeclaration {
  readonly meterUnit: string;
  readonly unitPriceMicros: bigint;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
}

/**
 * The published shape of the terms, as the D1/JSON boundary carries them
 * (`PerUseOfferTerms.unitPriceMicros` is a safe integer there). Accepting the
 * bigint form too lets an in-process caller skip the round trip.
 */
export interface PerUseTermsInput {
  readonly unitPriceMicros: number | bigint;
  readonly meterUnit: string;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
}

/** One billable unit of work, named before it is executed. */
export interface BillableUnit {
  readonly payer: string;
  /** The seller of the item, which on the honor path is also the serving host. */
  readonly seller: string;
  readonly releaseRef: string;
  readonly usageNonce: string;
  readonly quantity: bigint;
  readonly expiresAtMs: number;
}

/**
 * Where the served units land on the P-205 metering ledger. `axis`/`unit` are
 * the ledger's own vocabulary; `meterUnit` on the declaration is the seller's
 * display name for the same thing and is NOT interchangeable with it.
 */
export interface ServedUnitsBinding {
  readonly hostRef: string;
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  readonly unit: BudgetUnit;
  /** M22: credit the served units to an attested user when one is known. */
  readonly attestedUserId?: string;
  readonly perUserContributionCap?: number | null;
}

export type MeteredRefusalCode =
  | MicrochargeRefusalCode
  | 'invalid-meter'
  | 'invalid-unit'
  | 'unsigned-voucher'
  | 'unsigned-receipt'
  | 'terms-mismatch'
  | 'metering-refused';

export interface MeteredRefusal {
  readonly ok: false;
  readonly code: MeteredRefusalCode;
  readonly detail: string;
}

const refuse = (code: MeteredRefusalCode, detail: string): MeteredRefusal => ({ ok: false, code, detail });

export type MeterDeclarationResult = { readonly ok: true; readonly meter: MeterDeclaration } | MeteredRefusal;

/**
 * Validate published per-use terms into a declared meter.
 *
 * This is the "declare a meter" half of P-031's interception point: a door that
 * cannot produce a `MeterDeclaration` must refuse the invocation rather than
 * execute an unpriced billable unit.
 */
export function declareMeter(terms: PerUseTermsInput): MeterDeclarationResult {
  const { meterUnit, priceVersion, splitManifestHash } = terms;
  if (!meterUnit.trim()) return refuse('invalid-meter', 'meterUnit is required');
  if (!priceVersion.trim()) return refuse('invalid-meter', 'priceVersion is required');
  if (!SPLIT_MANIFEST_HASH.test(splitManifestHash)) {
    return refuse('invalid-meter', 'splitManifestHash must be sha256:<64 hex>');
  }
  const raw = terms.unitPriceMicros;
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) {
    return refuse('invalid-meter', 'unitPriceMicros must be a safe integer');
  }
  const unitPriceMicros = BigInt(raw);
  if (unitPriceMicros <= 0n) {
    return refuse('invalid-meter', 'unitPriceMicros must be positive — a zero-price item is a free offer, not a metered one');
  }
  return { ok: true, meter: { meterUnit, unitPriceMicros, priceVersion, splitManifestHash } };
}

/** The micro-unit price of `quantity` units under this meter. */
export function quoteMicros(meter: MeterDeclaration, quantity: bigint): bigint {
  return meter.unitPriceMicros * quantity;
}

/**
 * Build the unsigned cumulative voucher for one billable unit.
 *
 * The claim is CUMULATIVE — the channel's last claim plus this unit's price —
 * which is what makes a replayed or reordered voucher detectable by
 * `reserveMicrocharge`'s monotonicity check rather than by convention here.
 */
export function buildUsageVoucher(
  channel: MicrochargeChannel,
  meter: MeterDeclaration,
  unit: BillableUnit,
): Omit<CumulativePaymentVoucher, 'signature'> {
  return {
    channelId: channel.channelId,
    payer: unit.payer,
    seller: unit.seller,
    releaseRef: unit.releaseRef,
    usageNonce: unit.usageNonce,
    meterQuantity: unit.quantity,
    pricePerUnitMicros: meter.unitPriceMicros,
    priceVersion: meter.priceVersion,
    splitManifestHash: meter.splitManifestHash,
    expiresAtMs: unit.expiresAtMs,
    cumulativeClaimMicros: channel.lastCumulativeMicros + quoteMicros(meter, unit.quantity),
  };
}

function receiptJson(receipt: Omit<SignedUsageReceipt, 'signature'>): Record<string, unknown> {
  return {
    amountMicros: receipt.amountMicros.toString(),
    channelId: receipt.channelId,
    meterQuantity: receipt.meterQuantity.toString(),
    occurredAtMs: receipt.occurredAtMs,
    usageNonce: receipt.usageNonce,
    voucherDigest: receipt.voucherDigest,
  };
}

/** Canonical signing bytes for a usage receipt, mirroring the voucher's own scheme. */
export function usageReceiptSigningBytes(receipt: Omit<SignedUsageReceipt, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(receiptJson(receipt)), 'utf8');
}

export interface SellerReceiptAuthority {
  readonly pubkeyBase64: string;
  readonly proof: string;
}

/** The authenticated publisher proves possession for this exact offer. */
export function sellerReceiptAuthoritySigningBytes(binding: {
  seller: string; offerId: string; productId: string; skuRef: string; pubkeyBase64: string;
}): Buffer {
  return Buffer.from(canonicalJson({ schema: 'papercusp.seller-receipt-authority/v1', seller: binding.seller,
    offerId: binding.offerId, productId: binding.productId, skuRef: binding.skuRef,
    pubkeyBase64: binding.pubkeyBase64 }), 'utf8');
}

function verifySignature(bytes: Buffer, pubkeyBase64: string, signature: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(pubkeyBase64) || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
  try { return verifyEd25519(bytes, pubkeyBase64, Buffer.from(signature, 'base64')); } catch { return false; }
}

export function verifySellerReceiptAuthority(binding: {
  seller: string; offerId: string; productId: string; skuRef: string;
}, authority: SellerReceiptAuthority): boolean {
  if (!authority || typeof authority.pubkeyBase64 !== 'string' || typeof authority.proof !== 'string') return false;
  return verifySignature(sellerReceiptAuthoritySigningBytes({ ...binding, pubkeyBase64: authority.pubkeyBase64 }),
    authority.pubkeyBase64, authority.proof);
}

export function verifyUsageReceiptSignature(receipt: SignedUsageReceipt, pubkeyBase64: string): boolean {
  return verifySignature(usageReceiptSigningBytes(receipt), pubkeyBase64, receipt.signature);
}

export function usageReceiptDigest(receipt: Omit<SignedUsageReceipt, 'signature'>): string {
  return createHash('sha256').update(usageReceiptSigningBytes(receipt)).digest('hex');
}

export interface OpenMeteredInvocationInput {
  readonly channel: MicrochargeChannel;
  readonly meter: MeterDeclaration;
  readonly unit: BillableUnit;
  readonly nowMs: number;
  /** Returns the payer's signature over the voucher's canonical bytes. */
  readonly signVoucher: (bytes: Buffer) => string;
}

export type OpenMeteredInvocationResult =
  | {
      readonly ok: true;
      readonly channel: MicrochargeChannel;
      readonly voucher: CumulativePaymentVoucher;
      readonly reservedMicros: bigint;
    }
  | MeteredRefusal;

function validateUnit(unit: BillableUnit): MeteredRefusal | null {
  if (!unit.payer.trim()) return refuse('invalid-unit', 'payer is required');
  if (!unit.seller.trim()) return refuse('invalid-unit', 'seller is required');
  if (!unit.releaseRef.trim()) return refuse('invalid-unit', 'releaseRef is required');
  if (!unit.usageNonce.trim()) return refuse('invalid-unit', 'usageNonce is required');
  if (unit.quantity <= 0n) return refuse('invalid-unit', 'quantity must be positive');
  if (unit.quantity > BigInt(Number.MAX_SAFE_INTEGER)) {
    return refuse('invalid-unit', 'quantity exceeds the safe-integer range the metering ledger records in');
  }
  if (!Number.isFinite(unit.expiresAtMs)) return refuse('invalid-unit', 'expiresAtMs must be finite');
  return null;
}

/**
 * INTERCEPTION POINT — call this BEFORE executing the billable unit.
 *
 * Reserving first is the whole point: a unit that would exhaust the cap or
 * replay a nonce is refused while refusing is still free, instead of being
 * discovered after the seller has already paid to serve it.
 */
export function openMeteredInvocation(input: OpenMeteredInvocationInput): OpenMeteredInvocationResult {
  const invalid = validateUnit(input.unit);
  if (invalid) return invalid;
  const unsigned = buildUsageVoucher(input.channel, input.meter, input.unit);
  const signature = input.signVoucher(paymentVoucherSigningBytes(unsigned));
  if (typeof signature !== 'string' || !signature.trim()) {
    return refuse('unsigned-voucher', 'the payer signer returned no signature for the cumulative voucher');
  }
  const voucher: CumulativePaymentVoucher = { ...unsigned, signature };
  const reserved = reserveMicrocharge(input.channel, voucher, input.nowMs);
  if (!reserved.ok) return refuse(reserved.code, reserved.detail);
  return { ok: true, channel: reserved.channel, voucher, reservedMicros: reserved.deltaMicros };
}

export interface AcceptMeteredVoucherInput {
  readonly channel: MicrochargeChannel;
  readonly meter: MeterDeclaration;
  readonly unit: BillableUnit;
  /** The voucher as the PAYER signed it, arriving over the wire. */
  readonly voucher: CumulativePaymentVoucher;
  readonly nowMs: number;
  /** Trusted host cryptographic verifier. Omission or a verifier error refuses admission. */
  readonly verifySignature?: (voucher: CumulativePaymentVoucher) => boolean;
}

/**
 * INTERCEPTION POINT for a voucher the caller did NOT build.
 *
 * A hosted door never holds the payer's signing key, so it receives a signed
 * voucher instead of producing one. That makes the voucher ATTACKER-CONTROLLED:
 * its cumulative claim, its price terms and its quantity are all assertions
 * until checked here. Every one of them is re-derived from the DECLARED meter
 * and the named unit, and the cumulative claim is then handed to
 * `reserveMicrocharge`, whose monotonicity guard is what refuses a REPLAYED or
 * REGRESSED claim from a stale (or malicious) client view of the channel.
 */
export function acceptMeteredVoucher(input: AcceptMeteredVoucherInput): OpenMeteredInvocationResult {
  const invalid = validateUnit(input.unit);
  if (invalid) return invalid;
  const expected = buildUsageVoucher(input.channel, input.meter, input.unit);
  const v = input.voucher;
  if (v.channelId !== expected.channelId) return refuse('channel-mismatch', 'voucher channel does not match the local payment channel');
  if (v.payer !== expected.payer) return refuse('terms-mismatch', 'voucher payer does not match the billed unit');
  if (v.seller !== expected.seller) return refuse('terms-mismatch', 'voucher seller does not match the billed unit');
  if (v.releaseRef !== expected.releaseRef) return refuse('terms-mismatch', 'voucher releaseRef does not match the billed unit');
  if (v.usageNonce !== expected.usageNonce) return refuse('terms-mismatch', 'voucher usageNonce does not match the billed unit');
  if (v.meterQuantity !== expected.meterQuantity) return refuse('terms-mismatch', 'voucher meterQuantity does not match the billed unit');
  if (v.pricePerUnitMicros !== expected.pricePerUnitMicros) return refuse('terms-mismatch', 'voucher price does not match the declared meter');
  if (v.priceVersion !== expected.priceVersion) return refuse('terms-mismatch', 'voucher priceVersion does not match the declared meter');
  if (v.splitManifestHash !== expected.splitManifestHash) return refuse('terms-mismatch', 'voucher splitManifestHash does not match the declared meter');
  if (!v.signature.trim()) return refuse('unsigned-voucher', 'the cumulative voucher carries no payer signature');
  let authenticated = false;
  try { authenticated = input.verifySignature?.(v) === true; } catch { /* verifier failure refuses payment */ }
  if (!authenticated) return refuse('invalid-voucher', 'the payer signature failed verification');
  const reserved = reserveMicrocharge(input.channel, v, input.nowMs);
  if (!reserved.ok) return refuse(reserved.code, reserved.detail);
  return { ok: true, channel: reserved.channel, voucher: v, reservedMicros: reserved.deltaMicros };
}

export interface CloseMeteredInvocationInput {
  readonly channel: MicrochargeChannel;
  readonly voucher: CumulativePaymentVoucher;
  /** Units actually served; defaults to the reserved quantity. Never more. */
  readonly actualQuantity?: bigint;
  /** Exact billed-cost settlement. Offer and prior remainder come from durable authority. */
  readonly identityInference?: {
    readonly offer: IdentityPerUseOfferTerms;
    readonly billedInferenceMicros: bigint;
    readonly inferenceCeilingMicros: bigint;
    readonly priorRemainderNumerator: bigint;
  };
  readonly occurredAtMs: number;
  /** Returns the seller/host signature over the receipt's canonical bytes. */
  readonly signReceipt: (bytes: Buffer) => string;
  /** Record the served units on the P-205 ledger as part of the same settlement. */
  readonly metering?: {
    readonly ledger: MeteringLedger;
    readonly served: ServedUnitsBinding;
  };
}

export type CloseMeteredInvocationResult =
  | {
      readonly ok: true;
      readonly channel: MicrochargeChannel;
      readonly receipt: SignedUsageReceipt;
      readonly amountMicros: bigint;
      /** Present only when `metering` was supplied. */
      readonly metering?: MeteringLedger;
      readonly contributionCredited: number;
    }
  | MeteredRefusal;

/**
 * INTERCEPTION POINT — call this AFTER the billable unit has been executed.
 *
 * Settling with the ACTUAL quantity releases the unused part of the reservation
 * back to the channel, so a unit that reserved ten and served three does not
 * strand the other seven.
 */
export function closeMeteredInvocation(input: CloseMeteredInvocationInput): CloseMeteredInvocationResult {
  const served = input.actualQuantity ?? input.voucher.meterQuantity;
  // A funded turn can close without entering any tool handler. Its original
  // positive voucher still binds the released hold and the signed zero receipt.
  if (served < 0n) return refuse('invalid-unit', 'actualQuantity must be non-negative');
  if (served > input.voucher.meterQuantity) {
    return refuse('actual-exceeds-reservation', `served ${served} exceeds the reserved quantity ${input.voucher.meterQuantity}`);
  }
  if (!Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs < 0) return refuse('invalid-unit', 'occurredAtMs must be a non-negative safe integer');
  let amountMicros = input.voucher.pricePerUnitMicros * served;
  if (input.identityInference) {
    const exact = input.identityInference;
    const offer = exact.offer;
    const q = quoteIdentityInferenceTurn(exact);
    if (!q.ok) return refuse('terms-mismatch', q.detail);
    if (input.actualQuantity !== undefined || input.metering ||
        offer.skuRef !== input.voucher.releaseRef ||
        BigInt(offer.unitPriceMicros) !== input.voucher.pricePerUnitMicros ||
        offer.priceVersion !== input.voucher.priceVersion || offer.splitManifestHash !== input.voucher.splitManifestHash) {
      return refuse('terms-mismatch', 'exact identity cost must bind the reserved identity offer without a quantity override');
    }
    if (q.reservationQuantity !== input.voucher.meterQuantity) {
      return refuse('terms-mismatch', 'identity inference ceiling differs from the signed reservation');
    }
    amountMicros = q.amountMicros;
  } else if (input.voucher.releaseRef.startsWith('identity-release:')) {
    return refuse('terms-mismatch', 'identity releases require exact billed inference settlement');
  }
  const unsignedReceipt: Omit<SignedUsageReceipt, 'signature'> = {
    channelId: input.channel.channelId,
    usageNonce: input.voucher.usageNonce,
    meterQuantity: served,
    amountMicros,
    voucherDigest: paymentVoucherDigest(unsignedVoucher(input.voucher)),
    occurredAtMs: input.occurredAtMs,
  };
  const receiptSignature = input.signReceipt(usageReceiptSigningBytes(unsignedReceipt));
  if (typeof receiptSignature !== 'string' || !receiptSignature.trim()) {
    return refuse('unsigned-receipt', 'the seller signer returned no signature for the usage receipt');
  }

  const settled = settleMicrocharge({
    channel: input.channel,
    voucher: input.voucher,
    actualAmountMicros: amountMicros,
    actualMeterQuantity: served,
    occurredAtMs: input.occurredAtMs,
    receiptSignature,
  });
  if (!settled.ok) return refuse(settled.code, settled.detail);

  if (!input.metering) {
    return { ok: true, channel: settled.channel, receipt: settled.receipt, amountMicros, contributionCredited: 0 };
  }

  // The served QUANTITY (not the money) is what the metering ledger counts —
  // it is a capacity ledger, and `served`'s unit is the binding's BudgetUnit.
  const amount = Number(served);
  const spend = recordSpend(input.metering.ledger, {
    hostRef: input.metering.served.hostRef,
    fleetSlug: input.metering.served.fleetSlug,
    axis: input.metering.served.axis,
    amount,
    unit: input.metering.served.unit,
  });
  if (!spend.ok) return refuse('metering-refused', `${spend.code}: metering ledger refused the served units`);
  let ledger = spend.ledger;
  let contributionCredited = 0;
  if (input.metering.served.attestedUserId) {
    const contribution = recordContribution(ledger, {
      attestedUserId: input.metering.served.attestedUserId,
      axis: input.metering.served.axis,
      amount,
      unit: input.metering.served.unit,
      perUserCap: input.metering.served.perUserContributionCap ?? null,
    });
    if (!contribution.ok) return refuse('metering-refused', `${contribution.code}: metering ledger refused the contribution credit`);
    ledger = contribution.ledger;
    contributionCredited = contribution.credited;
  }
  return {
    ok: true,
    channel: settled.channel,
    receipt: settled.receipt,
    amountMicros,
    metering: ledger,
    contributionCredited,
  };
}

/** Local state of ONE host-authorized funded turn, including its settlement outbox. */
export interface LocalMeteredTurnState {
  readonly turnId: string;
  /** Durable host closure/revocation. Omitted only in legacy open snapshots. */
  readonly admissionClosed?: boolean;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly meter: MeterDeclaration;
  readonly ceilingMicros: bigint;
  readonly expiresAtMs: number;
  readonly reservedMicros: bigint;
  readonly channel: MicrochargeChannel;
  readonly units: Readonly<Record<string, {
    readonly voucher: CumulativePaymentVoucher;
    readonly completedAtMs: number | null;
    readonly receipt: SignedUsageReceipt | null;
  }>>;
}

export class LocalMeteredTurnRefusedError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
    this.name = 'LocalMeteredTurnRefusedError';
  }
}

/**
 * Charges local tool calls inside an already funded turn (D-010/D-037).
 * The host supplies the authenticated channel, exact installed offer, and
 * ceiling AFTER reserving funding once per turn. This class does no hosted IO
 * and does not itself prove funding or entitlement. `persist` must write to the
 * local durable store; signers and state never come from tool arguments.
 *
 * Only state transitions are serialized. Handlers run concurrently, while
 * async signers cannot race two reservations against the same channel snapshot.
 * Every entered handler is one served invocation, including a thrown handler.
 */
export class LocalMeteredTurn {
  private state: LocalMeteredTurnState;
  private tail: Promise<void> = Promise.resolve();
  private persistenceFailed = false;

  constructor(private readonly deps: {
    state: LocalMeteredTurnState;
    nowMs: () => number;
    signVoucher: (bytes: Buffer) => Promise<string> | string;
    signReceipt: (bytes: Buffer, voucher?: CumulativePaymentVoucher) => Promise<string> | string;
    persist: (state: LocalMeteredTurnState) => Promise<void>;
  }) {
    this.state = structuredClone(deps.state);
    const s = this.state;
    const declared = declareMeter(s.meter);
    if (!s.turnId.trim() || !s.payer.trim() || !s.seller.trim() || !s.releaseRef.trim() ||
        !declared.ok || !Number.isFinite(s.expiresAtMs) || s.ceilingMicros <= 0n ||
        s.reservedMicros < 0n || s.reservedMicros > s.ceilingMicros ||
        s.channel.escrowMicros < 0n || s.channel.committedMicros < 0n || s.channel.lastCumulativeMicros < 0n ||
        Object.values(s.channel.reservations).some((amount) => amount < 0n) ||
        s.channel.committedMicros + Object.values(s.channel.reservations).reduce((sum, amount) => sum + amount, 0n) >
          s.channel.escrowMicros) {
      throw new LocalMeteredTurnRefusedError('invalid-turn', 'a local meter needs a bound funded turn and valid ceiling');
    }
    let reserved = 0n;
    for (const [nonce, entry] of Object.entries(s.units)) {
      const v = entry.voucher;
      const amount = quoteMicros(s.meter, v.meterQuantity);
      if (v.usageNonce !== nonce || v.channelId !== s.channel.channelId || v.payer !== s.payer ||
          v.seller !== s.seller || v.releaseRef !== s.releaseRef || v.priceVersion !== s.meter.priceVersion ||
          v.splitManifestHash !== s.meter.splitManifestHash || v.pricePerUnitMicros !== s.meter.unitPriceMicros ||
          v.meterQuantity <= 0n || !v.signature.trim() ||
          (entry.completedAtMs !== null && !Number.isFinite(entry.completedAtMs)) ||
          (entry.receipt
            ? !(nonce in s.channel.receipts) || entry.receipt.usageNonce !== nonce ||
              entry.receipt.channelId !== v.channelId || entry.receipt.amountMicros !== amount ||
              entry.receipt.voucherDigest !== paymentVoucherDigest(unsignedVoucher(v)) ||
              !entry.receipt.signature.trim() || entry.completedAtMs === null
            : s.channel.reservations[nonce] !== amount)) {
        throw new LocalMeteredTurnRefusedError('invalid-turn', 'local turn snapshot disagrees with its bound vouchers/channel');
      }
      reserved += amount;
    }
    if (reserved !== s.reservedMicros) {
      throw new LocalMeteredTurnRefusedError('invalid-turn', 'local turn reservation total disagrees with its units');
    }
  }

  snapshot(): LocalMeteredTurnState { return structuredClone(this.state); }

  /** Stop new calls before closing or revoking a host admission. Calls already
   * entered must finish; their durable holds cannot be treated as unused funds. */
  stopAdmission(): Promise<void> {
    return this.serialize(async () => {
      if (this.state.admissionClosed) return;
      this.state = { ...this.state, admissionClosed: true };
      await this.persist();
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      if (this.persistenceFailed) {
        throw new LocalMeteredTurnRefusedError('storage-unavailable', 'read authoritative local state before resuming this turn');
      }
      return operation();
    });
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async persist(): Promise<void> {
    try { await this.deps.persist(this.snapshot()); }
    catch (error) {
      // The write outcome may be unknown. Keep the reservation, stop admission,
      // and require a durable read instead of retrying a possibly committed write.
      this.persistenceFailed = true;
      throw error;
    }
  }

  async invoke<T>(unit: Pick<BillableUnit, 'payer' | 'releaseRef' | 'usageNonce' | 'quantity'>,
    execute: () => Promise<T> | T): Promise<T> {
    await this.serialize(async () => {
      const s = this.state;
      if (s.admissionClosed) {
        throw new LocalMeteredTurnRefusedError('turn-admission-closed', 'the host has closed or revoked this funded turn');
      }
      if (unit.payer !== s.payer || unit.releaseRef !== s.releaseRef) {
        throw new LocalMeteredTurnRefusedError('binding-mismatch', 'target payer and installed release must match the funded turn');
      }
      const nowMs = this.deps.nowMs();
      if (!Number.isFinite(nowMs) || nowMs > s.expiresAtMs) {
        throw new LocalMeteredTurnRefusedError('expired', 'the funded turn has expired');
      }
      if (s.reservedMicros + quoteMicros(s.meter, unit.quantity) > s.ceilingMicros) {
        throw new LocalMeteredTurnRefusedError('cap-exhausted', 'this invocation exceeds the funded per-turn ceiling');
      }
      const bound: BillableUnit = { ...unit, seller: s.seller, expiresAtMs: s.expiresAtMs };
      // Capture canonical signing bytes with the pure core before async signing.
      let bytes: Buffer | undefined;
      const probe = openMeteredInvocation({ channel: s.channel, meter: s.meter, unit: bound, nowMs,
        signVoucher: (value) => { bytes = value; return 'signing-probe'; } });
      if (!probe.ok) throw new LocalMeteredTurnRefusedError(probe.code, probe.detail);
      const signature = await this.deps.signVoucher(bytes!);
      const signedAtMs = this.deps.nowMs();
      const opened = openMeteredInvocation({ channel: s.channel, meter: s.meter, unit: bound, nowMs: signedAtMs,
        signVoucher: () => signature });
      if (!opened.ok) throw new LocalMeteredTurnRefusedError(opened.code, opened.detail);
      this.state = { ...s, channel: opened.channel, reservedMicros: s.reservedMicros + opened.reservedMicros,
        units: { ...s.units, [unit.usageNonce]: { voucher: opened.voucher, completedAtMs: null, receipt: null } } };
      await this.persist();
    });
    try { return await execute(); }
    finally {
      await this.serialize(async () => {
        const entry = this.state.units[unit.usageNonce]!;
        const completedAtMs = this.deps.nowMs();
        if (!Number.isFinite(completedAtMs)) {
          throw new LocalMeteredTurnRefusedError('invalid-unit', 'completion time must be finite');
        }
        this.state = { ...this.state, units: { ...this.state.units,
          [unit.usageNonce]: { ...entry, completedAtMs } } };
        await this.persist();
        await this.settle(unit.usageNonce);
      });
    }
  }

  /** Recover a completed call's settlement; never re-enter its handler. */
  retrySettlement(usageNonce: string): Promise<SignedUsageReceipt> {
    return this.serialize(() => this.settle(usageNonce));
  }

  private async settle(usageNonce: string): Promise<SignedUsageReceipt> {
    const s = this.state;
    const entry = s.units[usageNonce];
    if (!entry || entry.completedAtMs === null) {
      throw new LocalMeteredTurnRefusedError('unknown-reservation', 'only a recorded completed invocation may settle');
    }
    if (entry.receipt) return structuredClone(entry.receipt);
    let bytes: Buffer | undefined;
    const probe = closeMeteredInvocation({ channel: s.channel, voucher: entry.voucher,
      occurredAtMs: entry.completedAtMs, signReceipt: (value) => { bytes = value; return 'signing-probe'; } });
    if (!probe.ok) throw new LocalMeteredTurnRefusedError(probe.code, probe.detail);
    const signature = await this.deps.signReceipt(bytes!, entry.voucher);
    const closed = closeMeteredInvocation({ channel: s.channel, voucher: entry.voucher,
      occurredAtMs: entry.completedAtMs, signReceipt: () => signature });
    if (!closed.ok) throw new LocalMeteredTurnRefusedError(closed.code, closed.detail);
    this.state = { ...s, channel: closed.channel,
      units: { ...s.units, [usageNonce]: { ...entry, receipt: closed.receipt } } };
    await this.persist();
    return structuredClone(closed.receipt);
  }
}
