import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { canonicalJson, signAuthorityRpc } from '../authority/authority-rpc-envelope';
import { handleAuthorityRpc } from '../authority/authority-op-registry';
import { HttpPeerRpcTransport } from '../authority/http-peer-rpc-transport';
import { PeerUnreachableError } from '../authority/peer-rpc-transport';
import { paymentVoucherDigest, paymentVoucherSigningBytes } from '../p2p/microcharge';
import { sellerReceiptAuthoritySigningBytes, usageReceiptSigningBytes, verifyUsageReceiptSignature } from '../p2p/metered-invocation';
import { buildSellerReceiptRpcHandler, remoteSellerReceiptCapability, SELLER_RECEIPT_RPC_KIND, INSTALLED_TOOL_FUNDING_CONFIG } from './seller-receipt-rpc';
import type { UsageReceiptWire, HostedPerUseOffer } from './metered-invocation-door-io';
import { FundedIdentityTurnHost, FundedToolTurnHost } from './funded-turn-host';
import type { FundedIdentityTurn, FundedIdentityTurnStore } from './funded-turn-store';
import { identityPerUseOfferTerms } from './identity-per-use-offer';
import type { FundedToolTurn, FundedToolTurnStore } from './funded-tool-turn-store';
import { createMicrochargeChannel } from '../p2p/microcharge';

function fixture() {
  const keys = { caller: generateKeyPairSync('ed25519'), device: generateKeyPairSync('ed25519'), payer: generateKeyPairSync('ed25519'), seller: generateKeyPairSync('ed25519') };
  const pub = (k: keyof typeof keys) => keys[k].publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
  const now = Date.now(), expires = now + 60000;
  const offer: HostedPerUseOffer = { offerId: 'offer', productId: 'product', skuRef: 'sku:paid@1', creatorId: 'gh:9', active: true,
    productActive: true, terms: { meterUnit: 'tool-call', unitPriceMicros: 250, priceVersion: 'v1', splitManifestHash: 'hash' },
    receiptAuthority: { pubkeyBase64: pub('seller'), proof: sign(null, sellerReceiptAuthoritySigningBytes({ seller: 'gh:9',
      offerId: 'offer', productId: 'product', skuRef: 'sku:paid@1', pubkeyBase64: pub('seller') }), keys.seller.privateKey).toString('base64') } };
  const grant = { grantId: 'grant', callerDevicePubkey: pub('caller'), sellerDevicePubkey: pub('device'), harnessSlug: 'papercusp',
    channelId: 'channel', offerId: offer.offerId, productId: offer.productId, skuRef: offer.skuRef, termsHash: hash(offer.terms),
    payerPrincipal: 'gh:7', payerPubkeyBase64: pub('payer'), seller: { principal: 'gh:9', credentialRef: 'seller-token',
      hiveSlug: 'seller', pubkeyBase64: pub('seller') }, maxMicrosPerTurn: '1000', expiresAtMs: expires };
  const reserved: UsageReceiptWire = { channelId: 'channel', usageNonce: 'turn', offerId: 'offer', payer: 'gh:7', seller: 'gh:9',
    releaseRef: offer.skuRef, meterUnit: 'tool-call', meterQuantity: '4', unitPriceMicros: '250', priceVersion: 'v1', splitManifestHash: 'hash',
    reservedMicros: '1000', amountMicros: null, cumulativeClaimMicros: '1000', expiresAtMs: expires,
    voucherDigest: 'a'.repeat(64), voucherSignature: 'reserved-voucher', receiptSignature: null, state: 'reserved', reservedAtMs: now - 1000, settledAtMs: null };
  const receipt = { channelId: 'channel', usageNonce: 'turn', meterQuantity: '1', amountMicros: '250', voucherDigest: reserved.voucherDigest, occurredAtMs: now };
  const bytes = usageReceiptSigningBytes({ ...receipt, meterQuantity: 1n, amountMicros: 250n });
  let grants = [grant];
  const deps = {
    workspaceId: 'seller-local-workspace', nowMs: () => now,
    readKey: vi.fn(async (key: string) => key === INSTALLED_TOOL_FUNDING_CONFIG
      ? JSON.stringify({ schema: 'papercusp.installed-tool-funding/v1', grants: [], sellerGrants: grants }) : key === 'seller-token' ? 'seller-secret' : undefined),
    localDevice: vi.fn(async () => ({ devicePubkey: pub('device'), sign: async (b: Buffer) => sign(null, b, keys.device.privateKey) })),
    revoked: vi.fn(async () => new Set<string>()),
    readKeyStatus: vi.fn(async () => ({ kind: 'ok' as const, pubkeyBase64: pub('seller') })),
    sign: vi.fn(async (_ws: string, _hive: string, b: Buffer) => sign(null, b, keys.seller.privateKey)),
    readParty: vi.fn(async () => ({ ok: true as const, payer: 'gh:9', productIds: [] })),
    readChannel: vi.fn(async () => ({ ok: true as const, channelId: 'channel', payer: 'gh:7', escrowMicros: 2000n, committedMicros: 0n })),
    readOffers: vi.fn(async () => ({ ok: true as const, offers: [offer] })),
    readUsage: vi.fn(async () => ({ ok: true as const, usage: { channelId: 'channel', escrowMicros: '2000', committedMicros: '0', receipts: [structuredClone(reserved)] } })),
    settle: vi.fn(async (input: Parameters<typeof import('./metered-invocation-door-io').settleMeteredUnit>[0]) => {
      const signature = await input.signReceipt(bytes);
      Object.assign(reserved, { state: 'settled', amountMicros: '250', meterQuantity: '1', settledAtMs: now, receiptSignature: signature });
      return { ok: true as const, amountMicros: 250n, receipt: structuredClone(reserved) };
    }),
  };
  const handler = buildSellerReceiptRpcHandler(deps);
  const request = { requestId: randomUUID(), grantId: 'grant', sellerDevicePubkey: pub('device'), channelId: 'channel', turnId: 'turn', action: 'sign' as const, receipt };
  const envelope = async (payload: unknown = request) => {
    const env = { harnessSlug: 'papercusp', kind: SELLER_RECEIPT_RPC_KIND, payload };
    return { ...env, auth: await signAuthorityRpc({ ...env, device_pubkey: pub('caller') }, async b => sign(null, b, keys.caller.privateKey), { nowMs: now }) };
  };
  const run = async (payload: unknown = request) => { const env = await envelope(payload); return handler(env.payload, env.harnessSlug, { envelope: env }); };
  return { keys, pub, grant, offer, reserved, receipt, bytes, now, deps, handler, request, envelope, run,
    changeGrants: (next: typeof grants) => { grants = next; } };
}

