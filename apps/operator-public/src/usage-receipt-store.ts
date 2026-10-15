/**
 * D1 store for the P-031 metering interception.
 *
 * `p2p/microcharge.ts` keeps its channel state in memory — a reservations map,
 * a receipts map, and a cumulative watermark. A Worker has no memory between
 * requests, so this module REHYDRATES that exact shape from D1 before the pure
 * core decides, and persists the decision after it. The consequence is what
 * matters: `duplicate-nonce`, `cumulative-regression` and `cap-exhausted` stop
 * being properties of one process's heap and become properties of the row store
 * plus the `payment_channels` CHECK constraint (mig 023), so a restart, a retry
 * or a second concurrent buyer cannot spend the same escrow twice.
 *
 * D-055: the Worker STORES facts the parties signed; it never authors them. The
 * payer's voucher signature and the seller's receipt signature are persisted
 * verbatim.
 */
import type { MicrochargeChannel } from '@papercusp/operator-core/lib/p2p/microcharge.ts';
import type { StoredPaymentChannel } from './payment-channel-store.ts';
import { quoteIdentityInferenceTurn } from '@papercusp/operator-core/lib/cupboard/identity-per-use-offer';

export type UsageReceiptState = 'reserved' | 'settled';

interface UsageReceiptRow {
  channel_id: string;
  usage_nonce: string;
  principal_id: string;
  offer_id: string;
  payer: string;
  seller: string;
  release_ref: string;
  meter_unit: string;
  meter_quantity: number;
  settled_meter_quantity: number | null;
  unit_price_micros: number;
  price_version: string;
  split_manifest_hash: string;
  reserved_micros: number;
  amount_micros: number | null;
  cumulative_claim_micros: number;
  expires_at_ms: number;
  voucher_digest: string;
  voucher_signature: string;
  receipt_signature: string | null;
  seller_pubkey_base64: string | null;
  state: string;
  reserved_at_ms: number;
  settled_at_ms: number | null;
  identity_ceiling_micros: number | null;
  billed_inference_micros: number | null;
  prior_markup_remainder: number | null;
  markup_remainder: number | null;
}

export interface StoredUsageReceipt {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly principalId: string;
  readonly offerId: string;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly meterUnit: string;
  readonly meterQuantity: number;
  /** Positive quantity in the original payer-signed reservation. */
  readonly reservedMeterQuantity: number;
  readonly unitPriceMicros: number;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
  readonly reservedMicros: number;
  readonly amountMicros: number | null;
  readonly cumulativeClaimMicros: number;
  readonly expiresAtMs: number;
  readonly voucherDigest: string;
  readonly voucherSignature: string;
  readonly receiptSignature: string | null;
  readonly sellerPubkeyBase64?: string | null;
  readonly state: UsageReceiptState;
  readonly reservedAtMs: number;
  readonly settledAtMs: number | null;
  readonly identityInference?: {
    readonly ceilingMicros: number;
    readonly billedInferenceMicros: number | null;
    readonly priorRemainderNumerator: number | null;
    readonly remainderNumerator: number | null;
  };
}

const COLUMNS = `channel_id, usage_nonce, principal_id, offer_id, payer, seller,
       release_ref, meter_unit, meter_quantity, unit_price_micros, price_version,
       split_manifest_hash, reserved_micros, amount_micros,
       cumulative_claim_micros, expires_at_ms, voucher_digest, voucher_signature,
       receipt_signature, state, reserved_at_ms, settled_at_ms,
       identity_ceiling_micros, billed_inference_micros, prior_markup_remainder, markup_remainder,
       settled_meter_quantity, seller_pubkey_base64`;

