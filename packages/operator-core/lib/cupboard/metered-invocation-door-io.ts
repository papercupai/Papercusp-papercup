/**
 * Client transport for the P-031 metering doors
 * (shared-pot-dao-cupboard-v1-2026-09-04, requirement line 5).
 *
 * The hosted `metered-usage` route is the AUTHORITY on whether a billable unit
 * may be served — it holds the durable channel and the published terms (D-055).
 * This module is the payer's and seller's side of that conversation, and it runs
 * the SAME pure interception (`p2p/metered-invocation.ts`) locally first.
 *
 * Running it twice is deliberate, not redundant. The local pass refuses a
 * cap-exhausted, replayed or regressed unit BEFORE the round trip, while
 * refusing is still free; the hosted pass refuses it again against state the
 * client cannot forge. Neither is trusted to stand in for the other: a client
 * that skipped the local pass would burn a request to learn what it already
 * knew, and a hosted door that trusted the local pass would accept whatever a
 * modified client asserted.
 *
 * SIGNING SEAM. `openMeteredInvocation`/`closeMeteredInvocation` are pure and
 * take a SYNCHRONOUS signer, but every real key here is behind an async
 * keychain (`identity/hive-keypair.ts`). So each is evaluated twice over
 * identical inputs: once to capture the canonical bytes, then — after the async
 * signature comes back — once more to produce the real artifact. Both functions
 * are pure, so the second evaluation is the first one plus a signature; nothing
 * is committed in between, and the fixed `nowMs`/`occurredAtMs` keeps the two
 * passes byte-identical.
 */
import { z } from 'zod';
import {
  closeMeteredInvocation,
  declareMeter,
  openMeteredInvocation,
  verifySellerReceiptAuthority,
  type BillableUnit,
  type MeterDeclaration,
  type MeteredRefusalCode,
  type PerUseTermsInput,
  type CloseMeteredInvocationInput,
  type SellerReceiptAuthority,
} from '../p2p/metered-invocation';
import type { CumulativePaymentVoucher, MicrochargeChannel } from '../p2p/microcharge';
import { resolveCupboardBaseUrl } from './base-url';
import type { InstalledPluginProvenance } from './types';
import { quoteIdentityInferenceTurn } from './identity-per-use-offer';
import type { IdentityUsageStatement } from './commerce-dashboards';

/** Reused verbatim from the checkout door so both share one transport seam. */
export interface MeteredTransportDeps {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  /** Override the GitHub bearer; omitted in production, supplied by tests. */
  readonly authToken?: string;
}

/**
 * Produces a signature over canonical bytes. Production binds this to the hive
 * key (`signWithHiveKey(workspaceId, hiveSlug, bytes)`); tests supply their own.
 */
export type MeteredByteSigner = (bytes: Buffer) => Promise<string> | string;

export const METERED_INVOCATIONS_PATH = '/commerce/metered-invocations';
export const CHANNEL_USAGE_PATH = '/commerce/payment-channels';

export type MeteredDoorErrorCode =
  | MeteredRefusalCode
  | 'gh_auth_required'
  | 'transport_error'
  | 'invalid_request'
  | 'invalid_voucher'
  | 'unauthorized'
  | 'forbidden'
  | 'unknown_channel'
  | 'unknown_offer'
  | 'inactive_offer'
  | 'not_metered'
  | 'channel_not_open'
  | 'already-settled'
  | string;

export interface MeteredDoorFailure {
  readonly ok: false;
  readonly code: MeteredDoorErrorCode;
  readonly detail: string;
  /** 0 when the request never left this process (local refusal or transport). */
  readonly status: number;
  readonly refusedBy: 'local-interception' | 'hosted-door' | 'transport';
}

/** One usage receipt as the hosted door renders it — amounts are decimal strings. */
export interface UsageReceiptWire {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly offerId: string;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly meterUnit: string;
  readonly meterQuantity: string;
  readonly unitPriceMicros: string;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
  readonly reservedMicros: string;
  readonly amountMicros: string | null;
  readonly cumulativeClaimMicros: string;
  /** Canonical field of the signed voucher — needed to re-derive its digest. */
  readonly expiresAtMs: number;
  readonly voucherDigest: string;
  /** The payer's signature over the voucher; the seller's claim to the money. */
  readonly voucherSignature: string;
  readonly receiptSignature: string | null;
  readonly state: 'reserved' | 'settled';
  readonly reservedAtMs: number;
  readonly settledAtMs: number | null;
  readonly identityInference?: {
    readonly ceilingMicros: string;
    readonly billedInferenceMicros: string | null;
    readonly priorRemainderNumerator: string | null;
    readonly remainderNumerator: string | null;
  };
}

