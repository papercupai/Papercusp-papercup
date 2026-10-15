import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

const io = vi.hoisted(() => ({
  postCommerceOffer: vi.fn(),
  readBlueprintReleaseRevenueDependencies: vi.fn(),
  resolveLocalGithubIdentity: vi.fn(),
  loadHiveKeyStatus: vi.fn(),
  signWithHiveKey: vi.fn(),
}));

vi.mock('../../cupboard/commerce-door-gate-io', () => io);
vi.mock('../../cupboard/blueprint-release', () => ({ readBlueprintReleaseRevenueDependencies: io.readBlueprintReleaseRevenueDependencies }));
vi.mock('../../blueprint/installed-blueprints', () => ({ INSTALLED_BLUEPRINTS_DIR: () => '/retained-blueprints' }));
vi.mock('../../identity/resolve-local-github-identity', () => ({ resolveLocalGithubIdentity: io.resolveLocalGithubIdentity }));
vi.mock('../../identity/hive-keypair', () => ({ loadHiveKeyStatus: io.loadHiveKeyStatus, signWithHiveKey: io.signWithHiveKey }));

import tool from './publish-offer';
import {
  IDENTITY_MARKUP_METER_UNIT,
  identityMarkupSplitManifest,
  identityPerUseOfferTerms,
} from '../../cupboard/identity-per-use-offer';
import { sellerReceiptAuthoritySigningBytes, verifySellerReceiptAuthority } from '../../p2p/metered-invocation';

const NEVER_EMIT_SELLER_TOKEN = 'never-emit-me';

const PER_USE_INPUT = {
  productId: 'prod-use',
  offerId: 'offer-use',
  skuRef: 'sku-use',
  title: 'Metered tool',
  pricingModel: 'per-use' as const,
  amountMinor: 0,
  currency: 'USD',
  unitPriceMicros: 25,
  meterUnit: 'tool-call',
  priceVersion: 'price-v1',
  splitManifestHash: `sha256:${'a'.repeat(64)}`,
};

function body(result: unknown): Record<string, unknown> {
  const response = result as { data?: unknown; content?: Array<{ text: string }> };
  return (response.data ?? JSON.parse(response.content![0].text)) as Record<string, unknown>;
}

describe('cupboard:publish-offer agent-tool production door', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires the complete per-use term set and forbids it on provider-backed offers', () => {
    expect(tool.name).toBe('cupboard:publish-offer');
    expect(tool.capability).toBe('harness:write');
    expect(tool.args.safeParse(PER_USE_INPUT).success).toBe(true);
    expect(
      tool.args.safeParse({
        ...PER_USE_INPUT,
        splitManifestHash: undefined,
      }).success,
    ).toBe(false);
    expect(
      tool.args.safeParse({
        ...PER_USE_INPUT,
        pricingModel: 'one-time',
      }).success,
    ).toBe(false);
  });

  it('routes the exact per-use terms through the authenticated Worker transport', async () => {
    io.postCommerceOffer.mockResolvedValue({
      ok: true,
      replayed: false,
      product: { productId: 'prod-use', creatorId: 'gh:42' },
      offer: { offerId: 'offer-use', pricingModel: 'per-use' },
    });

    const result = await tool.handler(PER_USE_INPUT, {} as never);

    expect(io.postCommerceOffer).toHaveBeenCalledWith({
      productId: 'prod-use',
      offerId: 'offer-use',
      skuRef: 'sku-use',
      title: 'Metered tool',
      pricingModel: 'per-use',
      price: { amountMinor: 0, currency: 'USD' },
      perUse: {
        unitPriceMicros: 25,
        meterUnit: 'tool-call',
        priceVersion: 'price-v1',
        splitManifestHash: `sha256:${'a'.repeat(64)}`,
      },
    });
    expect(body(result)).toMatchObject({
      ok: true,
      replayed: false,
      offer: { offerId: 'offer-use', pricingModel: 'per-use' },
    });
  });

  it('preserves hosted validation evidence for the caller', async () => {
    io.postCommerceOffer.mockResolvedValue({
      ok: false,
      status: 422,
      error: 'invalid_offer',
      detail: 'missing per-use terms',
    });

    expect(body(await tool.handler(PER_USE_INPUT, {} as never))).toEqual({
      ok: false,
      error: 'invalid_offer',
      detail: 'missing per-use terms',
      status: 422,
    });
  });

  it.each([false, true])('signs publisher-bound offer identity with the chosen hive and forwards the same authenticated bearer (identity=%s)', async identity => {
    const pair = generateKeyPairSync('ed25519');
    const pubkeyBase64 = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    io.resolveLocalGithubIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 42, token: NEVER_EMIT_SELLER_TOKEN });
    io.loadHiveKeyStatus.mockResolvedValue({ kind: 'ok', pubkeyBase64 });
    io.signWithHiveKey.mockImplementation(async (_workspace, _hive, bytes) => sign(null, bytes, pair.privateKey));
    io.postCommerceOffer.mockResolvedValue({ ok: true });
    const input = identity ? { ...PER_USE_INPUT, skuRef: undefined, unitPriceMicros: undefined,
      meterUnit: undefined, priceVersion: undefined, splitManifestHash: undefined,
      identityRelease: { id: 'publisher-identity', version: '1.0.0' } } : PER_USE_INPUT;
    const result = await tool.handler(tool.args.parse({ ...input,
      receiptSigningHive: { workspaceId: 'seller-ws', hiveSlug: 'seller-hive' } }), {} as never);
    expect(body(result)).toMatchObject({ ok: true });
    const request = io.postCommerceOffer.mock.calls[0]![0];
    const binding = { seller: 'gh:42', productId: PER_USE_INPUT.productId, offerId: PER_USE_INPUT.offerId,
      skuRef: identity ? 'identity-release:publisher-identity@1.0.0' : PER_USE_INPUT.skuRef, pubkeyBase64 };
    expect(io.loadHiveKeyStatus).toHaveBeenCalledExactlyOnceWith('seller-ws', 'seller-hive');
    expect(io.signWithHiveKey).toHaveBeenCalledExactlyOnceWith('seller-ws', 'seller-hive', sellerReceiptAuthoritySigningBytes(binding));
    expect(request.receiptAuthority.pubkeyBase64).toBe(pubkeyBase64);
    expect(verifySellerReceiptAuthority(binding, request.receiptAuthority)).toBe(true);
    expect(io.postCommerceOffer.mock.calls[0]![1]).toEqual({ authToken: NEVER_EMIT_SELLER_TOKEN });
  });

  it.each(['github', 'key'] as const)('refuses unavailable %s authority before signing or publishing', async unavailable => {
    io.resolveLocalGithubIdentity.mockResolvedValue(unavailable === 'github' ? { kind: 'unavailable' }
      : { kind: 'ok', githubUserId: 42, token: NEVER_EMIT_SELLER_TOKEN });
    io.loadHiveKeyStatus.mockResolvedValue({ kind: 'missing' });
    expect(body(await tool.handler(tool.args.parse({ ...PER_USE_INPUT,
      receiptSigningHive: { workspaceId: 'seller-ws', hiveSlug: 'seller-hive' } }), {} as never)))
      .toMatchObject({ ok: false, error: unavailable === 'github' ? 'gh_auth_required' : 'seller_signing_key_required' });
    expect(io.signWithHiveKey).not.toHaveBeenCalled();
    expect(io.postCommerceOffer).not.toHaveBeenCalled();
  });
});