function fromRow(row: UsageReceiptRow): StoredUsageReceipt {
  return {
    channelId: row.channel_id,
    usageNonce: row.usage_nonce,
    principalId: row.principal_id,
    offerId: row.offer_id,
    payer: row.payer,
    seller: row.seller,
    releaseRef: row.release_ref,
    meterUnit: row.meter_unit,
    meterQuantity: Number(row.settled_meter_quantity ?? row.meter_quantity),
    // Legacy partial settlements overwrote meter_quantity. Reservation money
    // retains the original positive priced quantity, including on those rows.
    reservedMeterQuantity: Number(row.reserved_micros) / Number(row.unit_price_micros),
    unitPriceMicros: Number(row.unit_price_micros),
    priceVersion: row.price_version,
    splitManifestHash: row.split_manifest_hash,
    reservedMicros: Number(row.reserved_micros),
    amountMicros: row.amount_micros == null ? null : Number(row.amount_micros),
    cumulativeClaimMicros: Number(row.cumulative_claim_micros),
    expiresAtMs: Number(row.expires_at_ms),
    voucherDigest: row.voucher_digest,
    voucherSignature: row.voucher_signature,
    receiptSignature: row.receipt_signature,
    sellerPubkeyBase64: row.seller_pubkey_base64 ?? null,
    state: row.state as UsageReceiptState,
    reservedAtMs: Number(row.reserved_at_ms),
    settledAtMs: row.settled_at_ms == null ? null : Number(row.settled_at_ms),
    ...(row.identity_ceiling_micros == null ? {} : { identityInference: {
      ceilingMicros: Number(row.identity_ceiling_micros),
      billedInferenceMicros: row.billed_inference_micros == null ? null : Number(row.billed_inference_micros),
      priorRemainderNumerator: row.prior_markup_remainder == null ? null : Number(row.prior_markup_remainder),
      remainderNumerator: row.markup_remainder == null ? null : Number(row.markup_remainder),
    } }),
  };
}

export async function getUsageReceipt(
  db: D1Database,
  channelId: string,
  usageNonce: string,
): Promise<StoredUsageReceipt | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM usage_receipts WHERE channel_id = ? AND usage_nonce = ?`)
    .bind(channelId, usageNonce)
    .first<UsageReceiptRow>();
  return row ? fromRow(row) : null;
}

export async function listChannelUsageReceipts(
  db: D1Database,
  channelId: string,
): Promise<readonly StoredUsageReceipt[]> {
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM usage_receipts WHERE channel_id = ? ORDER BY reserved_at_ms ASC, usage_nonce ASC`)
    .bind(channelId)
    .all<UsageReceiptRow>();
  return (rows.results ?? []).map(fromRow);
}

/** Live receipt page for the authenticated party, across all its channels.
 * The unique receipt key orders pages; a page is not an account snapshot. */
export async function listPrincipalUsageReceipts(
  db: D1Database,
  principalId: string,
  limit: number,
  after?: { channelId: string; usageNonce: string },
): Promise<{ receipts: readonly StoredUsageReceipt[]; next: { channelId: string; usageNonce: string } | null }> {
  if (!principalId.trim() || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('invalid principal receipt page');
  }
  const clause = after ? ' AND (channel_id > ? OR (channel_id = ? AND usage_nonce > ?))' : '';
  const statement = db.prepare(`SELECT ${COLUMNS} FROM usage_receipts
    WHERE (payer = ? OR seller = ?)${clause}
    ORDER BY channel_id ASC, usage_nonce ASC LIMIT ?`);
  const result = await statement.bind(principalId, principalId,
    ...(after ? [after.channelId, after.channelId, after.usageNonce] : []), limit + 1).all<UsageReceiptRow>();
  const rows = result.results ?? [];
  const receipts = rows.slice(0, limit).map(fromRow);
  const last = receipts[receipts.length - 1];
  return { receipts, next: rows.length > limit && last
    ? { channelId: last.channelId, usageNonce: last.usageNonce } : null };
}

/**
 * Rebuild the in-memory `MicrochargeChannel` the pure core expects from durable
 * state.
 *
 * `committedMicros` and `escrowMicros` come from `payment_channels` (the escrow
 * authority, mig 023) rather than from summing receipts: the chain-facing
 * committed total is what the CHECK constraint guards, and re-deriving it here
 * would let the two disagree silently.
 */
export async function loadMicrochargeChannel(
  db: D1Database,
  channel: StoredPaymentChannel,
): Promise<MicrochargeChannel> {
  const receipts = await listChannelUsageReceipts(db, channel.channelId);
  const reservations: Record<string, bigint> = {};
  const settled: Record<string, string> = {};
  let lastCumulativeMicros = 0n;
  for (const r of receipts) {
    const claim = BigInt(r.cumulativeClaimMicros);
    if (claim > lastCumulativeMicros) lastCumulativeMicros = claim;
    if (r.state === 'reserved') reservations[r.usageNonce] = BigInt(r.reservedMicros);
    else settled[r.usageNonce] = r.voucherDigest;
  }
  return {
    channelId: channel.channelId,
    escrowMicros: BigInt(channel.escrowMicros),
    committedMicros: BigInt(channel.committedMicros),
    lastCumulativeMicros,
    reservations,
    receipts: settled,
  };
}

