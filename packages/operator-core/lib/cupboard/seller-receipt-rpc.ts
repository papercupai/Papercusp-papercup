/** D-069: seller-local monetary authority over the existing signed peer RPC.
 * No buyer credentials, arbitrary signing bytes, HTTP proxy, or local fallback. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, verifyAuthorityRpc } from '../authority/authority-rpc-envelope';
import { registerAuthorityOp, registeredAuthorityOpKinds, type AuthorityOpHandler } from '../authority/authority-op-registry';
import { getPeerRpcTransport, type PeerRpcTransport } from '../authority/peer-rpc-transport';
import { resolveDeviceEnvelopeSigner } from '../authority/transport-wiring';
import { loadRevokedPubkeys } from '../sync/hyperbee/load-revoked-pubkeys';
import { activeWorkspaceId } from '../workspace-registry';
import { readIntegrationKey } from '../integration-credentials';
import { loadHiveKeyStatus, signWithHiveKey } from '../identity/hive-keypair';
import { verifyEd25519 } from '../identity/ed25519';
import { paymentVoucherDigest, paymentVoucherSigningBytes, type CumulativePaymentVoucher } from '../p2p/microcharge';
import { usageReceiptSigningBytes, verifySellerReceiptAuthority } from '../p2p/metered-invocation';
import { readChannelUsage, readHostedToolChannel, readHostedToolEntitlements, readHostedPerUseOffers, settleMeteredUnit } from './metered-invocation-door-io';
import type { FundedToolTurn, FundedToolTurnBinding } from './funded-tool-turn-store';
import type { FundedIdentityTurn, FundedIdentityTurnBinding } from './funded-turn-store';
import { quoteIdentityInferenceTurn } from './identity-per-use-offer';

export const INSTALLED_TOOL_FUNDING_CONFIG = 'CUPBOARD_INSTALLED_TOOL_FUNDING';
export const SELLER_RECEIPT_RPC_KIND = 'commerce.seller-receipt';
const id = z.string().min(1).max(300).refine(v => v.trim() === v);
const pubkey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const integer = z.string().regex(/^(0|[1-9][0-9]{0,20})$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const remoteSellerSchema = z.object({ grantId: id, devicePubkey: pubkey, harnessSlug: id }).strict();
export const fundingPartySchema = z.object({ principal: z.string().regex(/^gh:[0-9]+$/), credentialRef: id,
  hiveSlug: id, pubkeyBase64: pubkey }).strict();
export const sellerGrantSchema = z.object({ grantId: id, callerDevicePubkey: pubkey, sellerDevicePubkey: pubkey,
  harnessSlug: id, channelId: id, offerId: id, productId: id, skuRef: id,
  termsHash: z.string().regex(/^[a-f0-9]{64}$/), payerPrincipal: z.string().regex(/^gh:[0-9]+$/),
  payerPubkeyBase64: pubkey, seller: fundingPartySchema, maxMicrosPerTurn: integer,
  expiresAtMs: timestamp }).strict();
type RemoteSeller = z.infer<typeof remoteSellerSchema>;
type Grant = z.infer<typeof sellerGrantSchema>;
const receiptSchema = z.object({ channelId: id, usageNonce: id, meterQuantity: integer, amountMicros: integer,
  voucherDigest: z.string().regex(/^[a-f0-9]{64}$/), occurredAtMs: timestamp }).strict();
const voucherSchema = z.object({ channelId: id, payer: id, seller: id, releaseRef: id, usageNonce: id,
  meterQuantity: integer, pricePerUnitMicros: integer, priceVersion: id, splitManifestHash: id,
  expiresAtMs: timestamp, cumulativeClaimMicros: integer, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
const requestSchema = z.object({ requestId: z.string().uuid(), grantId: id, sellerDevicePubkey: pubkey, channelId: id, turnId: id,
  action: z.enum(['authority', 'sign', 'settle']), receipt: receiptSchema.optional(),
  identityInference: z.object({ billedInferenceMicros: integer, priorRemainderNumerator: integer }).strict().optional(),
  voucher: voucherSchema.optional(), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/).optional() }).strict();
type Request = z.infer<typeof requestSchema>;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const proofBytes = (request: Request) => Buffer.from(canonicalJson({ schema: 'papercusp.seller-rpc-response/v1', request }), 'utf8');
const receiptBytes = (r: z.infer<typeof receiptSchema>) => usageReceiptSigningBytes({ ...r,
  meterQuantity: BigInt(r.meterQuantity), amountMicros: BigInt(r.amountMicros) });
const voucherValue = (v: z.infer<typeof voucherSchema>): CumulativePaymentVoucher => ({ ...v,
  meterQuantity: BigInt(v.meterQuantity), pricePerUnitMicros: BigInt(v.pricePerUnitMicros), cumulativeClaimMicros: BigInt(v.cumulativeClaimMicros) });

export interface SellerReceiptRpcDeps {
  workspaceId: string;
  readKey?: typeof readIntegrationKey;
  localDevice?: typeof resolveDeviceEnvelopeSigner;
  revoked?: typeof loadRevokedPubkeys;
  readKeyStatus?: typeof loadHiveKeyStatus;
  sign?: typeof signWithHiveKey;
  readParty?: typeof readHostedToolEntitlements;
  readOffers?: typeof readHostedPerUseOffers;
  readUsage?: typeof readChannelUsage;
  readChannel?: typeof readHostedToolChannel;
  settle?: typeof settleMeteredUnit;
  nowMs?: () => number;
}

/** Always verifies independently of AUTHORITY_RPC_SIGNED and harness election. */
export function buildSellerReceiptRpcHandler(deps: SellerReceiptRpcDeps): AuthorityOpHandler {
  return async (payload, harness, context) => {
    const env = context?.envelope, nowMs = deps.nowMs ?? Date.now;
    if (!env || env.kind !== SELLER_RECEIPT_RPC_KIND || env.harnessSlug !== harness || env.payload !== payload ||
        !verifyAuthorityRpc(env, env.auth, { nowMs: nowMs() })) throw new Error('seller-rpc-unauthenticated');
    const request = requestSchema.parse(payload), readKey = deps.readKey ?? readIntegrationKey;
    const raw = await readKey(INSTALLED_TOOL_FUNDING_CONFIG);
    const config = z.object({ schema: z.literal('papercusp.installed-tool-funding/v1'),
      sellerGrants: z.array(sellerGrantSchema).max(1000) }).passthrough().parse(JSON.parse(raw ?? 'null'));
    const matches = config.sellerGrants.filter(g => g.grantId === request.grantId && g.harnessSlug === harness &&
      g.channelId === request.channelId && g.callerDevicePubkey === env.auth!.device_pubkey &&
      g.sellerDevicePubkey === request.sellerDevicePubkey);
    if (matches.length !== 1) throw new Error('seller-rpc-exact-grant-required');
    const grant: Grant = matches[0]!;
    const checkCurrent = async () => {
      if (grant.expiresAtMs <= nowMs() || await readKey(INSTALLED_TOOL_FUNDING_CONFIG) !== raw)
        throw new Error('seller-rpc-grant-withdrawn');
      const device = await (deps.localDevice ?? resolveDeviceEnvelopeSigner)();
      if (device?.devicePubkey !== grant.sellerDevicePubkey) throw new Error('seller-rpc-wrong-host');
      // The loader throws on unavailable storage. Money never inherits the
      // general coordination verifier's fail-open revocation policy.
      const revoked = await (deps.revoked ?? loadRevokedPubkeys)({ workspaceId: deps.workspaceId, harnessSlug: harness });
      if (revoked.has(grant.callerDevicePubkey) || revoked.has(grant.sellerDevicePubkey)) throw new Error('seller-rpc-revoked');
      const key = await (deps.readKeyStatus ?? loadHiveKeyStatus)(deps.workspaceId, grant.seller.hiveSlug);
      if (key.kind !== 'ok' || key.pubkeyBase64 !== grant.seller.pubkeyBase64) throw new Error('seller-rpc-key-mismatch');
    };
    await checkCurrent();
    const token = await readKey(grant.seller.credentialRef);
    if (!token?.trim()) throw new Error('seller-rpc-credential-required');
    const transport = { authToken: token, fetchImpl: ((url, init) => fetch(url,
      { ...init, signal: AbortSignal.timeout(10_000) })) as typeof fetch };
    const party = await (deps.readParty ?? readHostedToolEntitlements)(undefined, transport);
    const channel = await (deps.readChannel ?? readHostedToolChannel)(grant.channelId, grant.payerPrincipal, transport, grant.payerPubkeyBase64);
    const offers = await (deps.readOffers ?? readHostedPerUseOffers)(transport);
    const offerRows = offers.ok ? offers.offers.filter(o => o.offerId === grant.offerId) : [];
    const offer = offerRows[0];
    if (!channel.ok || !party.ok || party.payer !== grant.seller.principal || offerRows.length !== 1 || !offer ||
        !offer.active || !offer.productActive || offer.productId !== grant.productId || offer.skuRef !== grant.skuRef ||
        offer.creatorId !== grant.seller.principal || digest(offer.terms) !== grant.termsHash ||
        offer.receiptAuthority?.pubkeyBase64 !== grant.seller.pubkeyBase64 ||
        !verifySellerReceiptAuthority({ seller: offer.creatorId, offerId: offer.offerId, productId: offer.productId,
          skuRef: offer.skuRef }, offer.receiptAuthority)) throw new Error('seller-rpc-offer-authority-mismatch');
    const sign = async (bytes: Buffer) => {
      await checkCurrent();
      if (await readKey(grant.seller.credentialRef) !== token) throw new Error('seller-rpc-credential-changed');
      const signature = await (deps.sign ?? signWithHiveKey)(deps.workspaceId, grant.seller.hiveSlug, bytes);
      if (!verifyEd25519(bytes, grant.seller.pubkeyBase64, signature)) throw new Error('seller-rpc-key-changed');
      return signature.toString('base64');
    };
    if (request.action === 'authority') {
      if (request.receipt || request.voucher || request.signature || request.identityInference) throw new Error('seller-rpc-invalid-authority-request');
      return { ok: true, requestDigest: digest(request), authoritySignature: await sign(proofBytes(request)) };
    }
    const r = request.receipt;
    if (!r || r.occurredAtMs > nowMs()) throw new Error('seller-rpc-exact-receipt-required');
    const history = request.identityInference
      ? await (deps.readUsage ?? readChannelUsage)(grant.channelId, transport, grant.offerId)
      : await (deps.readUsage ?? readChannelUsage)(grant.channelId, transport);
    if (!history.ok || history.usage.channelId !== grant.channelId || !Array.isArray(history.usage.receipts))
      throw new Error('seller-rpc-reservation-unavailable');
    const rows = history.usage.receipts.filter(v => v.usageNonce === request.turnId);
    const reserved = rows[0];
    if (rows.length !== 1 || !reserved || reserved.offerId !== grant.offerId || reserved.releaseRef !== grant.skuRef ||
        reserved.payer !== grant.payerPrincipal || reserved.seller !== grant.seller.principal ||
        reserved.expiresAtMs > grant.expiresAtMs || r.occurredAtMs < reserved.reservedAtMs ||
        BigInt(reserved.reservedMicros) > BigInt(grant.maxMicrosPerTurn) ||
        reserved.unitPriceMicros !== String(offer.terms.unitPriceMicros) || reserved.priceVersion !== offer.terms.priceVersion ||
        reserved.splitManifestHash !== offer.terms.splitManifestHash || reserved.meterUnit !== offer.terms.meterUnit ||
        BigInt(r.meterQuantity) > BigInt(reserved.meterQuantity))
      throw new Error('seller-rpc-reservation-mismatch');
    let identityRemainder: string | undefined;
    if (request.identityInference) {
      const basis = request.identityInference, original = reserved.identityInference;
      if (!original || !integer.safeParse(original.ceilingMicros).success || request.voucher)
        throw new Error('seller-rpc-identity-reservation-required');
      const identityOffer = { skuRef: offer.skuRef, ...offer.terms, unitPriceMicros: Number(offer.terms.unitPriceMicros) };
      const q = quoteIdentityInferenceTurn({ offer: identityOffer,
        inferenceCeilingMicros: BigInt(original.ceilingMicros), billedInferenceMicros: BigInt(basis.billedInferenceMicros),
        priorRemainderNumerator: BigInt(basis.priorRemainderNumerator) });
      const origin = history.usage.identityMarkupOrigin;
      if (!q.ok || BigInt(r.meterQuantity) !== q.reservationQuantity || BigInt(reserved.meterQuantity) !== q.reservationQuantity ||
          BigInt(r.amountMicros) !== q.amountMicros || BigInt(reserved.reservedMicros) !== q.reservedMarkupMicros)
        throw new Error('seller-rpc-identity-quote-mismatch');
      identityRemainder = String(q.remainderNumerator);
      // A settled retry retains its recorded basis; the account origin has
      // already advanced to the NEXT remainder and cannot be reused here.
      if (reserved.state === 'settled') {
        if (original.billedInferenceMicros !== basis.billedInferenceMicros ||
            original.priorRemainderNumerator !== basis.priorRemainderNumerator ||
            original.remainderNumerator !== identityRemainder || reserved.amountMicros !== r.amountMicros ||
            reserved.meterQuantity !== r.meterQuantity || reserved.settledAtMs !== r.occurredAtMs)
          throw new Error('seller-rpc-identity-basis-changed');
      } else if (!origin || origin.offerId !== grant.offerId || origin.payer !== grant.payerPrincipal ||
          origin.seller !== grant.seller.principal || canonicalJson(origin.offer) !== canonicalJson(identityOffer) ||
          origin.remainderNumerator !== basis.priorRemainderNumerator)
        throw new Error('seller-rpc-identity-carry-mismatch');
    } else if (reserved.identityInference || reserved.meterUnit !== 'tool-call' ||
        BigInt(r.amountMicros) !== BigInt(r.meterQuantity) * BigInt(reserved.unitPriceMicros))
      throw new Error('seller-rpc-reservation-mismatch');
    if (request.voucher) {
      const v = voucherValue(request.voucher), { signature, ...unsigned } = v;
      if (request.action !== 'sign' || request.signature || r.channelId !== 'local-tool-turn:' + request.turnId ||
          v.channelId !== r.channelId || v.usageNonce !== r.usageNonce || v.payer !== grant.payerPrincipal ||
          v.seller !== grant.seller.principal || v.releaseRef !== grant.skuRef || v.expiresAtMs !== reserved.expiresAtMs ||
          v.meterQuantity !== BigInt(r.meterQuantity) || v.meterQuantity !== 1n ||
          v.pricePerUnitMicros !== BigInt(reserved.unitPriceMicros) || v.priceVersion !== reserved.priceVersion ||
          v.splitManifestHash !== reserved.splitManifestHash || v.cumulativeClaimMicros > BigInt(reserved.reservedMicros) ||
          paymentVoucherDigest(unsigned) !== r.voucherDigest ||
          !verifyEd25519(paymentVoucherSigningBytes(unsigned), grant.payerPubkeyBase64, Buffer.from(signature, 'base64')))
        throw new Error('seller-rpc-local-voucher-mismatch');
    } else if (r.channelId !== grant.channelId || r.usageNonce !== request.turnId || r.voucherDigest !== reserved.voucherDigest) {
      throw new Error('seller-rpc-original-reservation-required');
    }
    const bytes = receiptBytes(r);
    let signature: string;
    if (request.action === 'sign') {
      if (request.signature) throw new Error('seller-rpc-invalid-sign-request');
      signature = await sign(bytes);
    } else {
      if (!request.signature || !verifyEd25519(bytes, grant.seller.pubkeyBase64, Buffer.from(request.signature, 'base64')))
        throw new Error('seller-rpc-invalid-receipt-signature');
      signature = request.signature;
      await checkCurrent();
      if (await readKey(grant.seller.credentialRef) !== token) throw new Error('seller-rpc-credential-changed');
      await (deps.settle ?? settleMeteredUnit)({ channelId: grant.channelId, usageNonce: request.turnId,
        ...(request.identityInference ? { identityInference: {
          billedInferenceMicros: BigInt(request.identityInference.billedInferenceMicros),
          priorRemainderNumerator: BigInt(request.identityInference.priorRemainderNumerator) } } : { actualQuantity: BigInt(r.meterQuantity) }),
        occurredAtMs: r.occurredAtMs,
        signReceipt: candidate => { if (!candidate.equals(bytes)) throw new Error('seller-rpc-hosted-receipt-changed'); return signature; } }, transport);
      const confirmed = await (deps.readUsage ?? readChannelUsage)(grant.channelId, transport);
      const receipt = confirmed.ok && confirmed.usage.channelId === grant.channelId && Array.isArray(confirmed.usage.receipts)
        ? confirmed.usage.receipts.find(v => v.usageNonce === request.turnId) : undefined;
      if (!receipt || receipt.state !== 'settled' || receipt.receiptSignature !== signature ||
          receipt.voucherDigest !== r.voucherDigest || receipt.meterQuantity !== r.meterQuantity ||
          receipt.amountMicros !== r.amountMicros || receipt.settledAtMs !== r.occurredAtMs ||
          (request.identityInference && (!receipt.identityInference ||
            receipt.identityInference.ceilingMicros !== reserved.identityInference?.ceilingMicros ||
            receipt.identityInference.billedInferenceMicros !== request.identityInference.billedInferenceMicros ||
            receipt.identityInference.priorRemainderNumerator !== request.identityInference.priorRemainderNumerator ||
            receipt.identityInference.remainderNumerator !== identityRemainder)))
        throw new Error('seller-rpc-settlement-unconfirmed');
    }
    return { ok: true, signature, requestDigest: digest(request), authoritySignature: await sign(proofBytes(request)) };
  };
}

