import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { compileAgentSpecification, layerContentHash } from '@papercusp/orchestrator/blueprint';
import { commitBlueprintRelease, readBlueprintLifecycle, snapshotBlueprintReleaseSource } from './blueprint-release';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../blueprint/installed-blueprints';
import {
  admitIdentityActivation,
  admitNativeIdentityInference,
  resolveAppliedIdentityReleaseLayers,
  assertIdentityActivationFunded,
  configureIdentityActivationGateIo,
  IDENTITY_PRICING_CACHE_TTL_MS,
  readHostedPaymentChannel,
  type IdentityActivationGateIo,
} from './identity-activation-gate-io';
import type { IdentityReleaseFundingRow } from './identity-release-funding-store';
import { isIdentityActivationRefusedError, type FundingChannelView, type IdentityOfferView } from './identity-activation-gate';
import { identityPerUseOfferTerms, identityReleaseSkuRef } from './identity-per-use-offer';
import type { AppliedIdentityRules } from '../agent-identities/sync-hook-rules';

const identity = { id: 'acme/reviewer', version: '1.0.0' };
const derived = identityPerUseOfferTerms({ identity });
if (!derived.ok) throw new Error(derived.detail);
const { skuRef, ...perUse } = derived.terms;
const offer: IdentityOfferView = { offerId: 'off_1', skuRef, active: true, productActive: true, perUse };
const layer = { layerRef: 'persona:acme/reviewer', identity, skuRef };
const request = { stack: ['persona:acme/reviewer'], workspaceId: 'ws-test' };

/** A fake hosted Cupboard + local store the tests mutate between activations. */
function world() {
  const state = {
    layers: [layer],
    offers: { ok: true, value: [offer] } as Awaited<ReturnType<IdentityActivationGateIo['readOffers']>>,
    prepaid: { availableMicros: 0, debtMicros: 0 },
    channel: null as FundingChannelView | null,
    rows: new Map<string, IdentityReleaseFundingRow>(),
    now: 1_000_000,
    calls: { offers: 0, prepaid: 0, channel: 0, funding: 0 },
  };
  const io: Partial<IdentityActivationGateIo> = {
    resolveLayers: async () => state.layers,
    readOffers: async () => { state.calls.offers += 1; return state.offers; },
    readPrepaid: async () => { state.calls.prepaid += 1; return { ok: true, value: state.prepaid }; },
    readChannel: async (id) => {
      state.calls.channel += 1;
      return { ok: true, value: state.channel?.channelId === id ? state.channel : null };
    },
    readFunding: async () => { state.calls.funding += 1; return new Map(state.rows); },
    recordPricing: async (_ws, sku, verdict) => {
      const prior = state.rows.get(sku);
      state.rows.set(sku, {
        skuRef: sku,
        channelId: prior?.channelId ?? null,
        pricingState: verdict.kind === 'unverifiable' ? null : verdict.kind,
        pricingOfferId: verdict.kind === 'priced' ? verdict.offerId : null,
        pricingUnitMicros: verdict.kind === 'priced' ? verdict.unitPriceMicros : null,
        pricingCheckedAtMs: state.now,
      });
    },
    nowMs: () => state.now,
  };
  configureIdentityActivationGateIo(io);
  const bind = (channelId: string) => {
    const prior = state.rows.get(skuRef);
    state.rows.set(skuRef, {
      skuRef, channelId,
      pricingState: prior?.pricingState ?? null, pricingOfferId: prior?.pricingOfferId ?? null,
      pricingUnitMicros: prior?.pricingUnitMicros ?? null, pricingCheckedAtMs: prior?.pricingCheckedAtMs ?? null,
    });
  };
  return { state, bind };
}

afterEach(() => configureIdentityActivationGateIo(null));