// flywheel P-015 / R-1: an identity release carries a per-use offer whose
// skuRef is that release, and the markup split gives the DAO 1000 bps.
describe('cupboard:publish-offer for a paid identity release', () => {
  const IDENTITY_INPUT = {
    productId: 'prod-identity',
    offerId: 'offer-identity',
    title: 'Papercusp engineer identity',
    pricingModel: 'per-use' as const,
    amountMinor: 0,
    currency: 'USD',
    identityRelease: { id: 'papercusp-engineer', version: '1.2.0' },
  };
  const SKU = 'identity-release:papercusp-engineer@1.2.0';
  const DEFAULT_PRICE_VERSION = 'identity-markup-v1;markup=2000;creator=9000;component=0;dao=1000';
  const components = [{ packageKind: 'blueprint', ref: 'dependency', revision: '1.0.0', contentHash: 'a'.repeat(64), author: 'alice' }];

  beforeEach(() => {
    vi.clearAllMocks();
    io.readBlueprintReleaseRevenueDependencies.mockResolvedValue(components);
  });

  function storeEcho() {
    // The hosted ledger stores what it was sent; read it back from the call.
    io.postCommerceOffer.mockImplementation(async (request: Record<string, unknown>) => ({
      ok: true,
      replayed: false,
      product: { productId: request.productId, skuRef: request.skuRef, creatorId: 'gh:42' },
      offer: { offerId: request.offerId, pricingModel: request.pricingModel, perUse: request.perUse },
    }));
  }

  it('derives every per-use term from the identity release and stores the offer against it', async () => {
    storeEcho();
    const result = body(await tool.handler(tool.args.parse(IDENTITY_INPUT), {} as never));

    expect(io.postCommerceOffer).toHaveBeenCalledTimes(1);
    const sent = io.postCommerceOffer.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.skuRef).toBe(SKU);
    const expected = identityMarkupSplitManifest({ creatorBps: 9000, componentBps: 0 });
    expect(sent.perUse).toEqual({
      unitPriceMicros: 200,
      meterUnit: IDENTITY_MARKUP_METER_UNIT,
      priceVersion: DEFAULT_PRICE_VERSION,
      splitManifestHash: expected.manifestHash,
    });
    // Read back: the stored product names the identity release it was published for.
    expect(result).toMatchObject({ ok: true, product: { skuRef: SKU }, offer: { offerId: 'offer-identity' } });
    expect(result.identityOffer).toMatchObject({
      identity: { id: 'papercusp-engineer', version: '1.2.0' },
      markup: { markupBps: 2000, creatorBps: 9000, componentBps: 0 },
      splitSharesBps: { dao: 1000, creator: 9000, component: 0, host: 0 },
    });
  });

  it('prices a seller-set markup and split', async () => {
    storeEcho();
    await tool.handler(
      tool.args.parse({
        ...IDENTITY_INPUT,
        identityRelease: { id: 'papercusp-engineer', version: '1.2.0', markupBps: 3500, creatorBps: 6000, componentBps: 3000 },
      }),
      {} as never,
    );
    const sent = io.postCommerceOffer.mock.calls[0]![0] as { perUse: Record<string, unknown> };
    expect(sent.perUse.unitPriceMicros).toBe(350);
    const expected = identityPerUseOfferTerms({ identity: IDENTITY_INPUT.identityRelease, markupBps: 3500,
      creatorBps: 6000, componentBps: 3000, componentDependencies: components });
    if (!expected.ok) throw new Error(expected.detail);
    expect(sent.perUse.priceVersion).toBe(expected.terms.priceVersion);
    expect(sent.perUse.splitManifestHash).toBe(
      identityMarkupSplitManifest({ creatorBps: 6000, componentBps: 3000, componentDependencies: components }).manifestHash,
    );
    expect(io.readBlueprintReleaseRevenueDependencies).toHaveBeenCalledWith('/retained-blueprints', IDENTITY_INPUT.identityRelease);
  });

  it('refuses missing attribution and forged component terms before publishing to the Worker', async () => {
    const input = { ...IDENTITY_INPUT, identityRelease: { ...IDENTITY_INPUT.identityRelease, componentBps: 3000 } };
    io.readBlueprintReleaseRevenueDependencies.mockRejectedValueOnce(new Error('no pinned publisher id'));
    expect(body(await tool.handler(tool.args.parse(input), {} as never))).toMatchObject({ ok: false, error: 'identity-component-closure' });
    const forged = identityPerUseOfferTerms({ identity: IDENTITY_INPUT.identityRelease, componentBps: 3000,
      componentDependencies: components.map((pin) => ({ ...pin, author: 'mallory' })) });
    if (!forged.ok) throw new Error(forged.detail);
    expect(body(await tool.handler(tool.args.parse({ ...PER_USE_INPUT, ...forged.terms }), {} as never)))
      .toMatchObject({ ok: false, error: 'identity-offer-mismatch' });
    expect(io.postCommerceOffer).not.toHaveBeenCalled();
  });

  it('refuses a caller-supplied skuRef or term beside identityRelease, and a non-per-use identity offer', () => {
    expect(tool.args.safeParse({ ...IDENTITY_INPUT, skuRef: 'identity-release:other@9.9.9' }).success).toBe(false);
    expect(tool.args.safeParse({ ...IDENTITY_INPUT, unitPriceMicros: 1 }).success).toBe(false);
    expect(tool.args.safeParse({ ...IDENTITY_INPUT, pricingModel: 'one-time' }).success).toBe(false);
    const { identityRelease: _omit, ...noSku } = IDENTITY_INPUT;
    expect(tool.args.safeParse(noSku).success).toBe(false);
  });

  it('refuses an invalid markup or a split that shorts the DAO before any network call', async () => {
    const offMarkup = await tool.handler(
      tool.args.parse({ ...IDENTITY_INPUT, identityRelease: { id: 'papercusp-engineer', version: '1.2.0', markupBps: 15 } }),
      {} as never,
    );
    expect(body(offMarkup)).toMatchObject({ ok: false, error: 'invalid-markup' });
    const shortDao = await tool.handler(
      tool.args.parse({
        ...IDENTITY_INPUT,
        identityRelease: { id: 'papercusp-engineer', version: '1.2.0', creatorBps: 10000, componentBps: 0 },
      }),
      {} as never,
    );
    expect(body(shortDao)).toMatchObject({ ok: false, error: 'invalid-split' });
    expect(io.postCommerceOffer).not.toHaveBeenCalled();
  });

  it('checks a hand-authored identity-release offer against the terms its priceVersion derives', async () => {
    storeEcho();
    const derived = identityPerUseOfferTerms({ identity: { id: 'papercusp-engineer', version: '1.2.0' } });
    if (!derived.ok) throw new Error(derived.detail);
    const handAuthored = {
      ...PER_USE_INPUT,
      skuRef: derived.terms.skuRef,
      unitPriceMicros: derived.terms.unitPriceMicros,
      meterUnit: derived.terms.meterUnit,
      priceVersion: derived.terms.priceVersion,
      splitManifestHash: derived.terms.splitManifestHash,
    };
    expect(body(await tool.handler(handAuthored, {} as never))).toMatchObject({ ok: true, product: { skuRef: SKU } });

    // A split hash that does not match the spelled-out split (the DAO shorted).
    const forged = { ...handAuthored, splitManifestHash: `sha256:${'b'.repeat(64)}` };
    expect(body(await tool.handler(forged, {} as never))).toMatchObject({ ok: false, error: 'identity-offer-mismatch' });
    // A price that is not the markup.
    expect(body(await tool.handler({ ...handAuthored, unitPriceMicros: 999 }, {} as never))).toMatchObject({
      ok: false,
      error: 'identity-offer-mismatch',
    });
    expect(io.postCommerceOffer).toHaveBeenCalledTimes(1);
  });
});
