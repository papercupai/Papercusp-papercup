import { afterEach, describe, expect, it } from 'vitest';
import {
  STUB_ENTITLEMENT_PROVIDER_ID,
  createConfiguredHostedSubscriptionEntitlementProvider,
  parseHostedPaidEntitlementBundle,
  configureHostedSubscriptionEntitlementProvider,
  currentHostedSubscriptionEntitlementProvider,
  resolveHostedSubscriptionEntitlement,
  stubHostedSubscriptionEntitlementProvider,
  type HostedSubscriptionEntitlementProvider,
  type HostedSubscriptionSnapshot,
} from './entitlement-seam';

const snapshot = (over: Partial<HostedSubscriptionSnapshot> = {}): HostedSubscriptionSnapshot => ({
  organizationId: '11111111-2222-4333-8444-555555555555',
  stripeSubscriptionId: 'sub_A',
  status: 'active',
  planKey: 'team',
  priceId: 'price_team',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  livemode: false,
  latestInvoiceStatus: 'paid',
  ...over,
});

const paidBundle = () => ({ schemaVersion: 1, bundleId: 'paid-team', bundleVersion: 1,
  record: { source: 'billing', actor: { kind: 'service', principalId: 'service:billing' },
    auditReceiptId: 'policy:paid-team:1', effectiveFrom: '2026-01-01T00:00:00Z', effectiveUntil: null },
  entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 5 },
    browserAccess: { pty: true, files: true }, supportTier: 'paid',
    quotas: { 'pool.agents': 20, 'pool.hosts': 2, 'pool.cpu-millicores': 8000, 'pool.memory-mib': 16384,
      'pool.db-gib': 256, 'pool.workspace-gib': 32, 'pool.reserved-hosts': 1 },
    budgets: { 'pool.cost.usd.minor': 10000 }, rolloutFlags: {} } });

describe('configured paid resource policy', () => {
  const now = new Date('2026-10-16T09:00:00Z');
  it('pins explicit policy to both price and plan, bounds grace/cancel-at-end, and detaches configuration', async () => {
    const bundle = parseHostedPaidEntitlementBundle(paidBundle());
    const provider = createConfiguredHostedSubscriptionEntitlementProvider([{ planKey: 'team', priceId: 'price_team', entitlementBundle: bundle }]);
    (bundle.entitlements.quotas as Record<string, number>)['pool.agents'] = 999;
    for (const status of ['active', 'trialing', 'past_due'] as const) {
      expect(await resolveHostedSubscriptionEntitlement(snapshot({ status, cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(now.getTime() + 1) }), { provider, now }))
        .toMatchObject({ entitled: true, bundleKey: 'paid-team', patch: { quotas: { 'pool.agents': 20 } } });
    }
    for (const over of [{ priceId: 'price_other' }, { planKey: 'pro' }, { currentPeriodEnd: null },
      { currentPeriodEnd: now }, { status: 'canceled' as const }, { status: 'unpaid' as const }]) {
      const s = snapshot({ currentPeriodEnd: new Date(now.getTime() + 1000), ...over });
      expect(await resolveHostedSubscriptionEntitlement(s, { provider, now })).toMatchObject({ entitled: false, patch: null });
    }
  });
  it('rejects label-only, partial, foreign-source, and over-reserved policies', () => {
    for (const alter of [(b: ReturnType<typeof paidBundle>) => { delete (b.entitlements.quotas as Record<string, number>)['pool.db-gib']; },
      (b: ReturnType<typeof paidBundle>) => { b.record.source = 'migration'; },
      (b: ReturnType<typeof paidBundle>) => { b.entitlements.quotas['pool.reserved-hosts'] = 3; },
      (b: ReturnType<typeof paidBundle>) => { b.entitlements.budgets = {} as typeof b.entitlements.budgets; }]) {
      const b = paidBundle(); alter(b); expect(() => parseHostedPaidEntitlementBundle(b)).toThrow();
    }
  });
});

afterEach(() => {
  configureHostedSubscriptionEntitlementProvider(stubHostedSubscriptionEntitlementProvider);
});

