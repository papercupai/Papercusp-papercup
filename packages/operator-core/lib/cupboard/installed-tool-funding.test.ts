import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { Sql } from 'postgres';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { InstalledPluginProvenance } from './types';
import type { AttachedInstalledToolFunding } from '../agent-tools/per-use-chokepoint';
import { INSTALLED_TOOL_FUNDING_CONFIG, productionInstalledToolFunding, productionFundedIdentityTurnHost } from './installed-tool-funding';
import { identityPerUseOfferTerms } from './identity-per-use-offer';
import { FundedIdentityTurnHost, type FundedIdentityTurnHostDeps } from './funded-turn-host';
import type { AppliedIdentityRules } from '../agent-identities/sync-hook-rules';
import type { FundedIdentityTurnBinding } from './funded-turn-store';
import type { HostedPerUseOffer } from './metered-invocation-door-io';
import type { FundedToolTurnBinding } from './funded-tool-turn-store';
import { sellerReceiptAuthoritySigningBytes } from '../p2p/metered-invocation';

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function fixture() {
  const session = { workspaceId: 'ws', ownerId: 'su-buyer', principalId: 'system:superuser' };
  const pairs = { payer: generateKeyPairSync('ed25519'), seller: generateKeyPairSync('ed25519') };
  const pubkey = (party: keyof typeof pairs) => pairs[party].publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const provenance = { schema: 'papercusp.plugin-installation/v1', name: 'paid', version: '1.0.0',
    listing: { skuRef: 'sku:paid@1.0.0', publisherId: 'gh:9', releaseVersion: '1.0.0' },
    contentFingerprint: 'sha256:' + 'a'.repeat(64), contentSource: 'r2', hadListing: true } as InstalledPluginProvenance;
  const offer: HostedPerUseOffer = { offerId: 'offer', productId: 'product', skuRef: provenance.listing.skuRef!,
    creatorId: 'gh:9', active: true, productActive: true, terms: { meterUnit: 'tool-call', unitPriceMicros: 250,
      priceVersion: 'price-v1', splitManifestHash: 'sha256:' + 'b'.repeat(64) },
    receiptAuthority: { pubkeyBase64: pubkey('seller'), proof: sign(null, sellerReceiptAuthoritySigningBytes({
      seller: 'gh:9', offerId: 'offer', productId: 'product', skuRef: provenance.listing.skuRef!,
      pubkeyBase64: pubkey('seller') }), pairs.seller.privateKey).toString('base64') } };
  const grant = { ...session, skuRef: offer.skuRef, offerId: offer.offerId, productId: offer.productId,
    provenanceHash: digest(provenance), termsHash: digest(offer.terms),
    payer: { principal: 'gh:7', credentialRef: 'buyer-token', hiveSlug: 'payer', pubkeyBase64: pubkey('payer') },
    seller: { principal: 'gh:9', credentialRef: 'seller-token', hiveSlug: 'seller', pubkeyBase64: pubkey('seller') },
    quantityPerTurn: 4, maxMicrosPerTurn: '1000', expiresAtMs: 5000 };
  const keys: Record<string, string> = { 'buyer-token': 'buyer-secret-fixture', 'seller-token': 'seller-secret-fixture' };
  const requests: Array<{ path: string; token: string }> = [];
  let channelKey = grant.payer.pubkeyBase64, channelOwner = 'gh:7', channelState = 'open', escrow = 1500, entitled = true, nowMs = 1000;
  const host: AttachedInstalledToolFunding['host'] = { admit: vi.fn(), localTurn: vi.fn(), complete: vi.fn() };
  const createHost = vi.fn((_deps: ConstructorParameters<typeof import('./funded-turn-host').FundedToolTurnHost>[0]) => host);
  const deps = { workspaceId: () => 'ws', nowMs: () => nowMs, sql: async () => ({} as Sql),
    readKey: vi.fn(async (key: string): Promise<string | undefined> => key === INSTALLED_TOOL_FUNDING_CONFIG
      ? JSON.stringify({ schema: 'papercusp.installed-tool-funding/v1', grants: [grant] }) : keys[key]),
    readFunding: vi.fn(async () => new Map([[offer.skuRef, { skuRef: offer.skuRef, channelId: 'channel',
      pricingState: null, pricingOfferId: null, pricingUnitMicros: null, pricingCheckedAtMs: null }]])),
    readKeyStatus: vi.fn(async (_workspace: string, hive: string) => ({ kind: 'ok' as const, pubkeyBase64: pubkey(hive as keyof typeof pairs) })),
    sign: async (_workspace: string, hive: string, bytes: Buffer) => sign(null, bytes, pairs[hive as keyof typeof pairs].privateKey),
    createHost };
  // Exercise the real hosted principal and channel readers, including their
  // identity/key checks. Neither reader receives an invocation-authored payer.
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, token = new Headers(init?.headers).get('authorization')!.slice(7);
    requests.push({ path, token });
    if (path === '/commerce/entitlements') {
      const buyer = token === keys['buyer-token'] ? 'gh:7' : 'gh:9';
      return Response.json({ buyer, entitlements: entitled && buyer === 'gh:7'
        ? [{ buyer_id: buyer, product_id: offer.productId, state: 'active', revoked_at_ms: null }] : [] });
    }
    if (path === '/commerce/offers') return Response.json({ offers: [{ ...offer, pricingModel: 'per-use', perUse: offer.terms }] });
    return Response.json({ channel: { channelId: 'channel', principalId: channelOwner, state: channelState,
      payerPubkeyBase64: channelKey, escrowMicros: escrow, committedMicros: 0 } });
  });
  // The production transport uses global fetch; restore it after each operation
  // so one case cannot silently donate credentials to another case.
  const run = async <T>(work: () => Promise<T>) => {
    const original = globalThis.fetch; globalThis.fetch = fetchImpl as typeof fetch;
    try { return await work(); } finally { globalThis.fetch = original; }
  };
  const input = { context: { workspaceId: 'ws', ownerId: 'su-buyer', nativeSessionId: 'native', ownerTurnId: 'turn' },
    installation: { name: 'paid', version: '1.0.0', path: '/installed/paid' }, provenance };
  const resolve = async () => {
    const funding = await productionInstalledToolFunding(session, deps);
    if (!funding) throw new Error('expected configured funding');
    const capability = await funding.resolveInstallation(input);
    return { funding, capability };
  };
  const binding: FundedToolTurnBinding = { kind: 'tool', ...session, executionId: 'native', admissionId: 'turn',
    payer: grant.payer.principal, seller: grant.seller.principal, channelId: 'channel',
    provenanceHash: grant.provenanceHash, offer: structuredClone(offer), quantityCeiling: 4n, expiresAtMs: grant.expiresAtMs };
  return { session, pairs, grant, keys, offer, input, binding, deps, requests, createHost, run, resolve,
    revokeEntitlement: () => { entitled = false; },
    changeClock: (value: number) => { nowMs = value; },
    changeChannel: (change: { key?: string; owner?: string; state?: string; escrow?: number }) => {
      channelKey = change.key ?? channelKey; channelOwner = change.owner ?? channelOwner;
      channelState = change.state ?? channelState; escrow = change.escrow ?? escrow;
    } };
}