describe('seller-local monetary RPC', () => {
  it('signs only the exact reservation using the seller-local token and key', async () => {
    const f = fixture(), result = await f.run() as { signature: string };
    expect(verifyUsageReceiptSignature({ ...f.receipt, meterQuantity: 1n, amountMicros: 250n, signature: result.signature }, f.pub('seller'))).toBe(true);
    expect(f.deps.sign.mock.calls.every(([ws, hive]) => ws === 'seller-local-workspace' && hive === 'seller')).toBe(true);
    expect(f.deps.readParty).toHaveBeenCalledWith(undefined, expect.objectContaining({ authToken: 'seller-secret' }));
    expect(f.deps.readUsage).toHaveBeenCalledWith('channel', expect.objectContaining({ authToken: 'seller-secret' }));
    expect(JSON.stringify(result)).not.toContain('seller-secret');
  });

  it.each(['missing', 'tampered', 'stale'] as const)('rejects %s caller auth even with no general verifier', async scenario => {
    const f = fixture(), env = await f.envelope();
    if (scenario === 'missing') delete (env as { auth?: unknown }).auth;
    if (scenario === 'tampered') env.payload = { ...f.request, turnId: 'other' };
    if (scenario === 'stale') env.auth.ts -= 300000;
    const result = await handleAuthorityRpc(env, { handlers: { [SELLER_RECEIPT_RPC_KIND]: f.handler },
      authorityExemptKinds: new Set([SELLER_RECEIPT_RPC_KIND]), verifyIsAuthority: () => false });
    expect(result.ok).toBe(false); expect(f.deps.sign).not.toHaveBeenCalled(); expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it.each(['caller', 'target', 'channel', 'duplicate', 'expired', 'revoked', 'revocation-unavailable', 'host', 'key', 'credential', 'principal', 'offer', 'channel-key'] as const)(
    'refuses %s authority before signing', async scenario => {
      const f = fixture();
      if (scenario === 'caller') f.grant.callerDevicePubkey = f.pub('payer');
      if (scenario === 'target') f.grant.sellerDevicePubkey = f.pub('payer');
      if (scenario === 'channel') f.grant.channelId = 'other';
      if (scenario === 'duplicate') f.changeGrants([f.grant, f.grant]);
      if (scenario === 'expired') f.grant.expiresAtMs = f.now;
      if (scenario === 'revoked') f.deps.revoked.mockResolvedValue(new Set([f.pub('caller')]));
      if (scenario === 'revocation-unavailable') f.deps.revoked.mockRejectedValue(new Error('store unavailable'));
      if (scenario === 'host') f.deps.localDevice.mockResolvedValue({ devicePubkey: f.pub('payer'), sign: async () => Buffer.alloc(64) });
      if (scenario === 'key') f.deps.readKeyStatus.mockResolvedValue({ kind: 'ok', pubkeyBase64: f.pub('payer') });
      if (scenario === 'credential') f.deps.readKey.mockImplementation(async key => key === INSTALLED_TOOL_FUNDING_CONFIG
        ? JSON.stringify({ schema: 'papercusp.installed-tool-funding/v1', sellerGrants: [f.grant] }) : undefined);
      if (scenario === 'principal') f.deps.readParty.mockResolvedValue({ ok: true, payer: 'gh:7', productIds: [] });
      if (scenario === 'offer') Object.assign(f.offer, { creatorId: 'gh:7' });
      if (scenario === 'channel-key') f.deps.readChannel.mockRejectedValue(new Error('key mismatch'));
      await expect(f.run()).rejects.toThrow(); expect(f.deps.sign).not.toHaveBeenCalled(); expect(f.deps.settle).not.toHaveBeenCalled();
    });

  it.each(['cost', 'quantity', 'digest', 'nonce', 'future', 'pre-admission', 'budget', 'terms'] as const)('refuses changed %s receipt', async scenario => {
    const f = fixture();
    if (scenario === 'cost') f.receipt.amountMicros = '251';
    if (scenario === 'quantity') Object.assign(f.receipt, { meterQuantity: '5', amountMicros: '1250' });
    if (scenario === 'digest') f.receipt.voucherDigest = 'b'.repeat(64);
    if (scenario === 'nonce') f.receipt.usageNonce = 'other';
    if (scenario === 'future') f.receipt.occurredAtMs += 1;
    if (scenario === 'pre-admission') f.receipt.occurredAtMs -= 1001;
    if (scenario === 'budget') f.grant.maxMicrosPerTurn = '999';
    if (scenario === 'terms') Object.assign(f.reserved, { unitPriceMicros: '249' });
    await expect(f.run()).rejects.toThrow(); expect(f.deps.sign).not.toHaveBeenCalled();
  });

  it('requires the payer signature and exact local turn for subunit receipts', async () => {
    const f = fixture();
    const unsigned = { channelId: 'local-tool-turn:turn', usageNonce: 'call', payer: 'gh:7', seller: 'gh:9', releaseRef: f.offer.skuRef,
      meterQuantity: 1n, pricePerUnitMicros: 250n, priceVersion: 'v1', splitManifestHash: 'hash', expiresAtMs: f.grant.expiresAtMs, cumulativeClaimMicros: 250n };
    const voucher = { ...unsigned, signature: sign(null, paymentVoucherSigningBytes(unsigned), f.keys.payer.privateKey).toString('base64'),
      meterQuantity: '1', pricePerUnitMicros: '250', cumulativeClaimMicros: '250' };
    const request = { ...f.request, receipt: { ...f.receipt, channelId: unsigned.channelId, usageNonce: unsigned.usageNonce,
      voucherDigest: paymentVoucherDigest(unsigned) }, voucher };
    await expect(f.run(request)).resolves.toMatchObject({ ok: true });
    voucher.signature = sign(null, paymentVoucherSigningBytes(unsigned), f.keys.caller.privateKey).toString('base64');
    await expect(f.run(request)).rejects.toThrow('seller-rpc-local-voucher-mismatch');
  });

  it('rechecks withdrawn grants after hosted reads', async () => {
    const f = fixture();
    f.deps.readUsage.mockImplementation(async () => { f.changeGrants([]); return { ok: true, usage: {
      channelId: 'channel', escrowMicros: '2000', committedMicros: '0', receipts: [f.reserved] } }; });
    await expect(f.run()).rejects.toThrow('seller-rpc-grant-withdrawn'); expect(f.deps.sign).not.toHaveBeenCalled();
  });

  it('crosses real HTTP peer RPC, verifies seller responses and settles with seller credentials', async () => {
    const f = fixture();
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const env = JSON.parse(Buffer.concat(chunks).toString());
      const result = await handleAuthorityRpc(env, { handlers: { [SELLER_RECEIPT_RPC_KIND]: f.handler },
        authorityExemptKinds: new Set([SELLER_RECEIPT_RPC_KIND]), verifyIsAuthority: () => false });
      res.writeHead(result.ok ? 200 : 422, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing bound address');
    const transport = new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${address.port}`,
      envelopeSigner: { devicePubkey: f.pub('caller'), sign: async bytes => sign(null, bytes, f.keys.caller.privateKey) } });
    const remote = remoteSellerReceiptCapability({ grantId: 'grant', devicePubkey: f.pub('device'), harnessSlug: 'papercusp' }, f.pub('seller'), 'channel', transport);
    try {
      await remote.verify();
      const signature = await remote.signReceipt(f.bytes, { turnId: 'turn' });
      await remote.settle({ channelId: 'channel', offer: f.offer } as Parameters<typeof remote.settle>[0], { ...f.receipt, signature });
      expect(f.reserved.state).toBe('settled');
      expect(f.deps.settle).toHaveBeenCalledWith(expect.objectContaining({ usageNonce: 'turn', actualQuantity: 1n }), expect.objectContaining({ authToken: 'seller-secret' }));
      f.deps.revoked.mockResolvedValue(new Set([f.pub('caller')]));
      await expect(remote.verify()).rejects.toThrow();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('never falls back when the seller peer is unreachable or returns an unsigned response', async () => {
    const f = fixture(), rpc = vi.fn(async (): Promise<unknown> => { throw new PeerUnreachableError('offline'); });
    const remote = remoteSellerReceiptCapability({ grantId: 'grant', devicePubkey: f.pub('device'), harnessSlug: 'papercusp' }, f.pub('seller'), 'channel', { rpc });
    await expect(remote.signReceipt(f.bytes, { turnId: 'turn' })).rejects.toThrow('offline');
    rpc.mockImplementation(async () => ({ ok: true }));
    await expect(remote.verify()).rejects.toThrow('seller-rpc-response-unconfirmed');
    expect(f.deps.sign).not.toHaveBeenCalled(); expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it('refuses a replayed authority response for a fresh request', async () => {
    const f = fixture(); let saved: unknown;
    const rpc = vi.fn(async (_peer, request) => {
      if (saved) return saved;
      const env = await f.envelope(request.payload); saved = await f.handler(env.payload, env.harnessSlug, { envelope: env }); return saved;
    });
    const remote = remoteSellerReceiptCapability({ grantId: 'grant', devicePubkey: f.pub('device'), harnessSlug: 'papercusp' }, f.pub('seller'), 'channel', { rpc });
    await remote.verify(); await expect(remote.verify()).rejects.toThrow('seller-rpc-response-unconfirmed');
  });

  it.each([false, true])('keeps remote settlement uncertainty until independent payer readback (settled=%s)', async confirmed => {
    const f = fixture();
    const signature = sign(null, f.bytes, f.keys.seller.privateKey).toString('base64');
    const outbox = { ...f.receipt, signature };
    const turn = { turnId: 'turn', revision: 2, state: 'settlement-pending', binding: { channelId: 'channel', offer: f.offer }, settlementOutbox: outbox } as FundedToolTurn;
    const acknowledgeSettlement = vi.fn(async () => ({ ok: true as const, turn: { ...turn, state: 'settled' as const } }));
    const store = { read: vi.fn(async () => turn), acknowledgeSettlement } as unknown as FundedToolTurnStore;
    const payerFetch = vi.fn(async () => Response.json({ channelId: 'channel', receipts: [{ ...f.reserved,
      ...(confirmed ? { state: 'settled', amountMicros: '250', meterQuantity: '1', receiptSignature: signature, settledAtMs: f.now } : {}) }] }));
    const sellerFetch = vi.fn(async () => { throw new Error('buyer must not call seller doors'); });
    const settleRemote = vi.fn(async () => { throw new PeerUnreachableError('remote acknowledgement lost'); });
    const host = new FundedToolTurnHost({ store, payerTransport: { authToken: 'buyer', fetchImpl: payerFetch },
      sellerTransport: { fetchImpl: sellerFetch }, signVoucher: async () => 'unused', signReceipt: async () => 'unused', settleRemote });
    const result = await host.reconcileCompletion('ws', 'turn');
    expect(settleRemote).toHaveBeenCalledWith(turn.binding, outbox);
    expect(sellerFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(confirmed);
    expect(acknowledgeSettlement).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    if (!confirmed) expect(result).toMatchObject({ code: 'settlement-not-confirmed' });
  });

  it('carries the original turn and payer voucher to the remote subunit signer', async () => {
    const f = fixture();
    const turn = { turnId: 'turn', revision: 1, state: 'running', binding: { workspaceId: 'ws' }, meterState: {
      turnId: 'turn', payer: 'gh:7', seller: 'gh:9', releaseRef: f.offer.skuRef,
      meter: { meterUnit: 'tool-call', unitPriceMicros: 250n, priceVersion: 'v1', splitManifestHash: 'sha256:' + 'b'.repeat(64) },
      ceilingMicros: 1000n, expiresAtMs: f.grant.expiresAtMs, reservedMicros: 0n,
      channel: createMicrochargeChannel('local-tool-turn:turn', 1000n), units: {} } } as FundedToolTurn;
    const store = { persistMeter: vi.fn(async () => ({ ok: true as const, turn: { ...turn, revision: 2 } })) } as unknown as FundedToolTurnStore;
    const signReceipt = vi.fn(async () => 'seller-signature');
    const host = new FundedToolTurnHost({ store, payerTransport: {}, sellerTransport: {}, nowMs: () => f.now,
      signVoucher: async bytes => sign(null, bytes, f.keys.payer.privateKey).toString('base64'), signReceipt });
    const meter = host.localTurn(turn);
    await meter.invoke({ payer: 'gh:7', releaseRef: f.offer.skuRef, usageNonce: 'call', quantity: 1n }, async () => 'served');
    expect(signReceipt).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ turnId: 'turn',
      voucher: expect.objectContaining({ channelId: 'local-tool-turn:turn', usageNonce: 'call', payer: 'gh:7' }) }));
    expect(meter.snapshot().units.call!.receipt?.signature).toBe('seller-signature');
  });
});

function identityFixture() {
  const f = fixture();
  const priced = identityPerUseOfferTerms({ identity: { id: 'engineer', version: '1.0.0' }, markupBps: 2000 });
  if (!priced.ok) throw new Error(priced.detail);
  const { skuRef, ...terms } = priced.terms;
  Object.assign(f.offer, { skuRef, terms, receiptAuthority: { pubkeyBase64: f.pub('seller'),
    proof: sign(null, sellerReceiptAuthoritySigningBytes({ seller: 'gh:9', offerId: 'offer', productId: 'product',
      skuRef, pubkeyBase64: f.pub('seller') }), f.keys.seller.privateKey).toString('base64') } });
  Object.assign(f.grant, { skuRef, termsHash: createHash('sha256').update(canonicalJson(terms)).digest('hex') });
  Object.assign(f.reserved, { releaseRef: skuRef, ...terms, unitPriceMicros: String(terms.unitPriceMicros),
    meterQuantity: '2', reservedMicros: '400', identityInference: { ceilingMicros: '1001',
      billedInferenceMicros: null, priorRemainderNumerator: null, remainderNumerator: null } });
  // Independent integer oracle: one billed micro at 20% plus 8000/10000
  // carried numerator charges exactly ONE micro and leaves zero remainder.
  const basis = { billedInferenceMicros: '1', priorRemainderNumerator: '8000' };
  const receipt = { ...f.receipt, meterQuantity: '2', amountMicros: '1' };
  const bytes = usageReceiptSigningBytes({ ...receipt, meterQuantity: 2n, amountMicros: 1n });
  const origin = { offerId: 'offer', payer: 'gh:7', seller: 'gh:9', offer: priced.terms, remainderNumerator: '8000' };
  f.deps.readUsage.mockImplementation(async () => ({ ok: true, usage: { channelId: 'channel', escrowMicros: '2000',
    committedMicros: '0', receipts: [structuredClone(f.reserved)], identityMarkupOrigin: origin } }));
  f.deps.settle.mockImplementation(async input => {
    const signature = await input.signReceipt(bytes);
    Object.assign(f.reserved, { state: 'settled', amountMicros: '1', meterQuantity: '2', settledAtMs: f.now,
      receiptSignature: signature, identityInference: { ceilingMicros: '1001', ...basis, remainderNumerator: '0' } });
    origin.remainderNumerator = '0';
    return { ok: true, amountMicros: 1n, receipt: structuredClone(f.reserved) };
  });
  const request = { ...f.request, receipt, identityInference: basis };
  const rpc = vi.fn(async (_peer, call) => {
    const env = await f.envelope(call.payload);
    return f.handler(env.payload, env.harnessSlug, { envelope: env });
  });
  const remote = remoteSellerReceiptCapability({ grantId: 'grant', devicePubkey: f.pub('device'), harnessSlug: 'papercusp' },
    f.pub('seller'), 'channel', { rpc });
  return { ...f, basis, receipt, bytes, origin, request, remote, rpc };
}

describe('seller-local exact identity receipts', () => {
  it('signs and settles sub-block inference with the hosted carry, including a settled retry', async () => {
    const f = identityFixture();
    await f.remote.verify();
    const signature = await f.remote.signReceipt(f.bytes, { turnId: 'turn', identityInference: {
      billedInferenceMicros: 1n, priorRemainderNumerator: 8000n } });
    const outbox = { billedInferenceMicros: '1', priorRemainderNumerator: '8000', remainderNumerator: '0', samples: [],
      receipt: { ...f.receipt, signature } };
    const binding = { channelId: 'channel', offer: f.origin.offer, inferenceCeilingMicros: 1001n } as
      Parameters<typeof f.remote.settle>[0];
    await f.remote.settle(binding, outbox);
    await f.remote.settle(binding, outbox);
    expect(f.deps.settle).toHaveBeenCalledWith(expect.objectContaining({ identityInference: {
      billedInferenceMicros: 1n, priorRemainderNumerator: 8000n } }), expect.objectContaining({ authToken: 'seller-secret' }));
    expect(f.deps.settle.mock.calls[0]![0]).not.toHaveProperty('actualQuantity');
    expect(f.reserved).toMatchObject({ amountMicros: '1', meterQuantity: '2', identityInference: {
      billedInferenceMicros: '1', priorRemainderNumerator: '8000', remainderNumerator: '0' } });
    expect(f.deps.readUsage).toHaveBeenCalledWith('channel', expect.objectContaining({ authToken: 'seller-secret' }), 'offer');
  });

  it.each(['carry', 'origin', 'origin-terms', 'ceiling', 'basis', 'amount', 'quantity', 'tool-crossover', 'local-voucher', 'authority'] as const)(
    'refuses changed identity %s before a monetary signature', async scenario => {
      const f = identityFixture();
      if (scenario === 'carry') f.basis.priorRemainderNumerator = '7999';
      if (scenario === 'origin') f.origin.payer = 'gh:8';
      if (scenario === 'origin-terms') f.origin.offer = { ...f.origin.offer, unitPriceMicros: 199 };
      if (scenario === 'ceiling') Object.assign(f.reserved.identityInference!, { ceilingMicros: '0' });
      if (scenario === 'basis') f.basis.billedInferenceMicros = '1002';
      if (scenario === 'amount') f.receipt.amountMicros = '2';
      if (scenario === 'quantity') f.receipt.meterQuantity = '1';
      if (scenario === 'tool-crossover') delete (f.request as { identityInference?: unknown }).identityInference;
      const request = scenario === 'authority' ? { ...f.request, action: 'authority', receipt: undefined }
        : scenario === 'local-voucher' ? { ...f.request, voucher: { channelId: 'local-tool-turn:turn', usageNonce: 'call',
          payer: 'gh:7', seller: 'gh:9', releaseRef: f.offer.skuRef, meterQuantity: '1', pricePerUnitMicros: '200',
          priceVersion: 'v1', splitManifestHash: 'hash', expiresAtMs: f.grant.expiresAtMs, cumulativeClaimMicros: '1',
          signature: sign(null, f.bytes, f.keys.payer.privateKey).toString('base64') } } : f.request;
      await expect(f.run(request)).rejects.toThrow();
      expect(f.deps.sign).not.toHaveBeenCalled(); expect(f.deps.settle).not.toHaveBeenCalled();
    });

  it('refuses identity basis on an ordinary tool reservation', async () => {
    const f = fixture();
    await expect(f.run({ ...f.request, identityInference: { billedInferenceMicros: '1', priorRemainderNumerator: '0' } }))
      .rejects.toThrow('seller-rpc-identity-reservation-required');
    expect(f.deps.sign).not.toHaveBeenCalled();
  });

  it('does not acknowledge hosted settlement with changed inference basis', async () => {
    const f = identityFixture();
    const signature = sign(null, f.bytes, f.keys.seller.privateKey).toString('base64');
    f.deps.settle.mockImplementation(async () => {
      Object.assign(f.reserved, { state: 'settled', amountMicros: '1', meterQuantity: '2', settledAtMs: f.now,
        receiptSignature: signature, identityInference: { ceilingMicros: '1001', ...f.basis, remainderNumerator: '1' } });
      return { ok: true, amountMicros: 1n, receipt: f.reserved };
    });
    await expect(f.run({ ...f.request, action: 'settle', signature })).rejects.toThrow('seller-rpc-settlement-unconfirmed');
  });

  it.each([false, true])('retains remote identity uncertainty until payer readback (settled=%s)', async confirmed => {
    const f = identityFixture();
    const signature = sign(null, f.bytes, f.keys.seller.privateKey).toString('base64');
    const outbox = { billedInferenceMicros: '1', priorRemainderNumerator: '8000', remainderNumerator: '0', samples: [],
      receipt: { ...f.receipt, signature } };
    const turn: FundedIdentityTurn = { turnId: 'turn', accountId: 'account', revision: 2, state: 'settlement-pending',
      binding: { workspaceId: 'ws', ownerId: 'owner', principalId: 'system:superuser', nativeSessionId: 'session',
        nativeTurnId: 'native-turn', specificationRevision: 'spec', stateRevision: 'state', payer: 'gh:7', seller: 'gh:9',
        offerId: 'offer', channelId: 'channel', offer: f.origin.offer, inferenceCeilingMicros: 1001n,
        expiresAtMs: f.grant.expiresAtMs }, fundingReceipt: f.reserved, usageEventKeys: ['a'.repeat(64)],
      closedAtMs: f.now, settlementOutbox: outbox };
    const acknowledgeSettlement = vi.fn(async () => ({ ok: true as const, turn: { ...turn, state: 'settled' as const } }));
    const store = { read: vi.fn(async () => turn), acknowledgeSettlement } as unknown as FundedIdentityTurnStore;
    const payerFetch = vi.fn(async () => Response.json({ channelId: 'channel', receipts: [{ ...f.reserved,
      ...(confirmed ? { state: 'settled', amountMicros: '1', meterQuantity: '2', receiptSignature: signature, settledAtMs: f.now,
        identityInference: { ceilingMicros: '1001', ...f.basis, remainderNumerator: '0' } } : {}) }] }));
    const sellerFetch = vi.fn(async () => { throw new Error('buyer cannot use seller doors'); });
    const settleRemote = vi.fn(async () => { throw new PeerUnreachableError('remote acknowledgement lost'); });
    const host = new FundedIdentityTurnHost({ store, payerTransport: { authToken: 'buyer', fetchImpl: payerFetch },
      sellerTransport: { fetchImpl: sellerFetch }, signVoucher: async () => 'unused', signReceipt: async () => 'unused', settleRemote });
    expect((await host.settlePending('ws', 'turn')).ok).toBe(confirmed);
    expect(settleRemote).toHaveBeenCalledWith(turn.binding, outbox);
    expect(sellerFetch).not.toHaveBeenCalled();
    expect(acknowledgeSettlement).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  });
});