describe('APPLIED native identity admission', () => {
  const rootPin = { packageKind: 'blueprint' as const, ref: identity.id, revision: identity.version, contentHash: 'root' };
  const dependency = { packageKind: 'rule' as const, ref: 'guard', revision: '1', contentHash: 'dep' };
  const worn = (): AppliedIdentityRules => ({ applied: { specificationRevision: 'applied-spec', stateRevision: 'applied-state' },
    packagePins: [rootPin, dependency], pins: { rules: [], unreadable: [] }, sync: { rules: [], unreadable: [] }, declaredClassNeeds: null,
    recall: null });
  const retained = () => ({ schemaVersion: 1 as const, id: identity.id, version: identity.version, contentHash: 'root', artifactContentHash: 'artifact',
    installedAtMs: 1, source: 'test', slots: ['persona'], pins: [rootPin, dependency] });
  const context = { ownerId: 'su-native', workspaceId: request.workspaceId, backend: 'codex' };

  it('matches a real compiled installed release after ACTIVE advances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p017-applied-release-'));
    const id = 'p017-compiled-identity';
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    try {
      const install = async (version: string) => {
        const sourceDir = join(root, version);
        mkdirSync(join(sourceDir, 'prompts'), { recursive: true });
        const raw = { id, extends: 'base', version, slots: [{ slot: 'domain' }] };
        writeFileSync(join(sourceDir, 'blueprint.yaml'), stringify({ ...raw,
          attestation: { contentHash: layerContentHash(raw), signedBy: 'test-publisher' } }));
        writeFileSync(join(sourceDir, 'prompts', 'domain.md'), `Release ${version}\n`);
        const snapshot = await snapshotBlueprintReleaseSource({ blueprintFile: join(sourceDir, 'blueprint.yaml'),
          resolveExtends: operatorResolveExtends() });
        await commitBlueprintRelease({ installedDir: INSTALLED_BLUEPRINTS_DIR(), sourceDir, id, version,
          source: 'https://example.invalid/identity', pins: snapshot.archive.pins });
      };
      await install('1.0.0');
      const compiled = compileAgentSpecification({ sourcePath: join(INSTALLED_BLUEPRINTS_DIR(), id, 'blueprint.yaml'),
        resolve: operatorResolveExtends() });
      const applied = { packagePins: compiled.inputs.filter((pin) => pin.kind === 'package') };
      const expectedIdentity = { id, version: '1.0.0' };
      expect(await resolveAppliedIdentityReleaseLayers(applied)).toEqual([
        { layerRef: `blueprint:${id}`, identity: expectedIdentity,
          skuRef: identityReleaseSkuRef(expectedIdentity) },
      ]);
      await install('2.0.0');
      expect((await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), id)).active?.version).toBe('2.0.0');
      expect(await resolveAppliedIdentityReleaseLayers(applied)).toMatchObject([{ identity: expectedIdentity }]);
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  it('resolves the worn historical release rather than the newer active version', async () => {
    const readReleases = vi.fn(async () => [retained(), { ...retained(), version: '2.0.0', contentHash: 'new' }]);
    expect(await resolveAppliedIdentityReleaseLayers(worn(), { readReleases })).toEqual([
      { layerRef: `blueprint:${identity.id}`, identity, skuRef },
    ]);
    expect(readReleases).toHaveBeenCalledExactlyOnceWith(identity.id);
  });

  it('refuses same-version hash changes, version collisions and changed non-blueprint dependencies', async () => {
    for (const records of [[{ ...retained(), contentHash: 'changed' }], [retained(), retained()],
      [{ ...retained(), pins: [rootPin, { ...dependency, contentHash: 'changed' }] }]]) {
      await expect(resolveAppliedIdentityReleaseLayers(worn(), { readReleases: async () => records })).rejects.toThrow(/APPLIED/);
    }
  });

  it('does no commerce IO for ordinary pins without a retained release', async () => {
    const { state } = world();
    const decision = await admitNativeIdentityInference(context, {
      readApplied: async () => worn(), resolveLayers: async (w) => resolveAppliedIdentityReleaseLayers(w, { readReleases: async () => [] }),
    });
    expect(decision).toEqual({ ok: true });
    expect(state.calls).toEqual({ offers: 0, prepaid: 0, channel: 0, funding: 0 });
  });

  it('re-reads funds for the exact APPLIED release and refuses unsupported billing before any monetary reservation', async () => {
    const { state, bind } = world();
    state.channel = { channelId: 'ch_9', state: 'open', escrowMicros: 5_000, committedMicros: 0 };
    bind('ch_9');
    const readApplied = vi.fn(async () => worn());
    const resolveLayers = vi.fn(async (w: Pick<AppliedIdentityRules, 'packagePins'>) =>
      resolveAppliedIdentityReleaseLayers(w, { readReleases: async () => [retained()] }));
    expect(await admitNativeIdentityInference(context, { readApplied, resolveLayers }))
      .toMatchObject({ ok: false, code: 'identity-native-billing-unsupported' });
    expect(readApplied).toHaveBeenCalledExactlyOnceWith(context.ownerId, context.workspaceId);
    state.channel = { ...state.channel, state: 'closed' };
    expect(await admitNativeIdentityInference(context, { readApplied, resolveLayers }))
      .toMatchObject({ ok: false, code: 'identity-activation-unfunded' });
    expect(state.calls.channel).toBe(2);
  });

  it('preserves verified free identities and fails closed on an unreadable APPLIED artifact', async () => {
    const { state } = world(); state.offers = { ok: true, value: [] };
    expect(await admitNativeIdentityInference(context, { readApplied: async () => worn(), resolveLayers: async () => [layer] }))
      .toEqual({ ok: true });
    expect(await admitNativeIdentityInference(context, { readApplied: async () => { throw new Error('missing receipt'); } }))
      .toMatchObject({ ok: false, code: 'identity-funding-unverifiable' });
  });
});