export interface ChannelUsageWire {
  readonly channelId: string;
  readonly escrowMicros: string;
  readonly committedMicros: string;
  readonly receipts: readonly UsageReceiptWire[];
  readonly identityStatement?: IdentityUsageStatement;
  /** Requested explicitly; the hosted payer/offer history spans every channel. */
  readonly identityMarkupOrigin?: IdentityMarkupOriginWire;
}

/** One authenticated live page; totals never describe a whole-account snapshot. */
export interface PrincipalUsagePage {
  readonly receipts: readonly UsageReceiptWire[];
  readonly identityStatement: IdentityUsageStatement;
  readonly nextCursor: string | null;
  readonly coverage: {
    readonly scope: 'authenticated-principal';
    readonly population: 'live-page';
    readonly totals: 'page';
    readonly hasMore: boolean;
  };
}

const decimalMicros = z.string().regex(/^(0|[1-9][0-9]*)$/);
const wireId = z.string().min(1);
const usageCursor = z.string().max(2000).refine((value) => {
  try {
    const tuple: unknown = JSON.parse(value);
    return Array.isArray(tuple) && tuple.length === 2 && tuple.every(part =>
      typeof part === 'string' && part.length > 0 && part.length <= 300 && part.trim() === part);
  } catch { return false; }
});

const principalUsagePageSchema = z.object({
  receipts: z.array(z.object({
    channelId: wireId, usageNonce: wireId, offerId: wireId, payer: wireId, seller: wireId,
    releaseRef: wireId, meterUnit: wireId, meterQuantity: decimalMicros, unitPriceMicros: decimalMicros,
    priceVersion: wireId, splitManifestHash: wireId, reservedMicros: decimalMicros,
    amountMicros: decimalMicros.nullable(), cumulativeClaimMicros: decimalMicros,
    expiresAtMs: z.number().int().nonnegative().safe(), voucherDigest: wireId, voucherSignature: wireId,
    receiptSignature: z.string().nullable(), state: z.enum(['reserved', 'settled']),
    reservedAtMs: z.number().int().nonnegative().safe(), settledAtMs: z.number().int().nonnegative().safe().nullable(),
    identityInference: z.object({ ceilingMicros: decimalMicros, billedInferenceMicros: decimalMicros.nullable(),
      priorRemainderNumerator: decimalMicros.nullable(), remainderNumerator: decimalMicros.nullable() }).optional(),
  })).max(200),
  identityStatement: z.object({
    basis: z.literal('hosted-settled-usage'), currency: z.literal('USD'), chainFinality: z.literal('not-measured'),
    allocationBasis: z.literal('per-receipt-quote'),
    lines: z.array(z.object({ channelId: wireId, usageNonce: wireId, offerId: wireId, releaseRef: wireId,
      payer: wireId, seller: wireId, priceVersion: wireId, splitManifestHash: wireId,
      billedInferenceMicros: decimalMicros, markupMicros: decimalMicros,
      allocationQuote: z.object({ creatorMicros: decimalMicros, daoMicros: decimalMicros, componentMicros: decimalMicros,
        componentAuthorsMicros: z.record(z.string(), decimalMicros).nullable() }),
    })).max(200),
    markupMicros: decimalMicros, reservedReceipts: z.number().int().min(0).max(200), complete: z.boolean(),
    issues: z.array(z.object({ channelId: wireId, usageNonce: wireId, reason: wireId })).max(200),
    costPerAcceptedOutcomeMicros: z.null(), outcomeEvidence: z.literal('unavailable'),
  }),
  nextCursor: usageCursor.nullable(),
  coverage: z.object({ scope: z.literal('authenticated-principal'), population: z.literal('live-page'),
    totals: z.literal('page'), hasMore: z.boolean() }),
}).superRefine((page, ctx) => {
  const statement = page.identityStatement;
  if (page.coverage.hasMore !== (page.nextCursor !== null) ||
      statement.complete !== (statement.issues.length === 0) ||
      statement.lines.reduce((sum, line) => sum + BigInt(line.markupMicros), 0n) !== BigInt(statement.markupMicros)) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent statement page coverage or totals' });
  }
  const receipts = new Map(page.receipts.map(receipt => [JSON.stringify([receipt.channelId, receipt.usageNonce]), receipt]));
  const seen = new Set<string>();
  for (const line of statement.lines) {
    const key = JSON.stringify([line.channelId, line.usageNonce]);
    const receipt = receipts.get(key), quote = line.allocationQuote;
    if (seen.has(key) || !receipt || receipt.state !== 'settled' || receipt.amountMicros !== line.markupMicros ||
        receipt.identityInference?.billedInferenceMicros !== line.billedInferenceMicros ||
        !(['offerId', 'releaseRef', 'payer', 'seller', 'priceVersion', 'splitManifestHash'] as const)
          .every(field => receipt[field] === line[field]) ||
        BigInt(quote.creatorMicros) + BigInt(quote.daoMicros) + BigInt(quote.componentMicros) !== BigInt(line.markupMicros) ||
        (quote.componentAuthorsMicros !== null && Object.values(quote.componentAuthorsMicros)
          .reduce((sum, amount) => sum + BigInt(amount), 0n) !== BigInt(quote.componentMicros))) {
      ctx.addIssue({ code: 'custom', message: 'statement line does not conserve its recorded receipt' });
    }
    seen.add(key);
  }
});