export interface ReserveUsageReceiptInput {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly principalId: string;
  readonly offerId: string;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly meterUnit: string;
  readonly meterQuantity: bigint;
  readonly unitPriceMicros: bigint;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
  readonly reservedMicros: bigint;
  readonly cumulativeClaimMicros: bigint;
  readonly expiresAtMs: number;
  readonly voucherDigest: string;
  readonly voucherSignature: string;
  readonly nowMs: number;
  readonly identityInferenceCeilingMicros?: bigint;
  readonly sellerPubkeyBase64?: string;
}

export type ReserveUsageReceiptResult =
  | { readonly ok: true; readonly receipt: StoredUsageReceipt }
  | { readonly ok: false; readonly code: string; readonly receipt: StoredUsageReceipt | null };

const safeMicros = (value: bigint): boolean => value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
const receiptOffer = (r: StoredUsageReceipt) => ({ skuRef: r.releaseRef, meterUnit: r.meterUnit,
  unitPriceMicros: r.unitPriceMicros, priceVersion: r.priceVersion, splitManifestHash: r.splitManifestHash });

/** Insertion order is authoritative; signed completion timestamps may run backwards across channels. */
export async function readIdentityMarkupRemainder(db: D1Database, payer: string, offerId: string): Promise<bigint> {
  const legacy = await db.prepare(`SELECT 1 AS legacy FROM usage_receipts
    WHERE payer = ? AND offer_id = ? AND release_ref LIKE 'identity-release:%'
      AND identity_ceiling_micros IS NULL LIMIT 1`).bind(payer, offerId).first();
  if (legacy) throw new Error('identity-history-unverifiable');
  const row = await db.prepare(`SELECT markup_remainder FROM usage_receipts
    WHERE payer = ? AND offer_id = ? AND identity_ceiling_micros IS NOT NULL AND state = 'settled'
    ORDER BY rowid DESC LIMIT 1`).bind(payer, offerId).first<{ markup_remainder: number }>();
  if (row && (!Number.isSafeInteger(row.markup_remainder) || row.markup_remainder < 0 || row.markup_remainder >= 10000)) {
    throw new Error('unreadable identity remainder');
  }
  return row ? BigInt(row.markup_remainder) : 0n;
}

/**
 * Persist a reservation.
 *
 * The insert is deliberately UNGUARDED by a prior read: the PRIMARY KEY is the
 * race winner, so two concurrent requests carrying the same nonce cannot both
 * reserve, however they interleave. `ON CONFLICT DO NOTHING` turns the loser
 * into a named `duplicate-nonce` refusal instead of a 500.
 */