describe('production identity funding supplier', () => {
  function identityFixture() {
    const f = fixture(), quoted = identityPerUseOfferTerms({ identity: { id: 'paid', version: '1.0.0' } });
    if (!quoted.ok) throw new Error('invalid identity fixture');
    const worn = { applied: { specificationRevision: 'spec', stateRevision: 'state' },
      packagePins: [{ packageKind: 'blueprint', ref: 'paid', revision: '1.0.0', contentHash: 'a'.repeat(64) }],
      pins: {}, sync: {}, declaredClassNeeds: null } as unknown as AppliedIdentityRules;
    Object.assign(f.offer, { skuRef: quoted.terms.skuRef, terms: quoted.terms });
    Object.assign(f.offer, { receiptAuthority: { pubkeyBase64: f.grant.seller.pubkeyBase64,
      proof: sign(null, sellerReceiptAuthoritySigningBytes({ seller: f.offer.creatorId, offerId: f.offer.offerId,
        productId: f.offer.productId, skuRef: f.offer.skuRef, pubkeyBase64: f.grant.seller.pubkeyBase64 }), f.pairs.seller.privateKey).toString('base64') } });
    f.grant.skuRef = f.offer.skuRef;
    f.grant.termsHash = digest(f.offer.terms);
    f.grant.provenanceHash = digest({ applied: worn.applied, packagePins: worn.packagePins });
    const binding: FundedIdentityTurnBinding = { ...f.session, nativeSessionId: 'native', nativeTurnId: null,
      admissionId: 'turn', specificationRevision: 'spec', stateRevision: 'state', payer: f.grant.payer.principal,
      seller: f.grant.seller.principal, channelId: 'channel', offerId: f.offer.offerId, offer: quoted.terms,
      inferenceCeilingMicros: 4000n, expiresAtMs: f.grant.expiresAtMs };
    const readApplied = vi.fn(async () => worn);
    const resolveLayers = vi.fn(async () => [{ layerRef: 'blueprint:paid', identity: quoted.identity, skuRef: quoted.terms.skuRef }]);
    const createIdentityHost = vi.fn((deps: FundedIdentityTurnHostDeps) => new FundedIdentityTurnHost(deps));
    const deps = { ...f.deps, readApplied, resolveLayers, createIdentityHost };
    return { ...f, worn, binding, readApplied, resolveLayers, createIdentityHost, deps,
      supplier: () => productionFundedIdentityTurnHost(binding, deps) };
  }

  it('uses seller RPC without loading seller secrets and preserves canonical billed usage', async () => {
    const f = identityFixture(), remote = { grantId: 'seller-grant', devicePubkey: f.grant.seller.pubkeyBase64, harnessSlug: 'papercusp' };
    const configured = { ...f.grant, seller: { ...f.grant.seller, remote } };
    const original = f.deps.readKey.getMockImplementation()!;
    f.deps.readKey.mockImplementation(async key => key === INSTALLED_TOOL_FUNDING_CONFIG
      ? JSON.stringify({ schema: 'papercusp.installed-tool-funding/v1', grants: [configured] }) : original(key));
    const capability = { verify: vi.fn(async () => {}), signReceipt: vi.fn(), settle: vi.fn() };
    const remoteSeller = vi.fn(() => capability);
    await f.run(async () => {
      expect(await productionFundedIdentityTurnHost(f.binding, { ...f.deps, remoteSeller })).toBeInstanceOf(FundedIdentityTurnHost);
      const hostDeps = f.createIdentityHost.mock.calls[0]![0];
      expect(hostDeps.signReceipt).toBe(capability.signReceipt);
      expect(hostDeps.settleRemote).toBe(capability.settle);
      expect(hostDeps.readUsage).toBeUndefined();
      expect(remoteSeller).toHaveBeenCalledWith(remote, f.grant.seller.pubkeyBase64, 'channel');
      expect(f.deps.readKey.mock.calls.some(([key]) => key === 'seller-token')).toBe(false);
      expect(f.deps.readKeyStatus.mock.calls.every(([, hive]) => hive === 'payer')).toBe(true);
      capability.verify.mockRejectedValueOnce(new Error('seller-rpc-revoked'));
      await expect(hostDeps.verifyCurrentAuthority!(f.binding)).rejects.toThrow('seller-rpc-revoked');
    });
  });

  it('pins an exact claimed work item and rechecks its owner before inference', async () => {
    const f = identityFixture();
    const ref = { id: 'WI-123', harness: 'papercusp' };
    const binding = { ...f.binding, workItem: ref };
    const item = { ...ref, assignee: binding.ownerId, state: 'wip' };
    const readWorkItem = vi.fn(async () => item);
    await f.run(async () => {
      await productionFundedIdentityTurnHost(binding, { ...f.deps, readWorkItem });
      expect(readWorkItem).toHaveBeenCalledExactlyOnceWith(ref);
      const verify = f.createIdentityHost.mock.calls[0]![0].verifyCurrentAuthority!;
      await expect(verify(binding)).resolves.toBeUndefined();
      item.assignee = 'another-owner';
      await expect(verify(binding)).rejects.toThrow('work-item-unclaimed-or-changed');
      item.assignee = binding.ownerId;
      item.state = 'done';
      await expect(verify(binding)).rejects.toThrow('work-item-unclaimed-or-changed');
      await expect(verify({ ...binding, workItem: { ...ref, id: 'WI-124' } }))
        .rejects.toThrow('authority-expired-or-changed');
    });
  });

  it.each([null, { id: 'WI-123', harness: 'other' }, { id: 'WI-124', harness: 'papercusp' },
    { id: 'WI-123', harness: 'papercusp', assignee: null, state: 'wip' },
    { id: 'WI-123', harness: 'papercusp', assignee: 'another-owner', state: 'wip' }])(
    'refuses unavailable, wrong-harness or foreign outcome attribution %j', async candidate => {
      const f = identityFixture(), ref = { id: 'WI-123', harness: 'papercusp' };
      const readWorkItem = vi.fn(async () => candidate === null ? null :
        { assignee: f.binding.ownerId, state: 'wip', ...candidate });
      await expect(productionFundedIdentityTurnHost({ ...f.binding, workItem: ref }, { ...f.deps, readWorkItem }))
        .rejects.toThrow('work-item-unclaimed-or-changed');
      expect(f.createIdentityHost).not.toHaveBeenCalled();
    });

  it.each([{ id: '', harness: 'papercusp' }, { id: 'WI-123', harness: '../other' },
    { id: 'WI-123', harness: 'papercusp', accepted: true }])('rejects malformed outcome binding %j before loading grants', async workItem => {
    const f = identityFixture();
    await expect(productionFundedIdentityTurnHost({ ...f.binding, workItem }, f.deps))
      .rejects.toThrow('work-item-invalid');
    expect(f.deps.readKey).not.toHaveBeenCalled();
    expect(f.createIdentityHost).not.toHaveBeenCalled();
  });

  it.each(['specificationRevision', 'stateRevision'] as const)('refuses a different APPLIED %s before creating a host', async field => {
    const f = identityFixture(); f.binding = { ...f.binding, [field]: 'other' };
    await f.run(async () => {
      await expect(productionFundedIdentityTurnHost(f.binding, f.deps)).rejects.toThrow('identity-funding-applied-mismatch');
      expect(f.createIdentityHost).not.toHaveBeenCalled();
    });
  });

  it.each([4001n, 5000n])('refuses inference ceiling %s above the grant pricing-block budget', async ceiling => {
    const f = identityFixture();
    await expect(productionFundedIdentityTurnHost({ ...f.binding, inferenceCeilingMicros: ceiling }, f.deps)).rejects.toThrow('identity-funding-budget-exceeded');
    expect(f.createIdentityHost).not.toHaveBeenCalled();
  });

  it('refuses changed APPLIED pins, entitlement, credentials and channel after composition', async () => {
    const f = identityFixture();
    await f.run(async () => {
      await f.supplier();
      const verify = f.createIdentityHost.mock.calls[0]![0].verifyCurrentAuthority!;
      await expect(verify(f.binding)).resolves.toBeUndefined();
      f.readApplied.mockResolvedValueOnce({ ...f.worn, packagePins: [...f.worn.packagePins,
        { packageKind: 'blueprint', ref: 'other', revision: '1', contentHash: 'b'.repeat(64) }] });
      await expect(verify(f.binding)).rejects.toThrow('identity-funding-applied-withdrawn');
      f.keys['buyer-token'] = 'changed';
      await expect(verify(f.binding)).rejects.toThrow('identity-funding-credential-changed');
      f.keys['buyer-token'] = 'buyer-secret-fixture'; f.changeChannel({ state: 'closed' });
      await expect(verify(f.binding)).rejects.toThrow('identity-funding-channel-withdrawn');
      f.changeChannel({ state: 'open' }); f.revokeEntitlement();
      await expect(verify(f.binding)).rejects.toThrow('identity-funding-entitlement-withdrawn');
    });
  });

  it('rejects withdrawn authority before preparing a monetary turn', async () => {
    const f = identityFixture();
    await f.run(async () => {
      const host = await f.supplier(); f.revokeEntitlement();
      expect(await host!.admit(f.binding)).toMatchObject({ ok: false, code: 'identity-authority-unavailable' });
    });
  });

  it('refuses withdrawn published offer and signing key, and modified bindings', async () => {
    const f = identityFixture();
    await f.run(async () => {
      await f.supplier();
      const verify = f.createIdentityHost.mock.calls[0]![0].verifyCurrentAuthority!;
      await expect(verify({ ...f.binding, inferenceCeilingMicros: 1n })).rejects.toThrow('authority-expired-or-changed');
      f.deps.readKeyStatus.mockResolvedValueOnce({ kind: 'ok', pubkeyBase64: f.grant.seller.pubkeyBase64 });
      await expect(verify(f.binding)).rejects.toThrow('identity-funding-signing-key-changed');
      Object.assign(f.offer, { active: false });
      await expect(verify(f.binding)).rejects.toThrow('identity-funding-offer-withdrawn');
    });
  });

  it('enforces markup budget and requires a unique exact grant', async () => {
    const f = identityFixture(); f.grant.maxMicrosPerTurn = '799';
    await expect(f.supplier()).rejects.toThrow('identity-funding-budget-exceeded');
    f.grant.maxMicrosPerTurn = '1000';
    f.deps.readKey.mockResolvedValue(JSON.stringify({ schema: 'papercusp.installed-tool-funding/v1', grants: [f.grant, f.grant] }));
    await expect(f.supplier()).rejects.toThrow('identity-funding-exact-grant-required');
    expect(f.createIdentityHost).not.toHaveBeenCalled();
  });
});