export function registerSellerReceiptRpc(): void {
  if (registeredAuthorityOpKinds().includes(SELLER_RECEIPT_RPC_KIND)) return;
  registerAuthorityOp(SELLER_RECEIPT_RPC_KIND, (payload, harness, context) =>
    buildSellerReceiptRpcHandler({ workspaceId: activeWorkspaceId() })(payload, harness, context), { authorityExempt: true });
}

/** Host-only capability; an unavailable remote peer propagates a refusal. */
export function remoteSellerReceiptCapability(remote: RemoteSeller, sellerPubkey: string, channelId: string,
  transport: PeerRpcTransport = getPeerRpcTransport()) {
  const call = async (request: Request) => {
    const result = await transport.rpc({ devicePubkey: remote.devicePubkey, githubUserId: 0, machineLabel: 'funded-seller' },
      { harnessSlug: remote.harnessSlug, kind: SELLER_RECEIPT_RPC_KIND, payload: request }) as
      { ok?: boolean; requestDigest?: string; authoritySignature?: string; signature?: string } | undefined;
    if (!result?.ok || result.requestDigest !== digest(request) || !result.authoritySignature ||
        !verifyEd25519(proofBytes(request), sellerPubkey, Buffer.from(result.authoritySignature, 'base64')))
      throw new Error('seller-rpc-response-unconfirmed');
    return result;
  };
  const base = (turnId: string) => ({ requestId: randomUUID(), grantId: remote.grantId, sellerDevicePubkey: remote.devicePubkey, channelId, turnId });
  return {
    verify: async () => { await call({ ...base('authority-check'), action: 'authority' }); },
    signReceipt: async (bytes: Buffer, context?: { turnId: string; voucher?: CumulativePaymentVoucher;
      identityInference?: { billedInferenceMicros: bigint; priorRemainderNumerator: bigint } }) => {
      if (!context) throw new Error('seller-rpc-original-turn-required');
      const receipt = receiptSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (!receiptBytes(receipt).equals(bytes)) throw new Error('seller-rpc-canonical-receipt-required');
      const v = context.voucher;
      const request: Request = { ...base(context.turnId), action: 'sign', receipt,
        ...(context.identityInference ? { identityInference: {
          billedInferenceMicros: String(context.identityInference.billedInferenceMicros),
          priorRemainderNumerator: String(context.identityInference.priorRemainderNumerator) } } : {}),
        ...(v ? { voucher: { ...v, meterQuantity: String(v.meterQuantity), pricePerUnitMicros: String(v.pricePerUnitMicros),
          cumulativeClaimMicros: String(v.cumulativeClaimMicros) } } : {}) };
      const result = await call(request);
      if (!result.signature || !verifyEd25519(bytes, sellerPubkey, Buffer.from(result.signature, 'base64')))
        throw new Error('seller-rpc-invalid-seller-signature');
      return result.signature;
    },
    settle: async (binding: FundedToolTurnBinding | FundedIdentityTurnBinding,
      outbox: NonNullable<FundedToolTurn['settlementOutbox']> | NonNullable<FundedIdentityTurn['settlementOutbox']>) => {
      const identity = 'receipt' in outbox;
      if (binding.channelId !== channelId || (!identity &&
          ('inferenceCeilingMicros' in binding || binding.offer.receiptAuthority?.pubkeyBase64 !== sellerPubkey)))
        throw new Error('seller-rpc-original-binding-required');
      const { signature, ...receipt } = identity ? outbox.receipt : outbox;
      await call({ ...base(receipt.usageNonce), action: 'settle', receipt, signature,
        ...(identity ? { identityInference: { billedInferenceMicros: outbox.billedInferenceMicros,
          priorRemainderNumerator: outbox.priorRemainderNumerator } } : {}) });
    },
  };
}