export interface IdentityMarkupOriginWire {
  readonly offerId: string;
  readonly payer: string;
  readonly seller: string;
  readonly offer: { readonly skuRef: string; readonly meterUnit: string; readonly unitPriceMicros: number;
    readonly priceVersion: string; readonly splitManifestHash: string };
  readonly remainderNumerator: string;
}

const fail = (
  code: MeteredDoorErrorCode,
  detail: string,
  status: number,
  refusedBy: MeteredDoorFailure['refusedBy'],
): MeteredDoorFailure => ({ ok: false, code, detail, status, refusedBy });

async function resolveBearer(deps: MeteredTransportDeps): Promise<{ ok: true; token: string } | MeteredDoorFailure> {
  if (deps.authToken !== undefined) return { ok: true, token: deps.authToken };
  const { getGhAuthToken } = await import('../identity/gh-token');
  const resolved = await getGhAuthToken();
  if (resolved.kind !== 'ok') {
    return fail('gh_auth_required', 'no GitHub token is available to authenticate the metering request', 401, 'transport');
  }
  return { ok: true, token: resolved.token };
}

interface HostedCall {
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  readonly expect: readonly number[];
}

async function callHostedDoor(
  call: HostedCall,
  deps: MeteredTransportDeps,
): Promise<{ ok: true; payload: Record<string, unknown> } | MeteredDoorFailure> {
  const bearer = await resolveBearer(deps);
  if ('ok' in bearer && bearer.ok !== true) return bearer as MeteredDoorFailure;
  const token = (bearer as { token: string }).token;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = (deps.baseUrl ?? resolveCupboardBaseUrl()).replace(/\/+$/, '');

  let response: Response;
  try {
    response = await fetchImpl(`${base}${call.path}`, {
      method: call.method,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
  } catch (err) {
    return fail('transport_error', err instanceof Error ? err.message : String(err), 0, 'transport');
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  const payload = (parsed ?? {}) as Record<string, unknown>;

  if (!call.expect.includes(response.status)) {
    return fail(
      typeof payload.error === 'string' ? payload.error : `http_${response.status}`,
      typeof payload.detail === 'string' ? payload.detail : `the metering door answered ${response.status}`,
      response.status,
      'hosted-door',
    );
  }
  return { ok: true, payload };
}

/** Commerce identity retained by the hosted offer projection; SKU is opaque. */
export interface HostedPerUseOffer {
  readonly offerId: string;
  readonly productId: string;
  readonly skuRef: string;
  readonly creatorId: string;
  readonly active: boolean;
  readonly productActive: boolean;
  readonly terms: PerUseTermsInput;
  readonly receiptAuthority?: SellerReceiptAuthority;
}

export async function readHostedPerUseOffers(
  deps: MeteredTransportDeps = {},
): Promise<{ ok: true; offers: HostedPerUseOffer[] } | MeteredDoorFailure> {
  const called = await callHostedDoor({ path: '/commerce/offers?pricing=per-use', method: 'GET', expect: [200] }, deps);
  if (!called.ok) return called;
  if (!Array.isArray(called.payload.offers)) return fail('invalid_catalog', 'hosted offers are unreadable', 200, 'hosted-door');
  const offers: HostedPerUseOffer[] = [];
  for (const raw of called.payload.offers) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail('invalid_catalog', 'hosted offer is malformed', 200, 'hosted-door');
    }
    const o = raw as Record<string, unknown>;
    const terms = o.perUse as PerUseTermsInput | null;
    if (![o.offerId, o.productId, o.skuRef, o.creatorId].every((v) => typeof v === 'string' && v.trim()) ||
        typeof o.active !== 'boolean' || typeof o.productActive !== 'boolean' || o.pricingModel !== 'per-use' ||
        !terms || typeof terms !== 'object' || !Number.isSafeInteger(terms.unitPriceMicros) ||
        typeof terms.meterUnit !== 'string' || typeof terms.priceVersion !== 'string' ||
        typeof terms.splitManifestHash !== 'string' || !declareMeter(terms).ok) {
      return fail('invalid_catalog', 'hosted per-use identity or terms are malformed', 200, 'hosted-door');
    }
    const authority = o.receiptAuthority as SellerReceiptAuthority | undefined;
    if (authority !== undefined && !verifySellerReceiptAuthority({ seller: o.creatorId as string,
        offerId: o.offerId as string, productId: o.productId as string, skuRef: o.skuRef as string }, authority)) {
      return fail('invalid_catalog', 'hosted seller receipt authority does not bind this exact offer', 200, 'hosted-door');
    }
    offers.push({ offerId: o.offerId as string, productId: o.productId as string, skuRef: o.skuRef as string,
      creatorId: o.creatorId as string, active: o.active, productActive: o.productActive, terms: { ...terms },
      ...(authority ? { receiptAuthority: { pubkeyBase64: authority.pubkeyBase64, proof: authority.proof } } : {}) });
  }
  return { ok: true, offers };
}

/** Call ONLY with provenance reverified against hosted pinned bytes at turn admission. */
export function bindInstalledPerUseOffer(
  provenance: InstalledPluginProvenance,
  offers: readonly HostedPerUseOffer[],
): { ok: true; offer: HostedPerUseOffer } | MeteredDoorFailure {
  const listing = provenance.listing;
  if (listing.priceModel !== 'per-use' || !listing.skuRef || !listing.publisherId ||
      !listing.listingId || listing.releaseVersion !== provenance.version) {
    return fail('installation_binding_required', 'an exact per-use installation is required', 0, 'local-interception');
  }
  const active = offers.filter((o) => o.skuRef === listing.skuRef && o.creatorId === listing.publisherId &&
    o.active && o.productActive);
  if (active.length !== 1) return fail(active.length ? 'ambiguous_offer' : 'unknown_offer',
    'the loaded release must have one active offer from its verified publisher', 0, 'local-interception');
  return { ok: true, offer: structuredClone(active[0]!) };
}

/** Omit payer to discover the authenticated bearer principal, never a local
 * workspace alias. Explicit buyers retain hosted organization authorization. */
export async function readHostedToolEntitlements(
  payer: string | undefined,
  deps: MeteredTransportDeps = {},
): Promise<{ ok: true; payer: string; productIds: readonly string[] } | MeteredDoorFailure> {
  if (payer !== undefined && !payer.trim()) return fail('invalid_request', 'a named payer must be nonempty', 0, 'local-interception');
  const called = await callHostedDoor({ path: '/commerce/entitlements' +
    (payer === undefined ? '' : `?buyer=${encodeURIComponent(payer)}`),
    method: 'GET', expect: [200] }, deps);
  if (!called.ok) return called;
  const buyer = called.payload.buyer;
  if (typeof buyer !== 'string' || !buyer.trim() ||
      (payer === undefined ? !/^gh:\d+$/.test(buyer) : buyer !== payer) ||
      !Array.isArray(called.payload.entitlements)) {
    return fail('invalid_entitlements', 'hosted entitlements differ from the target buyer', 200, 'hosted-door');
  }
  for (const row of called.payload.entitlements) {
    if (!row || typeof row !== 'object' || row.buyer_id !== buyer || typeof row.product_id !== 'string' || !row.product_id.trim() ||
        row.state !== 'active' || row.revoked_at_ms !== null) {
      return fail('invalid_entitlements', 'hosted active entitlement is malformed or belongs to another buyer', 200, 'hosted-door');
    }
  }
  return { ok: true, payer: buyer, productIds: called.payload.entitlements.map(row => row.product_id as string) };
}

/** Owner-authorized buyer read. A token for another principal cannot grant this target access. */
export async function readHostedToolEntitlement(
  payer: string,
  productId: string,
  deps: MeteredTransportDeps = {},
): Promise<{ ok: true; entitled: boolean } | MeteredDoorFailure> {
  if (!payer.trim() || !productId.trim()) return fail('invalid_request', 'payer and product are required', 0, 'local-interception');
  const read = await readHostedToolEntitlements(payer, deps);
  return read.ok ? { ok: true, entitled: read.productIds.includes(productId) } : read;
}

/** Re-read the durable channel's authenticated funder before turn admission. */
export async function readHostedToolChannel(
  channelId: string,
  payer: string,
  deps: MeteredTransportDeps = {},
  expectedPayerPubkeyBase64?: string,
): Promise<{ ok: true; escrowMicros: bigint; committedMicros: bigint } | MeteredDoorFailure> {
  const called = await callHostedDoor({ path: `${CHANNEL_USAGE_PATH}/${encodeURIComponent(channelId)}`,
    method: 'GET', expect: [200] }, deps);
  if (!called.ok) return called;
  const c = called.payload.channel as Record<string, unknown> | undefined;
  if (!c || c.channelId !== channelId || c.principalId !== payer || c.state !== 'open' ||
      (expectedPayerPubkeyBase64 !== undefined && c.payerPubkeyBase64 !== expectedPayerPubkeyBase64) ||
      !Number.isSafeInteger(c.escrowMicros) || !Number.isSafeInteger(c.committedMicros) ||
      (c.escrowMicros as number) < 0 || (c.committedMicros as number) < 0 ||
      (c.committedMicros as number) > (c.escrowMicros as number)) {
    return fail('channel_binding_mismatch', 'target payer needs an open funded channel it owns', 200, 'hosted-door');
  }
  return { ok: true, escrowMicros: BigInt(c.escrowMicros as number), committedMicros: BigInt(c.committedMicros as number) };
}

/**
 * Rebuild the payer's view of the channel from the hosted usage read.
 *
 * This mirrors the Worker's own `loadMicrochargeChannel` derivation on purpose:
 * the cumulative claim a new voucher must exceed is the HIGHEST claim already
 * observed, not the count of receipts. Deriving it from the receipts rather than
 * tracking it locally is what makes a client that missed a unit (a crash, a
 * concurrent seat) recover the right base instead of regressing into a refusal.
 */
export function channelFromUsage(usage: ChannelUsageWire): MicrochargeChannel {
  const reservations: Record<string, bigint> = {};
  const receipts: Record<string, string> = {};
  let lastCumulativeMicros = 0n;
  for (const r of usage.receipts) {
    const claim = BigInt(r.cumulativeClaimMicros);
    if (claim > lastCumulativeMicros) lastCumulativeMicros = claim;
    if (r.state === 'reserved') reservations[r.usageNonce] = BigInt(r.reservedMicros);
    else receipts[r.usageNonce] = r.voucherDigest;
  }
  return {
    channelId: usage.channelId,
    escrowMicros: BigInt(usage.escrowMicros),
    committedMicros: BigInt(usage.committedMicros),
    lastCumulativeMicros,
    reservations,
    receipts,
  };
}

export async function readChannelUsage(
  channelId: string,
  deps: MeteredTransportDeps = {},
  identityOfferId?: string,
): Promise<{ ok: true; usage: ChannelUsageWire } | MeteredDoorFailure> {
  const called = await callHostedDoor(
    { path: `${CHANNEL_USAGE_PATH}/${encodeURIComponent(channelId)}/usage` +
      (identityOfferId === undefined ? '' : `?identityOfferId=${encodeURIComponent(identityOfferId)}`), method: 'GET', expect: [200] },
    deps,
  );
  if (!('usage' in called) && called.ok !== true) return called as MeteredDoorFailure;
  const payload = (called as { payload: Record<string, unknown> }).payload;
  return { ok: true, usage: payload as unknown as ChannelUsageWire };
}

/** No principal argument: the hosted door derives visibility from the bearer. */
export async function readPrincipalUsagePage(
  input: { readonly limit?: number; readonly cursor?: string } = {},
  deps: MeteredTransportDeps = {},
): Promise<{ ok: true; page: PrincipalUsagePage } | MeteredDoorFailure> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      (input.cursor !== undefined && !usageCursor.safeParse(input.cursor).success)) {
    return fail('invalid_request', 'usage requires limit 1..200 and an exact page cursor', 0, 'local-interception');
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  const called = await callHostedDoor({ path: `${METERED_INVOCATIONS_PATH}?${query}`, method: 'GET', expect: [200] }, deps);
  if (!called.ok) return called;
  const parsed = principalUsagePageSchema.safeParse(called.payload);
  if (!parsed.success || parsed.data.receipts.length > limit || parsed.data.nextCursor === input.cursor) {
    return fail('invalid_usage_page', 'hosted usage page is malformed or inconsistent', 200, 'hosted-door');
  }
  return { ok: true, page: parsed.data };
}