export async function reserveUsageReceipt(
  db: D1Database,
  input: ReserveUsageReceiptInput,
): Promise<ReserveUsageReceiptResult> {
  if (![input.meterQuantity, input.unitPriceMicros, input.reservedMicros, input.cumulativeClaimMicros].every(safeMicros) ||
      input.meterQuantity <= 0n || input.unitPriceMicros <= 0n ||
      input.reservedMicros !== input.meterQuantity * input.unitPriceMicros ||
      !Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.expiresAtMs)) {
    return { ok: false, code: 'invalid-ledger-range', receipt: null };
  }
  if (input.releaseRef.startsWith('identity-release:')) {
    const q = quoteIdentityInferenceTurn({ offer: { skuRef: input.releaseRef, meterUnit: input.meterUnit,
      unitPriceMicros: Number(input.unitPriceMicros), priceVersion: input.priceVersion, splitManifestHash: input.splitManifestHash },
      billedInferenceMicros: 0n, inferenceCeilingMicros: input.identityInferenceCeilingMicros ?? 0n });
    if (!q.ok || !safeMicros(input.identityInferenceCeilingMicros ?? 0n) ||
        q.reservationQuantity !== input.meterQuantity || q.reservedMarkupMicros !== input.reservedMicros) {
      return { ok: false, code: 'identity-ceiling-mismatch', receipt: null };
    }
  } else if (input.identityInferenceCeilingMicros !== undefined) {
    return { ok: false, code: 'identity-ceiling-mismatch', receipt: null };
  }
  let changes: number;
  try {
    const written = await db
    .prepare(
      `INSERT INTO usage_receipts (
         channel_id, usage_nonce, principal_id, offer_id, payer, seller,
         release_ref, meter_unit, meter_quantity, unit_price_micros,
         price_version, split_manifest_hash, reserved_micros, amount_micros,
         cumulative_claim_micros, expires_at_ms, voucher_digest, voucher_signature,
         receipt_signature, state, reserved_at_ms, settled_at_ms, identity_ceiling_micros, seller_pubkey_base64
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'reserved', ?, NULL, ?, ?)
       ON CONFLICT (channel_id, usage_nonce) DO NOTHING`,
    )
    .bind(
      input.channelId,
      input.usageNonce,
      input.principalId,
      input.offerId,
      input.payer,
      input.seller,
      input.releaseRef,
      input.meterUnit,
      Number(input.meterQuantity),
      Number(input.unitPriceMicros),
      input.priceVersion,
      input.splitManifestHash,
      Number(input.reservedMicros),
      Number(input.cumulativeClaimMicros),
      input.expiresAtMs,
      input.voucherDigest,
      input.voucherSignature,
      input.nowMs,
      input.identityInferenceCeilingMicros === undefined ? null : Number(input.identityInferenceCeilingMicros),
      input.sellerPubkeyBase64 ?? null,
    )
    .run();
    changes = written.meta.changes;
  } catch (error) {
    const receipt = await getUsageReceipt(db, input.channelId, input.usageNonce);
    if (receipt) return { ok: false, code: 'duplicate-nonce', receipt };
    const message = error instanceof Error ? error.message : String(error);
    const code = ['cap-exhausted', 'cumulative-regression', 'channel_not_open',
      'identity-account-mismatch', 'identity-account-pending'].find((value) => message.includes(value));
    if (code) return { ok: false, code, receipt: null };
    throw error;
  }
  const stored = await getUsageReceipt(db, input.channelId, input.usageNonce);
  if (!stored) return { ok: false, code: 'duplicate-nonce', receipt: null };
  // A row whose digest differs from the one we just built is somebody else's
  // reservation under the same nonce — the conflict we were guarding against.
  if (changes !== 1 || stored.voucherDigest !== input.voucherDigest || stored.reservedAtMs !== input.nowMs) {
    return { ok: false, code: 'duplicate-nonce', receipt: stored };
  }
  return { ok: true, receipt: stored };
}

export interface SettleUsageReceiptInput {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly amountMicros: bigint;
  readonly meterQuantity: bigint;
  readonly receiptSignature: string;
  readonly nowMs: number;
  readonly identityInference?: {
    readonly billedInferenceMicros: bigint;
    readonly priorRemainderNumerator: bigint;
    readonly remainderNumerator: bigint;
  };
}

export type SettleUsageReceiptResult =
  | { readonly ok: true; readonly receipt: StoredUsageReceipt }
  | {
      readonly ok: false;
      readonly code: 'unknown-reservation' | 'already-settled' | 'cap-exhausted' | 'actual-exceeds-reservation' | 'identity-settlement-mismatch' | 'invalid-ledger-range';
      readonly detail: string;
    };

/**
 * Settle a reservation and advance the channel's committed escrow, atomically.
 *
 * Both writes go in ONE `db.batch`. If the committed increment would break mig
 * 023's `committed_micros + refunded_micros <= escrow_micros` CHECK, the whole
 * batch rolls back — so a settlement can never record a receipt for money the
 * escrow does not hold. That constraint IS the durable cap-exhaustion refusal;
 * the pure core's in-memory check is the fast path, not the authority.
 */