describe('production installed funding with independent seller credentials', () => {
  it('uses the exact remote seller capability without reading seller secrets or local seller keys', async () => {
    const f = fixture();
    const remote = { grantId: 'seller-grant', devicePubkey: f.grant.seller.pubkeyBase64, harnessSlug: 'papercusp' };
    const configured = { ...f.grant, seller: { ...f.grant.seller, remote } };
    const originalRead = f.deps.readKey.getMockImplementation()!;
    f.deps.readKey.mockImplementation(async key => key === INSTALLED_TOOL_FUNDING_CONFIG
      ? JSON.stringify({ schema: 'papercusp.installed-tool-funding/v1', grants: [configured] }) : originalRead(key));
    const capability = { verify: vi.fn(async () => {}), signReceipt: vi.fn(async () => 'remote-signature'), settle: vi.fn(async () => {}) };
    const remoteSeller = vi.fn(() => capability);
    await f.run(async () => {
      const funding = await productionInstalledToolFunding(f.session, { ...f.deps, remoteSeller });
      const installation = await funding!.resolveInstallation(f.input);
      await installation.resolveFunding(f.offer);
      await installation.verifyCurrentAuthority!(f.binding);
      expect(remoteSeller).toHaveBeenCalledWith(remote, f.grant.seller.pubkeyBase64, 'channel');
      expect(capability.verify).toHaveBeenCalledTimes(2);
      expect(f.deps.readKey.mock.calls.some(([key]) => key === 'seller-token')).toBe(false);
      expect(f.deps.readKeyStatus.mock.calls.every(([, hive]) => hive === 'payer')).toBe(true);
      expect(f.createHost.mock.calls[0]![0].signReceipt).toBe(capability.signReceipt);
      expect(f.createHost.mock.calls[0]![0].settleRemote).toBe(capability.settle);
      expect(f.requests.every(row => row.token === 'buyer-secret-fixture')).toBe(true);
      capability.verify.mockRejectedValueOnce(new Error('seller-rpc-revoked'));
      await expect(installation.verifyCurrentAuthority!(f.binding)).rejects.toThrow('seller-rpc-revoked');
    });
  });

  it('refreshes the original grant and hosted authority without reserving another hold', async () => {
    const f = fixture();
    await f.run(async () => {
      const { capability } = await f.resolve();
      await capability.resolveFunding(f.offer);
      await expect(capability.verifyCurrentAuthority!(f.binding)).resolves.toBeUndefined();
      expect(f.createHost).toHaveBeenCalledOnce();
      expect(f.requests.slice(-4).map(row => row.token)).toEqual([
        'buyer-secret-fixture', 'seller-secret-fixture', 'buyer-secret-fixture', 'buyer-secret-fixture']);
    });
  });

  it.each(['grant', 'grant-changed', 'expiry', 'credential', 'key', 'entitlement', 'seller-login', 'offer', 'channel', 'unavailable'] as const)(
    'refuses current %s revocation after original funding was accepted', async scenario => {
      const f = fixture();
      await f.run(async () => {
        const { capability } = await f.resolve(); await capability.resolveFunding(f.offer);
        if (scenario === 'grant') f.deps.readKey.mockResolvedValue(undefined);
        if (scenario === 'grant-changed') f.grant.maxMicrosPerTurn = '999';
        if (scenario === 'expiry') f.changeClock(5000);
        if (scenario === 'credential') f.keys['seller-token'] = 'rotated-secret';
        if (scenario === 'key') f.deps.readKeyStatus.mockResolvedValue({ kind: 'ok', pubkeyBase64: f.grant.payer.pubkeyBase64 });
        if (scenario === 'entitlement') f.revokeEntitlement();
        if (scenario === 'seller-login') {
          const original = globalThis.fetch;
          globalThis.fetch = (async (url, init) => new Headers(init?.headers).get('authorization') === 'Bearer seller-secret-fixture'
            ? Response.json({ buyer: 'gh:99', entitlements: [] }) : original(url, init)) as typeof fetch;
        }
        if (scenario === 'offer') Object.assign(f.offer, { active: false });
        if (scenario === 'channel') f.changeChannel({ state: 'closing' });
        if (scenario === 'unavailable') globalThis.fetch = vi.fn(async () => { throw new Error('network unavailable'); });
        await expect(capability.verifyCurrentAuthority!(f.binding)).rejects.toThrow();
        expect(f.createHost).toHaveBeenCalledOnce();
      });
    });

  it('provisions distinct hosted principals, signing keys and an exact budgeted channel route', async () => {
    const f = fixture();
    await f.run(async () => {
      const { capability } = await f.resolve();
      expect(await capability.resolvePayer!()).toBe('gh:7');
      expect(await capability.resolveFunding(f.offer)).toEqual({ channelId: 'channel', quantityCeiling: 4n, expiresAtMs: 5000 });
      expect(f.requests.map(row => row.token)).toEqual(['buyer-secret-fixture', 'seller-secret-fixture', 'buyer-secret-fixture']);
      const bound = f.createHost.mock.calls[0]![0];
      expect(bound.payerTransport.authToken).toBe(f.keys['buyer-token']);
      expect(bound.sellerTransport.authToken).toBe(f.keys['seller-token']);
      const bytes = Buffer.from('exact canonical signing challenge');
      expect(await bound.signVoucher(bytes)).not.toEqual(await bound.signReceipt(bytes));
    });
  });

  it('missing configuration grants no funding and reads no credentials', async () => {
    const readKey = vi.fn(async () => undefined);
    expect(await productionInstalledToolFunding(fixture().session, { workspaceId: () => 'ws', readKey })).toBeUndefined();
    expect(readKey).toHaveBeenCalledExactlyOnceWith(INSTALLED_TOOL_FUNDING_CONFIG);
  });

  it.each(['workspaceId', 'ownerId', 'principalId', 'provenanceHash'] as const)('refuses a grant with another %s', async field => {
    const f = fixture(); f.grant[field] = field === 'provenanceHash' ? 'f'.repeat(64) : 'other';
    await f.run(() => expect(f.resolve()).rejects.toThrow('exact-grant-required'));
    expect(f.requests).toHaveLength(0); expect(f.createHost).not.toHaveBeenCalled();
  });

  it.each(['credentialRef', 'pubkeyBase64', 'principal'] as const)('refuses the buyer as seller through the same %s', async field => {
    const f = fixture(); f.grant.seller[field] = f.grant.payer[field];
    await f.run(() => expect(f.resolve()).rejects.toThrow('independent-seller-required'));
    expect(f.requests).toHaveLength(0);
  });

  it('refuses missing or aliased seller tokens instead of falling back to the buyer', async () => {
    const f = fixture(); delete f.keys['seller-token'];
    await f.run(() => expect(f.resolve()).rejects.toThrow('independent-credentials-required'));
    f.keys['seller-token'] = f.keys['buyer-token']!;
    await f.run(() => expect(f.resolve()).rejects.toThrow('independent-credentials-required'));
  });

  it('refuses an independently stored token that authenticates as a different seller', async () => {
    const f = fixture(); f.grant.seller.principal = 'gh:10';
    await f.run(() => expect(f.resolve()).rejects.toThrow('credential-principal-mismatch'));
  });

  it('refuses a signer key that differs from the authorized seller key', async () => {
    const f = fixture(); f.grant.seller.pubkeyBase64 = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    await f.run(() => expect(f.resolve()).rejects.toThrow('signing-key-mismatch'));
  });

  it.each([{ key: 'wrong-key' }, { owner: 'gh:8' }, { state: 'closed' }, { escrow: 999 }])('refuses stale or insufficient hosted channel state %j', async change => {
    const f = fixture(); f.changeChannel(change);
    await f.run(async () => {
      const { capability } = await f.resolve();
      await expect(capability.resolveFunding(f.offer)).rejects.toThrow('channel-unavailable');
    });
    expect(f.createHost).not.toHaveBeenCalled();
  });

  it('refuses changed published price terms even while the channel can cover them', async () => {
    const f = fixture();
    await f.run(async () => {
      const { capability } = await f.resolve();
      await expect(capability.resolveFunding({ ...f.offer, terms: { ...f.offer.terms, priceVersion: 'new' } })).rejects.toThrow('offer-grant-mismatch');
    });
    expect(f.deps.readFunding).not.toHaveBeenCalled();
  });

  it.each(['missing', 'another-key', 'forged-proof', 'another-offer'] as const)(
    'refuses %s seller receipt authority before reading the funding route or creating a host', async scenario => {
      const f = fixture();
      let receiptAuthority = f.offer.receiptAuthority;
      if (scenario === 'missing') receiptAuthority = undefined;
      if (scenario === 'another-key') {
        const pair = generateKeyPairSync('ed25519');
        const pubkeyBase64 = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
        receiptAuthority = { pubkeyBase64, proof: sign(null, sellerReceiptAuthoritySigningBytes({
          seller: f.offer.creatorId, offerId: f.offer.offerId, productId: f.offer.productId,
          skuRef: f.offer.skuRef, pubkeyBase64 }), pair.privateKey).toString('base64') };
      }
      if (scenario === 'forged-proof') receiptAuthority = { ...receiptAuthority!, proof: 'nonempty' };
      if (scenario === 'another-offer') receiptAuthority = { ...receiptAuthority!, proof: sign(null,
        sellerReceiptAuthoritySigningBytes({ seller: f.offer.creatorId, offerId: 'other',
          productId: f.offer.productId, skuRef: f.offer.skuRef, pubkeyBase64: receiptAuthority!.pubkeyBase64 }),
        f.pairs.seller.privateKey).toString('base64') };
      await f.run(async () => {
        const { capability } = await f.resolve();
        await expect(capability.resolveFunding({ ...f.offer, receiptAuthority })).rejects.toThrow('offer-grant-mismatch');
      });
      expect(f.deps.readFunding).not.toHaveBeenCalled();
      expect(f.createHost).not.toHaveBeenCalled();
    });

  it('does not turn a stored channel or expired grant into spend authority', async () => {
    const f = fixture(); f.grant.maxMicrosPerTurn = '999';
    await f.run(async () => {
      const { capability } = await f.resolve();
      await expect(capability.resolveFunding(f.offer)).rejects.toThrow('budget-exceeded');
    });
    f.grant.expiresAtMs = 1000;
    await f.run(() => expect(f.resolve()).rejects.toThrow('grant-expired'));
  });
});