/** Amounts cross the JSON boundary as decimal STRINGS: micros can exceed 2^53. */
function voucherWire(voucher: CumulativePaymentVoucher): Record<string, unknown> {
  return {
    channelId: voucher.channelId,
    payer: voucher.payer,
    seller: voucher.seller,
    releaseRef: voucher.releaseRef,
    usageNonce: voucher.usageNonce,
    meterQuantity: String(voucher.meterQuantity),
    pricePerUnitMicros: String(voucher.pricePerUnitMicros),
    priceVersion: voucher.priceVersion,
    splitManifestHash: voucher.splitManifestHash,
    expiresAtMs: voucher.expiresAtMs,
    cumulativeClaimMicros: String(voucher.cumulativeClaimMicros),
    signature: voucher.signature,
  };
}

export interface ReserveMeteredUnitInput {
  readonly channelId: string;
  readonly offerId: string;
  /** The published per-use terms, as `cupboard:checkout`'s preflight returned them. */
  readonly terms: PerUseTermsInput;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly usageNonce: string;
  readonly quantity: bigint;
  readonly expiresAtMs: number;
  readonly nowMs?: number;
  readonly signVoucher: MeteredByteSigner;
  readonly identityInferenceCeilingMicros?: bigint;
}

export interface ReserveMeteredUnitOk {
  readonly ok: true;
  readonly meter: MeterDeclaration;
  readonly voucher: CumulativePaymentVoucher;
  readonly reservedMicros: bigint;
  readonly receipt: UsageReceiptWire;
}