export async function settleUsageReceipt(
  db: D1Database,
  input: SettleUsageReceiptInput,
): Promise<SettleUsageReceiptResult> {
  const existing = await getUsageReceipt(db, input.channelId, input.usageNonce);
  if (!existing) {
    return { ok: false, code: 'unknown-reservation', detail: `no reservation for usage nonce '${input.usageNonce}'` };
  }
  if (![input.amountMicros, input.meterQuantity].every(safeMicros) || input.meterQuantity < 0n ||
      !input.receiptSignature.trim() || !Number.isSafeInteger(input.nowMs) || input.nowMs < existing.reservedAtMs) {
    return { ok: false, code: 'invalid-ledger-range', detail: 'exact safe-integer ledger amounts and a signed completion time after admission are required' };
  }
  const matches = (r: StoredUsageReceipt): boolean => r.state === 'settled' &&
    r.amountMicros === Number(input.amountMicros) && r.meterQuantity === Number(input.meterQuantity) &&
    r.receiptSignature === input.receiptSignature && r.settledAtMs === input.nowMs &&
    (input.identityInference ? r.identityInference?.billedInferenceMicros === Number(input.identityInference.billedInferenceMicros) &&
      r.identityInference.priorRemainderNumerator === Number(input.identityInference.priorRemainderNumerator) &&
      r.identityInference.remainderNumerator === Number(input.identityInference.remainderNumerator) : !r.identityInference);
  if (existing.state === 'settled') {
    if (matches(existing)) return { ok: true, receipt: existing };
    return { ok: false, code: 'already-settled', detail: `usage nonce '${input.usageNonce}' was already settled` };
  }
  if (existing.identityInference) {
    const exact = input.identityInference;
    const prior = await readIdentityMarkupRemainder(db, existing.payer, existing.offerId);
    const q = exact && quoteIdentityInferenceTurn({ offer: receiptOffer(existing),
      inferenceCeilingMicros: BigInt(existing.identityInference.ceilingMicros),
      billedInferenceMicros: exact.billedInferenceMicros, priorRemainderNumerator: prior });
    if (!q || !q.ok || exact!.priorRemainderNumerator !== prior || q.remainderNumerator !== exact!.remainderNumerator ||
        q.amountMicros !== input.amountMicros || q.reservationQuantity !== input.meterQuantity) {
      return { ok: false, code: 'identity-settlement-mismatch', detail: 'identity actual amount must match exact billed cost and the hosted remainder' };
    }
  } else if (input.identityInference) {
    return { ok: false, code: 'identity-settlement-mismatch', detail: 'reservation is not an exact identity turn' };
  } else if (!Number.isSafeInteger(existing.reservedMeterQuantity) || existing.reservedMeterQuantity <= 0 ||
      input.meterQuantity > BigInt(existing.reservedMeterQuantity) ||
      input.amountMicros !== input.meterQuantity * BigInt(existing.unitPriceMicros)) {
    return { ok: false, code: 'actual-exceeds-reservation', detail: 'actual units and amount must match the original priced reservation' };
  }
  try {
    await db.batch([
      // Guard the monetary update BEFORE transitioning the receipt, in the
      // same transaction. A competing setter that read reserved changes zero.
      db.prepare(`UPDATE payment_channels SET committed_micros = committed_micros + ?, updated_at_ms = ?
        WHERE channel_id = ? AND EXISTS (SELECT 1 FROM usage_receipts
          WHERE channel_id = ? AND usage_nonce = ? AND state = 'reserved')`)
        .bind(Number(input.amountMicros), input.nowMs, input.channelId, input.channelId, input.usageNonce),
      db
        .prepare(
          `UPDATE usage_receipts
              SET state = 'settled', amount_micros = ?, settled_meter_quantity = ?,
                  receipt_signature = ?, settled_at_ms = ?, billed_inference_micros = ?,
                  prior_markup_remainder = ?, markup_remainder = ?
            WHERE channel_id = ? AND usage_nonce = ? AND state = 'reserved'`,
        )
        .bind(
          Number(input.amountMicros),
          Number(input.meterQuantity),
          input.receiptSignature,
          input.nowMs,
          input.identityInference ? Number(input.identityInference.billedInferenceMicros) : null,
          input.identityInference ? Number(input.identityInference.priorRemainderNumerator) : null,
          input.identityInference ? Number(input.identityInference.remainderNumerator) : null,
          input.channelId,
          input.usageNonce,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/identity-(?:settlement|remainder)-mismatch/.test(message)) {
      return { ok: false, code: 'identity-settlement-mismatch', detail: 'the hosted identity remainder or closure changed' };
    }
    // The CHECK constraint is the only failure this batch can produce that is a
    // legitimate refusal rather than a bug; anything else must not be swallowed.
    if (/CHECK constraint|constraint failed/i.test(message)) {
      return { ok: false, code: 'cap-exhausted', detail: 'settling this receipt would exceed the channel escrow' };
    }
    throw error;
  }
  const settled = await getUsageReceipt(db, input.channelId, input.usageNonce);
  if (!settled || settled.state !== 'settled') {
    return { ok: false, code: 'unknown-reservation', detail: `reservation '${input.usageNonce}' was not settled` };
  }
  if (!matches(settled)) return { ok: false, code: 'already-settled', detail: 'a different signed settlement won this reservation' };
  return { ok: true, receipt: settled };
}