describe('admitIdentityActivation', () => {
  it('does no store or hosted work for a stack without installed releases', async () => {
    const { state } = world();
    state.layers = [];
    await expect(admitIdentityActivation(request)).resolves.toEqual({ ok: true, charged: [] });
    expect(state.calls).toEqual({ offers: 0, prepaid: 0, channel: 0, funding: 0 });
  });

  it('refuses a priced release with no funds, with a typed error at the door', async () => {
    world();
    const decision = await admitIdentityActivation(request);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe('identity-activation-unfunded');
    const refusal = await assertIdentityActivationFunded(request).catch((error: unknown) => error);
    expect(isIdentityActivationRefusedError(refusal)).toBe(true);
  });

  it('activates with prepaid credits', async () => {
    const { state } = world();
    state.prepaid = { availableMicros: 1_000, debtMicros: 0 };
    const decision = await assertIdentityActivationFunded(request);
    expect(decision.charged[0]?.source).toEqual({ kind: 'prepaid-credits' });
  });

  it('activates with the payment channel bound to the release', async () => {
    const { state, bind } = world();
    state.channel = { channelId: 'ch_9', state: 'open', escrowMicros: 5_000, committedMicros: 0 };
    bind('ch_9');
    const decision = await assertIdentityActivationFunded(request);
    expect(decision.charged[0]?.source).toEqual({ kind: 'payment-channel', channelId: 'ch_9' });
  });

  it('revocation stops the next activation: funds are re-read every time', async () => {
    const { state, bind } = world();
    state.channel = { channelId: 'ch_9', state: 'open', escrowMicros: 5_000, committedMicros: 0 };
    bind('ch_9');
    expect((await admitIdentityActivation(request)).ok).toBe(true);
    state.channel = { ...state.channel, state: 'closed' };
    const next = await admitIdentityActivation(request);
    expect(next.ok).toBe(false);
    expect(state.calls.channel).toBe(2);

    state.channel = null;
    state.prepaid = { availableMicros: 1_000, debtMicros: 0 };
    expect((await admitIdentityActivation(request)).ok).toBe(true);
    state.prepaid = { availableMicros: 1_000, debtMicros: 50 };
    expect((await admitIdentityActivation(request)).ok).toBe(false);
  });

  it('caches the pricing verdict and reuses it inside the TTL', async () => {
    const { state } = world();
    state.prepaid = { availableMicros: 1_000, debtMicros: 0 };
    await admitIdentityActivation(request);
    await admitIdentityActivation(request);
    expect(state.calls.offers).toBe(1);
    state.now += IDENTITY_PRICING_CACHE_TTL_MS;
    await admitIdentityActivation(request);
    expect(state.calls.offers).toBe(2);
  });

  it('keeps a release last seen free launching while the offers are unreachable', async () => {
    const { state } = world();
    state.offers = { ok: true, value: [] };
    expect(await admitIdentityActivation(request)).toEqual({ ok: true, charged: [] });
    state.now += IDENTITY_PRICING_CACHE_TTL_MS;
    state.offers = { ok: false, detail: 'transport_error' };
    expect(await admitIdentityActivation(request)).toEqual({ ok: true, charged: [] });
    expect(state.calls.prepaid).toBe(0);
  });

  it('refuses a release never priced before when the offers are unreachable', async () => {
    const { state } = world();
    state.offers = { ok: false, detail: 'transport_error' };
    state.prepaid = { availableMicros: 1_000_000, debtMicros: 0 };
    const decision = await admitIdentityActivation(request);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe('identity-pricing-unverifiable');
  });
});

describe('readHostedPaymentChannel', () => {
  it('treats the owner-only 404 as no channel, and reads an open channel', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).endsWith('/ch_x')
      ? new Response(JSON.stringify({ error: 'channel_not_found' }), { status: 404 })
      : new Response(JSON.stringify({ channel: { channelId: 'ch_ok', state: 'open', escrowMicros: 10, committedMicros: 2 } }),
        { status: 200 }));
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'https://cupboard.test', authToken: 't' };
    await expect(readHostedPaymentChannel('ch_x', deps)).resolves.toEqual({ ok: true, value: null });
    await expect(readHostedPaymentChannel('ch_ok', deps)).resolves.toEqual({
      ok: true, value: { channelId: 'ch_ok', state: 'open', escrowMicros: 10, committedMicros: 2 },
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });
});