/**
 * INTERCEPTION POINT — reserve one billable unit before the seller executes it.
 *
 * Order is load-bearing: declare the meter, read the channel, refuse locally,
 * sign, and only then POST. A unit that cannot produce a `MeterDeclaration`
 * never reaches the network, which is what stops an unpriced unit from being
 * served on the assumption that the hosted door will catch it.
 */
export async function reserveMeteredUnit(
  input: ReserveMeteredUnitInput,
  deps: MeteredTransportDeps = {},
): Promise<ReserveMeteredUnitOk | MeteredDoorFailure> {
  const declared = declareMeter(input.terms);
  if (!declared.ok) return fail(declared.code, declared.detail, 0, 'local-interception');
  if (input.releaseRef.startsWith('identity-release:')) {
    if (typeof input.terms.unitPriceMicros !== 'number') return fail('identity-ceiling-mismatch', 'identity terms require an exact catalog price', 0, 'local-interception');
    const q = quoteIdentityInferenceTurn({ offer: { skuRef: input.releaseRef, ...input.terms, unitPriceMicros: input.terms.unitPriceMicros },
      billedInferenceMicros: 0n, inferenceCeilingMicros: input.identityInferenceCeilingMicros ?? 0n });
    if (!q.ok || q.reservationQuantity !== input.quantity) return fail('identity-ceiling-mismatch', 'the identity ceiling must match the signed block quantity', 0, 'local-interception');
  } else if (input.identityInferenceCeilingMicros !== undefined) {
    return fail('identity-ceiling-mismatch', 'ordinary units cannot carry identity ceilings', 0, 'local-interception');
  }

  const usage = await readChannelUsage(input.channelId, deps);
  if (usage.ok !== true) return usage;
  const channel = channelFromUsage(usage.usage);

  const unit: BillableUnit = {
    payer: input.payer,
    seller: input.seller,
    releaseRef: input.releaseRef,
    usageNonce: input.usageNonce,
    quantity: input.quantity,
    expiresAtMs: input.expiresAtMs,
  };
  const nowMs = input.nowMs ?? Date.now();

  // Pass 1 captures the canonical bytes and runs every local refusal.
  let voucherBytes: Buffer | null = null;
  const probe = openMeteredInvocation({
    channel,
    meter: declared.meter,
    unit,
    nowMs,
    signVoucher: (bytes) => {
      voucherBytes = bytes;
      return 'probe';
    },
  });
  if (!probe.ok) return fail(probe.code, probe.detail, 0, 'local-interception');
  if (!voucherBytes) {
    return fail('unsigned-voucher', 'the interception never requested a voucher signature', 0, 'local-interception');
  }

  const signature = await input.signVoucher(voucherBytes);
  if (typeof signature !== 'string' || !signature.trim()) {
    return fail('unsigned-voucher', 'the payer signer returned no signature for the cumulative voucher', 0, 'local-interception');
  }

  // Pass 2 is pass 1 plus the real signature — same pure inputs, same bytes.
  const opened = openMeteredInvocation({ channel, meter: declared.meter, unit, nowMs, signVoucher: () => signature });
  if (!opened.ok) return fail(opened.code, opened.detail, 0, 'local-interception');

  const called = await callHostedDoor(
    {
      path: METERED_INVOCATIONS_PATH,
      method: 'POST',
      body: { channelId: input.channelId, offerId: input.offerId, voucher: voucherWire(opened.voucher),
        ...(input.identityInferenceCeilingMicros !== undefined ? { identityInferenceCeilingMicros: String(input.identityInferenceCeilingMicros) } : {}) },
      expect: [201],
    },
    deps,
  );
  if (called.ok !== true) return called;

  return {
    ok: true,
    meter: declared.meter,
    voucher: opened.voucher,
    reservedMicros: opened.reservedMicros,
    receipt: (called.payload.receipt ?? {}) as UsageReceiptWire,
  };
}