describe('stub entitlement provider', () => {
  it.each([
    ['active', true, 'active'],
    ['trialing', true, 'trialing'],
    ['past_due', true, 'grace_past_due'],
    ['unpaid', false, 'inactive'],
    ['canceled', false, 'inactive'],
    ['incomplete', false, 'inactive'],
    ['pending', false, 'inactive'],
  ] as const)('%s → entitled=%s (%s)', async (status, entitled, reason) => {
    const answer = await resolveHostedSubscriptionEntitlement(snapshot({ status }));
    expect(answer).toMatchObject({ entitled, reason, source: 'billing', providerId: STUB_ENTITLEMENT_PROVIDER_ID, patch: null });
    expect(answer.bundleKey).toBe(entitled ? 'hosted-paid:team' : null);
  });

  it('no subscription is not_subscribed; an unconfigured price fails closed', async () => {
    expect(await resolveHostedSubscriptionEntitlement(null)).toMatchObject({ entitled: false, reason: 'not_subscribed' });
    expect(await resolveHostedSubscriptionEntitlement(snapshot({ planKey: null }))).toMatchObject({ entitled: false, reason: 'unknown_plan' });
  });
});

describe('the seam', () => {
  it('a configured provider (the metering work) replaces the stub without touching callers', async () => {
    const metered: HostedSubscriptionEntitlementProvider = {
      id: 'metering:test',
      entitlementFor: (s) => ({
        entitled: s?.status === 'active',
        reason: s?.status === 'active' ? 'active' : 'inactive',
        bundleKey: s?.status === 'active' ? 'team-v2' : null,
        patch: { quotas: { 'agent-hours': 40 } },
        source: 'billing',
        providerId: 'metering:test',
      }),
    };
    const previous = configureHostedSubscriptionEntitlementProvider(metered);
    expect(previous.id).toBe(STUB_ENTITLEMENT_PROVIDER_ID);
    expect(currentHostedSubscriptionEntitlementProvider().id).toBe('metering:test');
    expect(await resolveHostedSubscriptionEntitlement(snapshot())).toMatchObject({ bundleKey: 'team-v2', patch: { quotas: { 'agent-hours': 40 } } });
  });

  it('fails closed when a provider throws or answers malformed', async () => {
    const throwing: HostedSubscriptionEntitlementProvider = { id: 'broken', entitlementFor: () => { throw new Error('down'); } };
    expect(await resolveHostedSubscriptionEntitlement(snapshot(), { provider: throwing })).toMatchObject({ entitled: false, providerId: 'broken' });
    const lying: HostedSubscriptionEntitlementProvider = {
      id: 'lying',
      entitlementFor: () => ({ entitled: true, reason: 'active', bundleKey: null, patch: null, source: 'billing', providerId: 'lying' }),
    };
    expect(await resolveHostedSubscriptionEntitlement(snapshot(), { provider: lying })).toMatchObject({ entitled: false });
  });

  it('fails closed on a malformed answer: no answer, a non-boolean entitled, or a non-billing source', async () => {
    // Each answer would grant access if passed through: a truthy `entitled` with a bundle key.
    const malformed: ReadonlyArray<{ id: string; answer: unknown }> = [
      { id: 'empty', answer: null },
      { id: 'stringly', answer: { entitled: 'yes', reason: 'active', bundleKey: 'team', patch: null, source: 'billing', providerId: 'stringly' } },
      { id: 'foreign', answer: { entitled: true, reason: 'active', bundleKey: 'team', patch: null, source: 'metering', providerId: 'foreign' } },
    ];
    for (const { id, answer } of malformed) {
      const provider = { id, entitlementFor: () => answer } as unknown as HostedSubscriptionEntitlementProvider;
      expect(await resolveHostedSubscriptionEntitlement(snapshot(), { provider })).toEqual({
        entitled: false,
        reason: 'inactive',
        bundleKey: null,
        patch: null,
        source: 'billing',
        providerId: id,
      });
    }
  });
});
