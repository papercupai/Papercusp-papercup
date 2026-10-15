import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Hono } from 'hono';
import { sellerReceiptAuthoritySigningBytes, usageReceiptSigningBytes } from '@papercusp/operator-core/lib/p2p/metered-invocation';
import { paymentVoucherDigest, paymentVoucherSigningBytes } from '@papercusp/operator-core/lib/p2p/microcharge';
import { commerceRoute } from '../routes/commerce';
import { meteredUsageRoute } from '../routes/metered-usage';
import { getUsageReceipt, loadMicrochargeChannel } from '../usage-receipt-store';
import { getPaymentChannel } from '../payment-channel-store';
import { makeSqliteDb } from './sqlite-d1';
import { makeEnv } from './fake-d1';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async original => ({ ...await original<typeof import('../auth.ts')>(), resolveGithubBearer: auth.resolveGithubBearer }));
const key = () => {
  const k = generateKeyPairSync('ed25519');
  return { pubkeyBase64: k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    sign: (bytes: Buffer) => sign(null, bytes, k.privateKey).toString('base64') };
};
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { Authorization: 'Bearer test',
  'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function harness() {
  const { db, raw } = makeSqliteDb(), { env } = makeEnv(); env.DB = db;
  const api = new Hono().route('/', commerceRoute()).route('/', meteredUsageRoute());
  const seller = key(), payer = key(), now = Date.now() - 1000;
  const binding = { seller: 'gh:9', offerId: 'o1', productId: 'p1', skuRef: 'sku:tool@1', pubkeyBase64: seller.pubkeyBase64 };
  const authority = { pubkeyBase64: seller.pubkeyBase64, proof: seller.sign(sellerReceiptAuthoritySigningBytes(binding)) };
  const publication = { productId: 'p1', offerId: 'o1', skuRef: binding.skuRef, title: 'Tool', pricingModel: 'per-use',
    price: { amountMinor: 0, currency: 'USD' }, perUse: { unitPriceMicros: 250, meterUnit: 'tool-call',
      priceVersion: 'v1', splitManifestHash: 'sha256:' + 'a'.repeat(64) }, receiptAuthority: authority };
  raw.prepare(`INSERT INTO payment_channels (channel_id,principal_id,rail,chain_id,stablecoin_address,
    settlement_contract_address,funding_source,funding_ref,wallet_address,escrow_micros,state,created_at_ms,updated_at_ms,payer_pubkey_base64)
    VALUES ('c1','gh:7','evm-x402',84532,'coin','contract','bound-wallet','fund','wallet',10000,'open',?,?,?)`)
    .run(now, now, payer.pubkeyBase64);
  const voucher = { channelId: 'c1', payer: 'gh:7', seller: 'gh:9', releaseRef: binding.skuRef, usageNonce: 'n1',
    meterQuantity: 2n, pricePerUnitMicros: 250n, priceVersion: 'v1', splitManifestHash: publication.perUse.splitManifestHash,
    expiresAtMs: now + 100000, cumulativeClaimMicros: 500n };
  const reserve = { channelId: 'c1', offerId: 'o1', voucher: { ...voucher, meterQuantity: '2', pricePerUnitMicros: '250',
    cumulativeClaimMicros: '500', signature: payer.sign(paymentVoucherSigningBytes(voucher)) } };
  const receipt = { channelId: 'c1', usageNonce: 'n1', meterQuantity: 1n, amountMicros: 250n,
    occurredAtMs: Date.now(), voucherDigest: paymentVoucherDigest(voucher) };
  const settle = { channelId: 'c1', actualQuantity: '1', occurredAtMs: receipt.occurredAtMs,
    receiptSignature: seller.sign(usageReceiptSigningBytes(receipt)) };
  const request = (path: string, body: unknown) => api.request(path, post(body), env);
  const admitted = async () => {
    auth.resolveGithubBearer.mockResolvedValue({ id: 9 }); expect((await request('/commerce/offers', publication)).status).toBe(201);
    auth.resolveGithubBearer.mockResolvedValue({ id: 7 }); expect((await request('/commerce/metered-invocations', reserve)).status).toBe(201);
    auth.resolveGithubBearer.mockResolvedValue({ id: 9 });
    receipt.occurredAtMs = Date.now() + 2;
    // Settlement happens after admission. Advancing fake time retains the
    // exact signed timestamp while keeping it inside the handler's time range.
    vi.spyOn(Date, 'now').mockReturnValue(receipt.occurredAtMs + 5);
    settle.occurredAtMs = receipt.occurredAtMs;
    settle.receiptSignature = seller.sign(usageReceiptSigningBytes(receipt));
  };
  return { db, raw, seller, payer, publication, reserve, settle, receipt, binding, request, admitted };
}
describe('publisher-bound seller receipt authority on migrated D1', () => {
  beforeEach(() => { vi.restoreAllMocks(); auth.resolveGithubBearer.mockResolvedValue({ id: 9 }); });
  afterEach(() => vi.restoreAllMocks());
  it('publishes with possession proof, pins the key and replays exact signed closure without a second charge', async () => {
    const h = harness(); await h.admitted();
    expect(await getUsageReceipt(h.db, 'c1', 'n1')).toMatchObject({ sellerPubkeyBase64: h.seller.pubkeyBase64 });
    for (let i = 0; i < 2; i++) expect((await h.request('/commerce/metered-invocations/n1/settle', h.settle)).status).toBe(200);
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels').get()).toMatchObject({ committed_micros: 250 });
    expect(() => h.raw.prepare('UPDATE usage_receipts SET seller_pubkey_base64=?').run(h.payer.pubkeyBase64)).toThrow('reservation seller authority is immutable');
  });
  it.each(['forged', 'payer-key', 'other-key', 'quantity', 'time', 'nonce', 'digest'])('refuses %s without releasing the original hold', async scenario => {
    const h = harness(); await h.admitted();
    let body = { ...h.settle };
    if (scenario === 'forged') body.receiptSignature = 'nonempty';
    if (scenario === 'payer-key') body.receiptSignature = h.payer.sign(usageReceiptSigningBytes(h.receipt));
    if (scenario === 'other-key') body.receiptSignature = key().sign(usageReceiptSigningBytes(h.receipt));
    if (scenario === 'quantity') body.actualQuantity = '0';
    if (scenario === 'time') body.occurredAtMs -= 1;
    if (scenario === 'nonce' || scenario === 'digest') body.receiptSignature = h.seller.sign(usageReceiptSigningBytes({ ...h.receipt,
      ...(scenario === 'nonce' ? { usageNonce: 'other' } : { voucherDigest: 'b'.repeat(64) }) }));
    expect((await h.request('/commerce/metered-invocations/n1/settle', { ...body, sellerPubkeyBase64: h.payer.pubkeyBase64, verifySignature: true })).status).toBe(422);
    expect(await getUsageReceipt(h.db, 'c1', 'n1')).toMatchObject({ state: 'reserved', amountMicros: null });
    const channel = await getPaymentChannel(h.db, 'c1'); if (!channel) throw new Error('missing channel');
    expect((await loadMicrochargeChannel(h.db, channel)).reservations).toEqual({ n1: 500n });
    expect(channel.committedMicros).toBe(0);
  });
  it('rejects keys signed for another publisher or offer and malformed authority before publishing', async () => {
    const h = harness();
    for (const authority of [null, {}, { pubkeyBase64: 5, proof: true }, { ...h.publication.receiptAuthority, proof: 'fake' },
      { pubkeyBase64: h.seller.pubkeyBase64, proof: h.seller.sign(sellerReceiptAuthoritySigningBytes({ ...h.binding, offerId: 'other' })) }]) {
      expect((await h.request('/commerce/offers', { ...h.publication, receiptAuthority: authority })).status).toBe(422);
    }
    auth.resolveGithubBearer.mockResolvedValue({ id: 7 });
    expect((await h.request('/commerce/offers', h.publication)).status).toBe(422);
    expect(h.raw.prepare('SELECT COUNT(*) n FROM commerce_ledger_events').get()).toMatchObject({ n: 0 });
  });
  it('refuses replacing/removing a registered key and survives ledger projection rebuilds', async () => {
    const h = harness(); await h.admitted();
    const other = key(), replacement = { pubkeyBase64: other.pubkeyBase64,
      proof: other.sign(sellerReceiptAuthoritySigningBytes({ ...h.binding, pubkeyBase64: other.pubkeyBase64 })) };
    expect((await h.request('/commerce/offers', { ...h.publication, receiptAuthority: replacement })).status).toBe(422);
    expect((await h.request('/commerce/offers', { ...h.publication, receiptAuthority: undefined })).status).toBe(422);
    expect((await h.request('/commerce/offers', h.publication)).status).toBe(200);
    expect(h.raw.prepare('SELECT COUNT(*) n FROM commerce_ledger_events').get()).toMatchObject({ n: 2 });
    expect(() => h.raw.prepare('UPDATE commerce_offers SET seller_pubkey_base64=?').run(other.pubkeyBase64)).toThrow('offer seller authority is immutable');
    // Offer retirement does not change the authority of an admitted receipt.
    expect((await h.request('/commerce/offers', { ...h.publication, active: false })).status).toBe(201);
    expect((await h.request('/commerce/metered-invocations/n1/settle', h.settle)).status).toBe(200);
  });
  it('refuses reserving an unbound legacy offer and settling an unbound historical reservation', async () => {
    const h = harness(); expect((await h.request('/commerce/offers', { ...h.publication, receiptAuthority: undefined })).status).toBe(201);
    auth.resolveGithubBearer.mockResolvedValue({ id: 7 });
    expect((await h.request('/commerce/metered-invocations', h.reserve)).status).toBe(422);
    expect(await getUsageReceipt(h.db, 'c1', 'n1')).toBeNull();
    // A pre-migration row has no trusted key. Neither a current offer key nor
    // a request-body key may retrofit authority onto that held reservation.
    auth.resolveGithubBearer.mockResolvedValue({ id: 9 });
    expect((await h.request('/commerce/offers', h.publication)).status).toBe(201);
    auth.resolveGithubBearer.mockResolvedValue({ id: 7 });
    expect((await h.request('/commerce/metered-invocations', h.reserve)).status).toBe(201);
    h.raw.exec('DROP TRIGGER usage_receipt_seller_key_immutable');
    h.raw.prepare('UPDATE usage_receipts SET seller_pubkey_base64=NULL').run();
    auth.resolveGithubBearer.mockResolvedValue({ id: 9 });
    h.settle.occurredAtMs = Date.now();
    h.settle.receiptSignature = h.seller.sign(usageReceiptSigningBytes({ ...h.receipt, occurredAtMs: h.settle.occurredAtMs }));
    expect((await h.request('/commerce/metered-invocations/n1/settle', h.settle)).status).toBe(422);
    expect(await getUsageReceipt(h.db, 'c1', 'n1')).toMatchObject({ state: 'reserved' });
  });
});