export interface SettleMeteredUnitInput {
  readonly channelId: string;
  readonly usageNonce: string;
  /** Units actually served; defaults to the reserved quantity. Never more. */
  readonly actualQuantity?: bigint;
  readonly occurredAtMs?: number;
  readonly signReceipt: MeteredByteSigner;
  readonly identityInference?: { readonly billedInferenceMicros: bigint; readonly priorRemainderNumerator: bigint };
}

export interface SettleMeteredUnitOk {
  readonly ok: true;
  readonly amountMicros: bigint;
  readonly receipt: UsageReceiptWire;
}

/**
 * INTERCEPTION POINT — settle the units actually served, after execution.
 *
 * The reserved voucher is rebuilt from the hosted receipt rather than from
 * anything the seller kept in memory, so a seller that restarted mid-unit
 * settles the same reservation instead of minting a second one.
 */
export async function settleMeteredUnit(
  input: SettleMeteredUnitInput,
  deps: MeteredTransportDeps = {},
): Promise<SettleMeteredUnitOk | MeteredDoorFailure> {
  const usage = await readChannelUsage(input.channelId, deps);
  if (usage.ok !== true) return usage;

  const reserved = usage.usage.receipts.find((r) => r.usageNonce === input.usageNonce);
  if (!reserved) {
    return fail('unknown-reservation', `no reservation for usage nonce '${input.usageNonce}'`, 0, 'local-interception');
  }
  if (reserved.state === 'settled') {
    return fail('already-settled', `usage nonce '${input.usageNonce}' was already settled`, 0, 'local-interception');
  }

  const channel = channelFromUsage(usage.usage);
  const voucher: CumulativePaymentVoucher = {
    channelId: reserved.channelId,
    payer: reserved.payer,
    seller: reserved.seller,
    releaseRef: reserved.releaseRef,
    usageNonce: reserved.usageNonce,
    meterQuantity: BigInt(reserved.meterQuantity),
    pricePerUnitMicros: BigInt(reserved.unitPriceMicros),
    priceVersion: reserved.priceVersion,
    splitManifestHash: reserved.splitManifestHash,
    // Read back, never substituted: `expiresAtMs` is hashed into the voucher
    // digest the receipt binds to, so a fabricated value would settle against a
    // voucher the payer never signed. Expiry is not re-checked here — the unit
    // was admitted at reservation — this is the DIGEST's input, not a deadline.
    expiresAtMs: reserved.expiresAtMs,
    cumulativeClaimMicros: BigInt(reserved.cumulativeClaimMicros),
    signature: reserved.voucherSignature,
  };

  const occurredAtMs = input.occurredAtMs ?? Date.now();
  const quantityArg = input.actualQuantity != null ? { actualQuantity: input.actualQuantity } : {};
  let identityArg: Pick<CloseMeteredInvocationInput, 'identityInference'> = {};
  if (input.identityInference) {
    if (!reserved.identityInference || !/^[1-9]\d*$/.test(reserved.identityInference.ceilingMicros)) {
      return fail('identity-settlement-mismatch', 'hosted reservation lacks an exact identity ceiling', 0, 'local-interception');
    }
    identityArg = { identityInference: { ...input.identityInference,
      inferenceCeilingMicros: BigInt(reserved.identityInference.ceilingMicros),
      offer: { skuRef: reserved.releaseRef, meterUnit: reserved.meterUnit,
        unitPriceMicros: Number(reserved.unitPriceMicros), priceVersion: reserved.priceVersion, splitManifestHash: reserved.splitManifestHash } } };
  }

  let receiptBytes: Buffer | null = null;
  const probe = closeMeteredInvocation({
    channel,
    voucher,
    ...quantityArg,
    ...identityArg,
    occurredAtMs,
    signReceipt: (bytes) => {
      receiptBytes = bytes;
      return 'probe';
    },
  });
  if (!probe.ok) return fail(probe.code, probe.detail, 0, 'local-interception');
  if (!receiptBytes) {
    return fail('unsigned-receipt', 'the interception never requested a receipt signature', 0, 'local-interception');
  }

  const signature = await input.signReceipt(receiptBytes);
  if (typeof signature !== 'string' || !signature.trim()) {
    return fail('unsigned-receipt', 'the seller signer returned no signature for the usage receipt', 0, 'local-interception');
  }

  const closed = closeMeteredInvocation({
    channel,
    voucher,
    ...quantityArg,
    ...identityArg,
    occurredAtMs,
    signReceipt: () => signature,
  });
  if (!closed.ok) return fail(closed.code, closed.detail, 0, 'local-interception');

  const called = await callHostedDoor(
    {
      path: `${METERED_INVOCATIONS_PATH}/${encodeURIComponent(input.usageNonce)}/settle`,
      method: 'POST',
      body: {
        channelId: input.channelId,
        receiptSignature: signature,
        occurredAtMs,
        ...(input.identityInference ? { billedInferenceMicros: String(input.identityInference.billedInferenceMicros),
          priorRemainderNumerator: String(input.identityInference.priorRemainderNumerator) } : {}),
        ...(input.actualQuantity != null ? { actualQuantity: String(input.actualQuantity) } : {}),
      },
      expect: [200],
    },
    deps,
  );
  if (called.ok !== true) return called;

  const receipt = called.payload.receipt as UsageReceiptWire | undefined;
  if (!receipt || receipt.state !== 'settled' || receipt.channelId !== reserved.channelId || receipt.usageNonce !== reserved.usageNonce ||
      receipt.amountMicros !== String(closed.amountMicros) || receipt.meterQuantity !== String(closed.receipt.meterQuantity) ||
      receipt.receiptSignature !== signature || receipt.settledAtMs !== occurredAtMs || receipt.voucherDigest !== reserved.voucherDigest) {
    return fail('settlement-binding-mismatch', 'hosted acknowledgement differs from the signed settlement', 200, 'hosted-door');
  }
  if (identityArg.identityInference) {
    const q = quoteIdentityInferenceTurn(identityArg.identityInference);
    const exact = receipt.identityInference;
    if (!q.ok || !exact || exact.ceilingMicros !== reserved.identityInference!.ceilingMicros ||
        exact.billedInferenceMicros !== String(identityArg.identityInference.billedInferenceMicros) ||
        exact.priorRemainderNumerator !== String(identityArg.identityInference.priorRemainderNumerator) ||
        exact.remainderNumerator !== String(q.remainderNumerator)) {
      return fail('settlement-binding-mismatch', 'hosted exact-cost acknowledgement differs from the durable quotation', 200, 'hosted-door');
    }
  }
  return { ok: true, amountMicros: closed.amountMicros, receipt };
}
