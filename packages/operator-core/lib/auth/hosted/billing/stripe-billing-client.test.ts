import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createStripeBillingClient, stripeKeyMode, type StripePaymentLineagePin } from './stripe-billing-client';

interface Call { url: string; headers: Record<string, string>; form: URLSearchParams }

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, form: new URLSearchParams(String(init?.body)) });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const ORG = '11111111-2222-4333-8444-555555555555';

describe('Stripe customer deletion (P-010)', () => {
  const customer = { object: 'customer', id: 'cus_pinned', livemode: false, metadata: { organizationId: ORG } };
  const tombstone = { object: 'customer', id: 'cus_pinned', deleted: true };
  function deletionClient(responses: { body: unknown; status?: number; requestId?: string | null }[]) {
    let index = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      const next = responses[index++] ?? { body: {}, status: 500 };
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200,
        headers: next.requestId === null ? {} : { 'request-id': next.requestId ?? `req_${index}` } });
    });
    const built = createStripeBillingClient({ secretKey: 'sk_test_deletion', fetchImpl, liveModeAllowed: false });
    if (!built.ok) throw new Error('client');
    return { client: built.client, fetchImpl };
  }

  it('checks the frozen tenant pin before DELETE and requires a provider tombstone', async () => {
    const { client, fetchImpl } = deletionClient([{ body: customer }, { body: tombstone }]);
    expect(await client.deleteCustomer({ customerId: 'cus_pinned', organizationId: ORG })).toEqual({
      ok: true, customerId: 'cus_pinned', alreadyDeleted: false, requestIds: ['req_1', 'req_2'],
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.stripe.com/v1/customers/cus_pinned', 'GET'],
      ['https://api.stripe.com/v1/customers/cus_pinned', 'DELETE'],
    ]);
    for (const [, init] of fetchImpl.mock.calls) expect(init).toMatchObject({ redirect: 'error',
      headers: { authorization: 'Bearer sk_test_deletion' } });
  });

  it('replays from an authenticated tombstone without repeating a DELETE', async () => {
    const { client, fetchImpl } = deletionClient([{ body: tombstone }]);
    expect(await client.deleteCustomer({ customerId: 'cus_pinned', organizationId: ORG })).toMatchObject({
      ok: true, alreadyDeleted: true, requestIds: ['req_1'],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...customer, metadata: { organizationId: 'other-tenant' } },
    { ...customer, livemode: true },
    { ...customer, id: 'cus_other' },
    { ...customer, object: 'account' },
  ])('refuses a different customer, tenant, mode or object before mutation: %j', async body => {
    const { client, fetchImpl } = deletionClient([{ body }]);
    expect(await client.deleteCustomer({ customerId: 'cus_pinned', organizationId: ORG })).toMatchObject({
      ok: false, code: 'malformed-response',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not reinterpret a missing customer or missing provenance as deletion success', async () => {
    for (const response of [{ body: { error: 'private@example.test' }, status: 404 },
      { body: tombstone, requestId: null }]) {
      const { client, fetchImpl } = deletionClient([response]);
      const result = await client.deleteCustomer({ customerId: 'cus_pinned', organizationId: ORG });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private@example.test');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses an unconfirmed or wrong deletion response and unsafe customer ids', async () => {
    for (const body of [customer, { ...tombstone, id: 'cus_other' }]) {
      const { client } = deletionClient([{ body: customer }, { body }]);
      expect(await client.deleteCustomer({ customerId: 'cus_pinned', organizationId: ORG })).toMatchObject({
        ok: false, code: 'malformed-response',
      });
    }
    const { client, fetchImpl } = deletionClient([]);
    expect((await client.deleteCustomer({ customerId: 'cus_pinned/other', organizationId: ORG })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('stripeKeyMode / live-mode gate', () => {
  it('classifies keys without echoing them', () => {
    expect(stripeKeyMode('sk_test_abc')).toBe('test');
    expect(stripeKeyMode('rk_live_abc')).toBe('live');
    expect(stripeKeyMode('pk_test_abc')).toBeNull();
  });

  it('refuses a live key unless the owner-authority flag is on; test keys always construct', () => {
    const { impl } = fakeFetch([]);
    const refused = createStripeBillingClient({ secretKey: 'sk_live_x', fetchImpl: impl, liveModeAllowed: false });
    expect(refused).toEqual({
      ok: false,
      code: 'live_mode_not_allowed',
      // WI-10005197: the refusal says what compared, what lifts it, and who can make that true.
      refusal: {
        observed: { keyMode: 'live', liveModeAllowed: 'false' },
        liftsWhen: expect.stringContaining('papercusp-hosted-billing-live-mode'),
        whoCanMakeItTrue: ['owner'],
      },
    });
    // The contract is secret-free: the key itself is never in the observed values.
    expect(JSON.stringify(refused)).not.toContain('sk_live_x');
    const live = createStripeBillingClient({ secretKey: 'sk_live_x', fetchImpl: impl, liveModeAllowed: true });
    expect(live.ok && live.client.livemode).toBe(true);
    const test = createStripeBillingClient({ secretKey: 'sk_test_x', fetchImpl: impl, liveModeAllowed: false });
    expect(test.ok && test.client.livemode).toBe(false);
    expect(createStripeBillingClient({ secretKey: 'garbage', fetchImpl: impl, liveModeAllowed: true })).toEqual({ ok: false, code: 'invalid_secret_key' });
  });
});

describe('authenticated billing recovery event pages (P-016)', () => {
  const pin = { accountId: 'acct_Recovery', customerId: 'cus_Recovery', organizationId: ORG,
    createdFrom: 1_790_000_000, createdBefore: 1_790_000_100, limit: 2 };
  const account = { object: 'account', id: pin.accountId };
  const customer = { object: 'customer', id: pin.customerId, livemode: false, metadata: { organizationId: ORG } };
  const event = (id = 'evt_Recovery', created = pin.createdBefore - 1) => ({
    object: 'event', id, type: 'customer.subscription.updated', created, livemode: false,
    data: { object: { id: 'sub_Recovery', customer: pin.customerId, status: 'active',
      metadata: { organizationId: ORG }, items: { data: [{ price: { id: 'price_team' } }] },
      customer_email: 'private@example.test', description: 'private customer data' } },
  });
  const page = (data: unknown[], has_more = false) => ({ object: 'list', url: '/v1/events', data, has_more });
  function reader(bodies: unknown[], options: { noRequestIdAt?: number; statusAt?: number } = {}) {
    let index = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      const current = index++;
      return new Response(JSON.stringify(bodies[current] ?? {}), {
        status: options.statusAt === current ? 503 : 200,
        headers: options.noRequestIdAt === current ? {} : { 'request-id': `req_Recovery${current}` },
      });
    });
    const built = createStripeBillingClient({ secretKey: 'sk_test_recovery', fetchImpl, liveModeAllowed: false });
    if (!built.ok) throw new Error('fixture');
    return { client: built.client, fetchImpl };
  }

  it('reads a fixed window with authenticated provenance and a cursor across unrelated customer events', async () => {
    const own = event();
    const unrelated = event('evt_Other', own.created - 1);
    unrelated.data.object.customer = 'cus_Other';
    unrelated.data.object.metadata.organizationId = '22222222-2222-4333-8444-555555555555';
    const r = reader([account, customer, page([own, unrelated], true), account, customer, page([])]);
    const first = await r.client.readBillingEventPage(pin);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('fixture');
    expect(first.evidence).toMatchObject({ source: 'stripe-authenticated-api', accountId: pin.accountId,
      customerId: pin.customerId, organizationId: ORG, startingAfter: null, nextCursor: unrelated.id,
      hasMore: true, requestIds: ['req_Recovery0', 'req_Recovery1', 'req_Recovery2'],
      observations: [{ event: { eventId: own.id, facts: [{ organizationId: ORG }] },
        apiObjectDigest: createHash('sha256').update(JSON.stringify(own)).digest('hex') }],
      evidenceRef: expect.stringMatching(/^stripe-billing-page:[a-f0-9]{64}$/) });
    expect(first.evidence.observations).toHaveLength(1);
    expect(Object.isFrozen(first.evidence.observations)).toBe(true);
    const serialized = JSON.stringify(first.evidence);
    for (const privateValue of ['private@example.test', 'private customer data', 'sk_test_recovery', 'bodyDigest', 'signature']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(await r.client.readBillingEventPage({ ...pin, startingAfter: first.evidence.nextCursor! }))
      .toMatchObject({ ok: true, evidence: { hasMore: false, nextCursor: null, observations: [] } });
    const urls = r.fetchImpl.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[2]!.pathname).toBe('/v1/events');
    expect(Object.fromEntries(urls[2]!.searchParams)).toEqual({ limit: '2',
      'created[gte]': String(pin.createdFrom), 'created[lt]': String(pin.createdBefore) });
    expect(urls[5]!.searchParams.get('starting_after')).toBe(unrelated.id);
    for (const [, init] of r.fetchImpl.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error',
      headers: { authorization: 'Bearer sk_test_recovery' } });
  });

  it.each([
    { createdFrom: -1 }, { createdFrom: 0.1 }, { createdBefore: pin.createdFrom },
    { createdBefore: Infinity }, { createdBefore: 8_640_000_000_001 }, { limit: 0 }, { limit: 101 },
    { startingAfter: 'evt_bad/path' },
  ])('rejects invalid recovery bounds before transport: %j', async change => {
    const r = reader([]);
    expect(await r.client.readBillingEventPage({ ...pin, ...change })).toMatchObject({ ok: false });
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...account, id: 'acct_Other' }, customer],
    [account, { ...customer, id: 'cus_Other' }],
    [account, { ...customer, livemode: true }],
    [account, { ...customer, metadata: { organizationId: 'other' } }],
  ])('refuses account/customer/mode/tenant scope before event retrieval', async (first, second) => {
    const r = reader([first, second, page([event()])]);
    expect(await r.client.readBillingEventPage(pin)).toMatchObject({ ok: false });
    expect(r.fetchImpl.mock.calls.some(([url]) => String(url).includes('/events?'))).toBe(false);
  });

  it.each([
    page([], true), { ...page([]), has_more: 'false' }, { ...page([]), url: '/v1/charges' },
    page([event(), event('evt_B'), event('evt_C')]), page([event(), event()]),
    page([event('evt_Low', pin.createdFrom), event('evt_High')]),
    page([{ ...event(), object: 'customer' }]), page([{ ...event(), account: 'acct_Other' }]),
    page([{ ...event(), livemode: true }]), page([event('evt_Old', pin.createdFrom - 1)]),
    page([event('evt_New', pin.createdBefore)]), page([{ ...event(), created: 1.5 }]),
    page([{ ...event(), id: 'evt_bad/path' }]), page([{ ...event(), data: null }]),
    page([{ ...event(), data: { object: { ...event().data.object, metadata: { organizationId: '22222222-2222-4333-8444-555555555555' } } } }]),
  ])('discards the entire page on malformed, overlapping or foreign evidence', async body => {
    const r = reader([account, customer, body]);
    const result = await r.client.readBillingEventPage(pin);
    expect(result).toMatchObject({ ok: false, code: 'malformed-response' });
    expect(result).not.toHaveProperty('evidence');
  });

  it('refuses a non-advancing cursor and missing request provenance', async () => {
    const r = reader([account, customer, page([event()])]);
    expect(await r.client.readBillingEventPage({ ...pin, startingAfter: event().id })).toMatchObject({ ok: false });
    const missing = reader([account, customer, page([event()])], { noRequestIdAt: 2 });
    expect(await missing.client.readBillingEventPage(pin)).toMatchObject({ ok: false });
  });

  it('returns a fixed provider failure and honors cancellation without leaking response content', async () => {
    const r = reader([account, customer, { private: 'private@example.test sk_test_recovery' }], { statusAt: 2 });
    const result = await r.client.readBillingEventPage(pin);
    expect(result).toEqual({ ok: false, code: 'provider-error', status: 503, detail: 'stripe authenticated read failed' });
    const canceled = reader([]); const abort = new AbortController(); abort.abort();
    expect(await canceled.client.readBillingEventPage(pin, abort.signal)).toMatchObject({ ok: false, code: 'provider-error' });
    expect(canceled.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('requests', () => {
  function client(responses: Array<{ status?: number; body: unknown }>) {
    const fake = fakeFetch(responses);
    const built = createStripeBillingClient({ secretKey: 'sk_test_key', fetchImpl: fake.impl, liveModeAllowed: false });
    if (!built.ok) throw new Error('client');
    return { client: built.client, calls: fake.calls };
  }

  it('creates one customer per org with an org-scoped idempotency key', async () => {
    const { client: c, calls } = client([{ body: { id: 'cus_123' } }]);
    expect(await c.createCustomer({ organizationId: ORG, email: 'a@example.com' })).toEqual({ ok: true, customerId: 'cus_123' });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/customers');
    expect(calls[0]!.headers['idempotency-key']).toBe(`papercusp-org-customer:${ORG}`);
    expect(calls[0]!.form.get('metadata[organizationId]')).toBe(ORG);
    expect(calls[0]!.form.has('name')).toBe(false);
  });

  it('starts a subscription Checkout carrying the org on the session AND the subscription', async () => {
    const { client: c, calls } = client([{ body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' } }]);
    const result = await c.createSubscriptionCheckout({
      customerId: 'cus_1', organizationId: ORG, priceId: 'price_team',
      successUrl: 'https://app.example/billing?checkout=success', cancelUrl: 'https://app.example/billing?checkout=canceled',
      idempotencyKey: 'k1',
    });
    expect(result).toEqual({ ok: true, sessionId: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    const form = calls[0]!.form;
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('customer')).toBe('cus_1');
    expect(form.get('line_items[0][price]')).toBe('price_team');
    expect(form.get('subscription_data[metadata][organizationId]')).toBe(ORG);
    expect(form.get('client_reference_id')).toBe(ORG);
    expect(calls[0]!.headers['idempotency-key']).toBe('k1');
  });

  it('opens a customer-portal session and surfaces provider errors without echoing the body', async () => {
    const { client: c, calls } = client([
      { body: { url: 'https://billing.stripe.com/p/session_1' } },
      { status: 400, body: { error: { message: 'No such customer' } } },
    ]);
    expect(await c.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/billing' })).toEqual({ ok: true, url: 'https://billing.stripe.com/p/session_1' });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(await c.createPortalSession({ customerId: 'cus_x', returnUrl: 'https://app.example/billing' })).toEqual({ ok: false, code: 'provider-error', status: 400, detail: 'No such customer' });
  });

  it('sends an explicit portal configuration only when one is configured', async () => {
    const { client: c, calls } = client([
      { body: { url: 'https://billing.stripe.com/p/session_2' } },
      { body: { url: 'https://billing.stripe.com/p/session_3' } },
    ]);
    await c.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/billing', configurationId: 'bpc_123' });
    await c.createPortalSession({ customerId: 'cus_1', returnUrl: 'https://app.example/billing', configurationId: null });
    expect(calls[0]!.form.get('configuration')).toBe('bpc_123');
    expect(calls[1]!.form.has('configuration')).toBe(false);
  });

  it('a response without the expected id is malformed, not success', async () => {
    const { client: c } = client([{ body: { object: 'customer' } }]);
    expect(await c.createCustomer({ organizationId: ORG })).toMatchObject({ ok: false, code: 'malformed-response' });
  });
});

describe('authenticated account cash evidence', () => {
  const pin = { accountId: 'acct_A', customerId: 'cus_A', organizationId: ORG };
  const account = { object: 'account', id: 'acct_A' };
  const customer = { object: 'customer', id: 'cus_A', livemode: true, metadata: { organizationId: ORG } };
  const balance = { object: 'balance', livemode: true,
    available: [{ currency: 'usd', amount: 50 }], pending: [{ currency: 'usd', amount: 900 }] };
  function reader(bodies: unknown[] = [account, customer, balance], headers = true, status = 200) {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bodies.shift()), {
      status, headers: headers ? { 'request-id': 'req_Proof' } : {},
    })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const options = { secretKey: 'sk_live_key', fetchImpl, liveModeAllowed: true };
    const result = createStripeBillingClient(options);
    if (!result.ok) throw new Error('reader');
    return { client: result.client, fetchImpl, options };
  }

  it('pins credential account and org customer, preserving available and pending cash separately', async () => {
    const r = reader();
    const result = await r.client.readAccountCash(pin);
    expect(result).toMatchObject({ ok: true, evidence: { ...pin, livemode: true,
      availableUsdCents: 50, pendingUsdCents: 900, requestIds: ['req_Proof', 'req_Proof', 'req_Proof'],
      evidenceRef: expect.stringMatching(/^stripe-cash:[a-f0-9]{64}$/) } });
    expect(r.fetchImpl.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'https://api.stripe.com/v1/account', 'https://api.stripe.com/v1/customers/cus_A', 'https://api.stripe.com/v1/balance',
    ]);
    for (const [, init] of r.fetchImpl.mock.calls) expect(init).toEqual({ method: 'GET', redirect: 'error', headers: { authorization: 'Bearer sk_live_key' }, signal: expect.any(AbortSignal) });
    if (result.ok) { expect(Object.isFrozen(result.evidence)).toBe(true); expect(Object.isFrozen(result.evidence.requestIds)).toBe(true); }
    expect(JSON.stringify(result)).not.toContain('sk_live_key');
  });

  it('refuses a foreign credential account before reading customer or balance', async () => {
    const r = reader([{ ...account, id: 'acct_B' }]);
    expect(await r.client.readAccountCash(pin)).toMatchObject({ ok: false, detail: 'stripe account pin mismatch' });
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...customer, id: 'cus_B' }, { ...customer, livemode: false }, { ...customer, deleted: true },
    { ...customer, metadata: { organizationId: 'other' } }, { ...customer, metadata: null },
  ])('refuses unbound, test, deleted or foreign-org customers', async c => {
    const r = reader([account, c]);
    expect(await r.client.readAccountCash(pin)).toMatchObject({ ok: false, detail: 'stripe customer pin mismatch' });
    expect(r.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...balance, livemode: false }, { ...balance, available: null }, { ...balance, pending: null },
    { ...balance, available: [{ currency: 'usd', amount: '50' }] },
    { ...balance, available: [{ currency: 'usd', amount: 0.1 }] },
    { ...balance, available: [{ currency: 'usd', amount: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...balance, available: [{ currency: 'usd', amount: 1 }, { currency: 'usd', amount: 2 }] },
    { ...balance, available: [{ currency: 'usd', amount: 1 }, { currency: 'eur', amount: 'unknown' }] },
  ])('refuses malformed or wrong-mode balance populations', async b => {
    expect(await reader([account, customer, b]).client.readAccountCash(pin)).toMatchObject({ ok: false, detail: 'unverified stripe cash balance' });
  });

  it('keeps negative available cash and ignores foreign currency as USD backing', async () => {
    const b = { ...balance, available: [{ currency: 'usd', amount: -5 }, { currency: 'eur', amount: 1000 }] };
    expect(await reader([account, customer, b]).client.readAccountCash(pin))
      .toMatchObject({ ok: true, evidence: { availableUsdCents: -5, pendingUsdCents: 900 } });
    expect(await reader([account, customer, { ...balance, available: [] }]).client.readAccountCash(pin))
      .toMatchObject({ ok: true, evidence: { availableUsdCents: 0 } });
  });

  it('refuses missing request provenance and sanitizes failed provider reads', async () => {
    expect(await reader([account], false).client.readAccountCash(pin)).toMatchObject({ ok: false, code: 'malformed-response' });
    const result = await reader([{ error: { message: 'sk_live_key private payload' } }], true, 401).client.readAccountCash(pin);
    expect(result).toMatchObject({ ok: false, code: 'provider-error', status: 401 });
    expect(JSON.stringify(result)).not.toContain('sk_live_key');
  });

  it('pins composition credentials and request scope before asynchronous provider reads', async () => {
    const r = reader();
    const input = { ...pin };
    const pending = r.client.readAccountCash(input);
    input.customerId = 'cus_B'; input.organizationId = 'other';
    r.options.secretKey = 'sk_live_changed';
    const result = await pending;
    expect(result).toMatchObject({ ok: true, evidence: pin });
    expect(r.fetchImpl.mock.calls[1][0]).toBe('https://api.stripe.com/v1/customers/cus_A');
    for (const [, init] of r.fetchImpl.mock.calls) expect(init.headers.authorization).toBe('Bearer sk_live_key');
  });

  const transaction = (id = 'txn_A', overrides: Record<string, unknown> = {}) => ({
    object: 'balance_transaction', id, type: 'charge', amount: 100, fee: 3, net: 97,
    currency: 'usd', created: 1, available_on: 2, status: 'available',
    source: { id: 'ch_A', object: 'charge', customer: 'cus_A', metadata: { purpose: 'prepaid-credits' } }, ...overrides,
  });
  const page = (data: unknown[], has_more = false) => ({ object: 'list', data, has_more });

  it('reads every page across all customers/types/currencies, preserving unknown obligations and provenance', async () => {
    const first = transaction(); const second = transaction('txn_B', { type: 'new_provider_obligation', currency: 'eur' });
    const r = reader([account, page([first], true), page([second])]);
    const result = await r.client.readAccountTransactions({ accountId: 'acct_A' });
    expect(result).toMatchObject({ ok: true, evidence: { accountId: 'acct_A', transactions: [first, second],
      requestIds: ['req_Proof', 'req_Proof', 'req_Proof'], evidenceRef: expect.stringMatching(/^stripe-census:[a-f0-9]{64}$/) } });
    if (result.ok) {
      expect(Object.isFrozen(result.evidence.transactions)).toBe(true);
      expect(Object.isFrozen(result.evidence.transactions[0].source)).toBe(true);
      expect(result.evidence.transactions[0].status).toBe('available');
    }
    const queries = r.fetchImpl.mock.calls.slice(1).map(call => new URL(String(call[0])).searchParams);
    expect(queries[0].get('starting_after')).toBeNull();
    expect(queries[1].get('starting_after')).toBe('txn_A');
    for (const q of queries) {
      expect([...q.keys()]).toEqual(expect.arrayContaining(['limit', 'expand[]']));
      expect(q.getAll('expand[]')).toEqual(['data.source', 'data.source.invoice']);
      for (const filter of ['customer', 'source', 'currency', 'type', 'created[gte]']) expect(q.has(filter)).toBe(false);
    }
  });

  it('accepts an explicitly empty complete account but refuses an empty nonterminal page', async () => {
    expect(await reader([account, page([])]).client.readAccountTransactions({ accountId: 'acct_A' }))
      .toMatchObject({ ok: true, evidence: { transactions: [] } });
    expect(await reader([account, page([], true)]).client.readAccountTransactions({ accountId: 'acct_A' }))
      .toMatchObject({ ok: false, detail: 'incomplete stripe transaction page' });
  });

  it('refuses a repeated cursor/transaction and discards a truncated census', async () => {
    expect(await reader([account, page([transaction()], true), page([transaction()])])
      .client.readAccountTransactions({ accountId: 'acct_A' })).toMatchObject({ ok: false, detail: 'invalid or duplicate stripe transaction' });
    expect(await reader([account, page([transaction()], true)]).client.readAccountTransactions({ accountId: 'acct_A', maxPages: 1 }))
      .toMatchObject({ ok: false, detail: 'stripe transaction census exceeds page budget' });
  });

  it.each([
    { id: 'txn_bad/path' }, { net: 98 }, { amount: '100' }, { fee: -1 }, { status: 'unknown' },
    { currency: 'USD' }, { created: -1 }, { available_on: null }, { object: 'charge' },
  ])('rejects malformed transaction accounting or availability', async change => {
    expect(await reader([account, page([transaction('txn_A', change)])]).client.readAccountTransactions({ accountId: 'acct_A' }))
      .toMatchObject({ ok: false, detail: 'invalid or duplicate stripe transaction' });
  });

  it('does not return partial evidence when a later page fails', async () => {
    const r = reader([account, page([transaction()], true)]);
    expect(await r.client.readAccountTransactions({ accountId: 'acct_A' })).toMatchObject({ ok: false });
  });
});

describe('authenticated Stripe read cancellation', () => {
  const pin = { accountId: 'acct_A', customerId: 'cus_A', organizationId: ORG };
  const refusal = { ok: false, code: 'provider-error', status: null, detail: 'stripe authenticated read failed' };

  it.each([0, -1, 0.5, NaN, Infinity, 10_001])('refuses an invalid request deadline %s', readTimeoutMs => {
    const fetchImpl = vi.fn();
    expect(createStripeBillingClient({ secretKey: 'sk_live_key', liveModeAllowed: true,
      fetchImpl: fetchImpl as typeof fetch, readTimeoutMs })).toEqual({ ok: false, code: 'invalid_read_timeout' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'body'] as const)('aborts a stalled %s and clears the request timer', async phase => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let pendingIo = false;
      const fetchImpl = vi.fn(async (_url, init) => {
        signal = init?.signal as AbortSignal;
        const stall = () => new Promise<never>((_resolve, reject) => {
          pendingIo = true;
          signal!.addEventListener('abort', () => { pendingIo = false; reject(new Error('private provider error')); }, { once: true });
        });
        if (phase === 'fetch') return stall();
        const response = new Response('{}', { headers: { 'request-id': 'req_Proof' } });
        response.json = stall;
        return response;
      }) as typeof fetch;
      const built = createStripeBillingClient({ secretKey: 'sk_live_key', fetchImpl, liveModeAllowed: true, readTimeoutMs: 20 });
      if (!built.ok) throw new Error('fixture');
      const pending = built.client.readAccountCash(pin);
      await vi.advanceTimersByTimeAsync(19);
      expect(pendingIo).toBe(true);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual(refusal);
      expect(signal?.aborted).toBe(true);
      expect(pendingIo).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('refuses a pre-cancelled request without invoking the transport', async () => {
    const fetchImpl = vi.fn();
    const built = createStripeBillingClient({ secretKey: 'sk_live_key', fetchImpl: fetchImpl as typeof fetch, liveModeAllowed: true });
    if (!built.ok) throw new Error('fixture');
    const parent = new AbortController(); parent.abort(new Error('private cancellation reason'));
    expect(await built.client.readAccountCash(pin, parent.signal)).toEqual(refusal);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['caller', 'error-status'] as const)('closes an actual streaming response connection on %s', async reason => {
    let bodyOpened!: () => void;
    const opened = new Promise<void>(resolve => { bodyOpened = resolve; });
    let connectionClosed!: () => void;
    const closed = new Promise<void>(resolve => { connectionClosed = resolve; });
    const server = createServer((_request, response) => {
      response.on('close', connectionClosed);
      response.writeHead(reason === 'caller' ? 200 : 503, { 'content-type': 'application/json', 'request-id': 'req_Proof' });
      response.write('{');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture');
    const parent = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => {
      const response = await fetch(`http://127.0.0.1:${address.port}`, init);
      bodyOpened();
      return response;
    };
    try {
      const built = createStripeBillingClient({ secretKey: 'sk_live_key', fetchImpl, liveModeAllowed: true });
      if (!built.ok) throw new Error('fixture');
      const pending = built.client.readAccountCash(pin, parent.signal);
      await opened;
      if (reason === 'caller') parent.abort(new Error('private cancellation reason'));
      expect(await pending).toEqual({ ...refusal, status: reason === 'caller' ? null : 503 });
      await closed;
    } finally {
      parent.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('refuses a completed response past its monotonic deadline even before the timer fires', async () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const fetchImpl = vi.fn(async () => {
        elapsed = 20;
        return new Response(JSON.stringify({ object: 'account', id: 'acct_A' }), { headers: { 'request-id': 'req_Proof' } });
      }) as typeof fetch;
      const built = createStripeBillingClient({ secretKey: 'sk_live_key', fetchImpl, liveModeAllowed: true, readTimeoutMs: 20 });
      if (!built.ok) throw new Error('fixture');
      expect(await built.client.readAccountCash(pin)).toEqual(refusal);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
});

describe('authenticated complete payment source enumeration', () => {
  const account = { object: 'account', id: 'acct_A' };
  const charge = { object: 'charge', id: 'ch_A', customer: 'cus_A', currency: 'usd', amount: 100,
    amount_captured: 100, amount_refunded: 40, paid: true, captured: true, status: 'succeeded', created: 1,
    livemode: true, balance_transaction: 'txn_Charge', failure_balance_transaction: null,
    receipt_email: 'private@example.com', payment_method_details: { card: { last4: '1234' } } };
  const refund = { object: 'refund', id: 're_A', charge: 'ch_A', currency: 'usd', amount: 40,
    status: 'pending', created: 2, balance_transaction: null, failure_balance_transaction: null,
    destination_details: { private: 'refund destination' } };
  const dispute = { object: 'dispute', id: 'du_A', charge: 'ch_A', currency: 'usd', amount: 100,
    status: 'needs_response', created: 3, livemode: true, balance_transactions: [],
    evidence: { private: 'customer private dispute content' } };
  const page = (data: unknown[], has_more = false) => ({ object: 'list', data, has_more });
  function reader(overrides: Record<string, unknown[] | undefined> = {}, options: { status?: number; requestId?: string | null; mode?: 'live' | 'test' } = {}) {
    const bodies = { '/v1/account': [account], '/v1/charges': [page([charge])],
      '/v1/refunds': [page([refund])], '/v1/disputes': [page([dispute])], ...overrides };
    const fetchImpl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const queue = bodies[new URL(String(url)).pathname as keyof typeof bodies];
      const body = queue?.shift();
      return new Response(JSON.stringify(body ?? { error: 'private sk_live_key' }), {
        status: options.status ?? (body ? 200 : 404),
        headers: options.requestId === null ? {} : { 'request-id': options.requestId ?? 'req_Source' },
      });
    });
    const composition = { secretKey: `sk_${options.mode ?? 'live'}_key`, fetchImpl: fetchImpl as typeof fetch, liveModeAllowed: true };
    const built = createStripeBillingClient(composition);
    if (!built.ok) throw new Error('reader');
    return { client: built.client, fetchImpl, composition };
  }

  it('exhausts each endpoint without customer/date/status filters and retains unposted reversals', async () => {
    const secondCharge = { ...charge, id: 'ch_B', customer: 'cus_B', balance_transaction: 'txn_B', amount_refunded: 0 };
    const secondRefund = { ...refund, id: 're_B', charge: 'ch_B', status: 'requires_action' };
    const secondDispute = { ...dispute, id: 'du_B', charge: 'ch_B', status: 'warning_under_review' };
    const r = reader({ '/v1/charges': [page([charge], true), page([secondCharge])],
      '/v1/refunds': [page([refund], true), page([secondRefund])],
      '/v1/disputes': [page([dispute], true), page([secondDispute])] });
    const result = await r.client.readAccountPaymentSources({ accountId: 'acct_A' });
    expect(result).toMatchObject({ ok: true, evidence: { accountId: 'acct_A', livemode: true,
      charges: [{ id: 'ch_A', customerId: 'cus_A', balanceTransactionId: 'txn_Charge' }, { id: 'ch_B', customerId: 'cus_B' }],
      refunds: [{ id: 're_A', status: 'pending', balanceTransactionId: null }, { id: 're_B', status: 'requires_action' }],
      disputes: [{ id: 'du_A', balanceTransactionIds: [] }, { id: 'du_B', status: 'warning_under_review' }],
      requestIds: Array(7).fill('req_Source'), evidenceRef: expect.stringMatching(/^stripe-payment-sources:[a-f0-9]{64}$/) } });
    expect(r.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v1/account', '/v1/charges', '/v1/charges', '/v1/refunds', '/v1/refunds', '/v1/disputes', '/v1/disputes',
    ]);
    const cursors = [null, 'ch_A', null, 're_A', null, 'du_A'];
    for (const [i, [url, init]] of r.fetchImpl.mock.calls.slice(1).entries()) {
      const q = new URL(String(url)).searchParams;
      expect([...q.keys()].sort()).toEqual(cursors[i] === null ? ['limit'] : ['limit', 'starting_after']);
      expect(q.get('limit')).toBe('100'); expect(q.get('starting_after')).toBe(cursors[i]);
      expect(init).toEqual({ method: 'GET', redirect: 'error', headers: { authorization: 'Bearer sk_live_key' }, signal: expect.any(AbortSignal) });
    }
    if (result.ok) {
      expect(result.evidence.collectionStartedAtMs).toBeLessThanOrEqual(result.evidence.observedAtMs);
      expect(Object.isFrozen(result.evidence.charges[0])).toBe(true);
      expect(Object.isFrozen(result.evidence.disputes[0].balanceTransactionIds)).toBe(true);
      const { evidenceRef, ...selected } = result.evidence;
      expect(evidenceRef).toBe(`stripe-payment-sources:${createHash('sha256').update(JSON.stringify(selected)).digest('hex')}`);
    }
    expect(JSON.stringify(result)).not.toMatch(/private|last4|receipt_email|payment_method_details|destination_details|sk_live/);
  });

  it('preserves failed refunds and reinstated disputes instead of converting terminal labels to finality', async () => {
    const result = await reader({ '/v1/refunds': [page([{ ...refund, status: 'failed', balance_transaction: 'txn_Refund',
      failure_balance_transaction: 'txn_Failure' }])], '/v1/disputes': [page([{ ...dispute, status: 'won',
      balance_transactions: [{ id: 'txn_Dispute', amount: 999 }, { id: 'txn_Restored', amount: 999 }] }])] })
      .client.readAccountPaymentSources({ accountId: 'acct_A' });
    expect(result).toMatchObject({ ok: true, evidence: {
      refunds: [{ status: 'failed', balanceTransactionId: 'txn_Refund', failureBalanceTransactionId: 'txn_Failure' }],
      disputes: [{ status: 'won', balanceTransactionIds: ['txn_Dispute', 'txn_Restored'] }],
    } });
    expect(JSON.stringify(result)).not.toMatch(/providerFinal|complete|amount.:999/);
  });

  it('retains failed/uncaptured/customerless/foreign-currency charges for reconciliation', async () => {
    const declined = { ...charge, customer: null, currency: 'eur', amount_captured: 0, amount_refunded: 0,
      status: 'failed', paid: false, captured: false, balance_transaction: null };
    const result = await reader({ '/v1/charges': [page([declined])], '/v1/refunds': [page([])], '/v1/disputes': [page([])] })
      .client.readAccountPaymentSources({ accountId: 'acct_A' });
    expect(result).toMatchObject({ ok: true, evidence: { charges: [{ customerId: null, currency: 'eur', status: 'failed',
      capturedCents: 0, paid: false, captured: false, balanceTransactionId: null }] } });
  });

  it('accepts explicitly exhausted empty lists without inventing a paid population', async () => {
    expect(await reader({ '/v1/charges': [page([])], '/v1/refunds': [page([])], '/v1/disputes': [page([])] })
      .client.readAccountPaymentSources({ accountId: 'acct_A' }))
      .toMatchObject({ ok: true, evidence: { charges: [], refunds: [], disputes: [] } });
  });

  it.each(['/v1/charges', '/v1/refunds', '/v1/disputes'])('refuses an unfinished or repeated %s page and discards earlier endpoints', async path => {
    const row = path === '/v1/charges' ? charge : path === '/v1/refunds' ? refund : dispute;
    for (const pages of [[page([], true)], [page([row], true), page([row])], [page([row], true)]]) {
      const result = await reader({ [path]: pages }).client.readAccountPaymentSources({ accountId: 'acct_A' });
      expect(result).toMatchObject({ ok: false }); expect(result).not.toHaveProperty('evidence');
    }
    expect(await reader({ [path]: [page([row], true)] }).client.readAccountPaymentSources({ accountId: 'acct_A', maxPages: 1 }))
      .toMatchObject({ ok: false, detail: 'stripe payment source census exceeds page budget' });
  });

  it.each([
    { object: 'charge' }, { has_more: 'false' }, { data: null }, { data: [null] },
    { url: '/v1/customers' }, { data: Array(101).fill(charge) },
  ])('refuses malformed/misdirected/over-limit pages', async change => {
    expect(await reader({ '/v1/charges': [{ ...page([charge]), ...change }] })
      .client.readAccountPaymentSources({ accountId: 'acct_A' })).toMatchObject({ ok: false });
  });

  it.each([
    { id: 'ch_bad/path' }, { object: 'refund' }, { livemode: false }, { customer: 'cus_bad/path' }, { customer: { id: null } },
    { amount: '100' }, { amount: -1 }, { amount_captured: 101 }, { amount_refunded: 101 },
    { amount_captured: 0.1 }, { paid: 'true' }, { captured: undefined }, { status: 'unknown' },
    { currency: 'USD' }, { created: -1 }, { created: Number.MAX_SAFE_INTEGER },
    { balance_transaction: undefined }, { balance_transaction: 'txn_bad/path' }, { failure_balance_transaction: { id: 'bad' } },
  ])('refuses malformed or wrong-mode charge accounting', async change => {
    expect(await reader({ '/v1/charges': [page([{ ...charge, ...change }])] })
      .client.readAccountPaymentSources({ accountId: 'acct_A' })).toMatchObject({ ok: false });
  });

  it.each([
    { id: 're_bad/path' }, { object: 'dispute' }, { charge: 'ch_missing' }, { charge: 'ch_bad/path' },
    { currency: 'eur' }, { amount: 101 }, { amount: 0 }, { created: 0 }, { status: 'unknown' },
    { balance_transaction: undefined }, { balance_transaction: 'txn_bad/path' },
    { status: 'succeeded' }, { status: 'failed', balance_transaction: 'txn_Refund' },
    { failure_balance_transaction: 'txn_Failure' },
  ])('refuses malformed, unbound or incomplete refund source evidence', async change => {
    expect(await reader({ '/v1/refunds': [page([{ ...refund, ...change }])] })
      .client.readAccountPaymentSources({ accountId: 'acct_A' })).toMatchObject({ ok: false });
  });

  it.each([
    { object: 'refund' }, { livemode: false }, { charge: 'ch_missing' }, { currency: 'eur' },
    { amount: 101 }, { created: 0 }, { status: 'unknown' }, { balance_transactions: null },
    { balance_transactions: [null] }, { balance_transactions: ['txn_bad/path'] },
    { balance_transactions: ['txn_One', 'txn_Two', 'txn_Three'] },
  ])('refuses malformed or unbound disputes', async change => {
    expect(await reader({ '/v1/disputes': [page([{ ...dispute, ...change }])] })
      .client.readAccountPaymentSources({ accountId: 'acct_A' })).toMatchObject({ ok: false });
  });

  it.each([
    { '/v1/charges': [page([charge, { ...charge, id: 'ch_B' }])] },
    { '/v1/charges': [page([{ ...charge, failure_balance_transaction: 'txn_Charge' }])] },
    { '/v1/refunds': [page([{ ...refund, balance_transaction: 'txn_Charge' }])] },
    { '/v1/refunds': [page([{ ...refund, status: 'failed', balance_transaction: 'txn_Refund', failure_balance_transaction: 'txn_Refund' }])] },
    { '/v1/disputes': [page([{ ...dispute, balance_transactions: ['txn_Charge'] }])] },
    { '/v1/disputes': [page([{ ...dispute, balance_transactions: ['txn_Dispute', 'txn_Dispute'] }])] },
    { '/v1/refunds': [page([{ ...refund, balance_transaction: 'txn_Shared' }])],
      '/v1/disputes': [page([{ ...dispute, balance_transactions: ['txn_Shared'] }])] },
  ])('rejects aliased movement pins across the complete account population', async overrides => {
    expect(await reader(overrides).client.readAccountPaymentSources({ accountId: 'acct_A' }))
      .toMatchObject({ ok: false, detail: 'duplicate stripe payment source movement' });
  });

  it('fails closed for a different own account, missing provenance or later provider error', async () => {
    for (const r of [reader({ '/v1/account': [{ ...account, id: 'acct_B' }] }), reader({}, { requestId: null }),
      reader({ '/v1/disputes': [] }), reader({}, { status: 403 })]) {
      const result = await r.client.readAccountPaymentSources({ accountId: 'acct_A' });
      expect(result).toMatchObject({ ok: false }); expect(result).not.toHaveProperty('evidence');
      expect(JSON.stringify(result)).not.toMatch(/private|sk_live/);
    }
  });

  it('binds test-mode refunds through their original test charge', async () => {
    const result = await reader({ '/v1/charges': [page([{ ...charge, livemode: false }])],
      '/v1/disputes': [page([{ ...dispute, livemode: false }])] }, { mode: 'test' })
      .client.readAccountPaymentSources({ accountId: 'acct_A' });
    expect(result).toMatchObject({ ok: true, evidence: { livemode: false, refunds: [{ id: 're_A' }] } });
  });

  it.each([{ accountId: 'acct_bad/path' }, { accountId: 'acct_A', maxPages: 0 }, { accountId: 'acct_A', maxPages: 0.1 }])
    ('refuses malformed scope/page bounds before any provider read', async input => {
      const r = reader(); expect(await r.client.readAccountPaymentSources(input)).toMatchObject({ ok: false });
      expect(r.fetchImpl).not.toHaveBeenCalled();
    });

  it('pins mutable scope, page bound and injected credentials before awaits', async () => {
    const r = reader({ '/v1/refunds': [page([refund], true), page([])] });
    const input = { accountId: 'acct_A', maxPages: 2 };
    const pending = r.client.readAccountPaymentSources(input);
    input.accountId = 'acct_B'; input.maxPages = 1; r.composition.secretKey = 'sk_live_changed';
    expect(await pending).toMatchObject({ ok: true, evidence: { accountId: 'acct_A' } });
    for (const [, init] of r.fetchImpl.mock.calls) expect(init?.headers).toEqual({ authorization: 'Bearer sk_live_key' });
  });
});

describe('authenticated original payment and reversal lineage', () => {
  const pin: StripePaymentLineagePin = { accountId: 'acct_A', customerId: 'cus_A', organizationId: ORG,
    chargeId: 'ch_A', chargeBalanceTransactionId: 'txn_Charge', source: { kind: 'refund', id: 're_A' } };
  const charge = { object: 'charge', id: 'ch_A', customer: 'cus_A', livemode: true, currency: 'usd',
    status: 'succeeded', paid: true, captured: true, amount: 100, amount_captured: 100, amount_refunded: 40,
    balance_transaction: 'txn_Charge', receipt_email: 'private@example.com', metadata: { secret: 'private' } };
  const refund = { object: 'refund', id: 're_A', charge: 'ch_A', amount: 40, currency: 'usd',
    status: 'succeeded', balance_transaction: 'txn_Refund', failure_balance_transaction: null,
    destination_details: { private: 'private' } };
  const dispute = { object: 'dispute', id: 'du_A', charge: 'ch_A', amount: 100, currency: 'usd', livemode: true,
    status: 'won', balance_transactions: [{ id: 'txn_Dispute' }, { id: 'txn_Reinstated' }], evidence: { private: 'private' } };
  const bt = (id: string, source: string, type: string, amount: number, fee = 0) => ({
    object: 'balance_transaction', id, source, type, amount, fee, net: amount - fee,
    currency: 'usd', created: 1, available_on: 2, status: 'available', description: 'private',
  });
  function reader(overrides: Record<string, unknown> = {}, responseOptions: { status?: number; requestId?: string | null } = {}) {
    const responses: Record<string, unknown> = {
      '/account': { object: 'account', id: 'acct_A' },
      '/customers/cus_A': { object: 'customer', id: 'cus_A', livemode: true, metadata: { organizationId: ORG } },
      '/charges/ch_A': charge, '/refunds/re_A': refund, '/disputes/du_A': dispute,
      '/balance_transactions/txn_Charge': bt('txn_Charge', 'ch_A', 'charge', 100, 3),
      '/balance_transactions/txn_Refund': bt('txn_Refund', 're_A', 'refund', -40),
      '/balance_transactions/txn_Failure': bt('txn_Failure', 're_A', 'refund_failure', 40),
      '/balance_transactions/txn_Dispute': bt('txn_Dispute', 'du_A', 'adjustment', -100, 15),
      '/balance_transactions/txn_Reinstated': bt('txn_Reinstated', 'du_A', 'adjustment', 100), ...overrides,
    };
    const fetchImpl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const body = responses[new URL(String(url)).pathname.slice('/v1'.length)];
      return new Response(JSON.stringify(body ?? { error: 'private sk_live_key' }), {
        status: responseOptions.status ?? (body ? 200 : 404),
        headers: responseOptions.requestId === null ? {} : { 'request-id': responseOptions.requestId ?? 'req_Lineage' },
      });
    });
    const options = { secretKey: 'sk_live_key', fetchImpl: fetchImpl as typeof fetch, liveModeAllowed: true };
    const built = createStripeBillingClient(options);
    if (!built.ok) throw new Error('reader');
    return { client: built.client, fetchImpl, options };
  }
  const disputePin: StripePaymentLineagePin = { ...pin, source: { kind: 'dispute', id: 'du_A' } };

  it('retrieves the original receipt pins and refund debit without leaking private provider fields', async () => {
    const r = reader(); const result = await r.client.readPaymentLineage(pin);
    expect(result).toMatchObject({ ok: true, evidence: { accountId: 'acct_A', customerId: 'cus_A', organizationId: ORG,
      livemode: true, charge: { id: 'ch_A', capturedUsdCents: 100, refundedUsdCents: 40,
        balanceTransaction: { id: 'txn_Charge', source: 'ch_A', amount: 100, fee: 3, net: 97 } },
      source: { kind: 'refund', id: 're_A', status: 'succeeded', amountUsdCents: 40,
        balanceTransactions: [{ id: 'txn_Refund', source: 're_A', amount: -40, net: -40 }] },
      evidenceRef: expect.stringMatching(/^stripe-lineage:[a-f0-9]{64}$/) } });
    expect(r.fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v1/account', '/v1/customers/cus_A', '/v1/refunds/re_A', '/v1/charges/ch_A',
      '/v1/balance_transactions/txn_Charge', '/v1/balance_transactions/txn_Refund',
    ]);
    for (const [, init] of r.fetchImpl.mock.calls) expect(init).toEqual({ method: 'GET', redirect: 'error', headers: { authorization: 'Bearer sk_live_key' }, signal: expect.any(AbortSignal) });
    expect(JSON.stringify(result)).not.toMatch(/private|receipt_email|destination_details|sk_live/);
    if (result.ok) {
      expect(Object.isFrozen(result.evidence.charge.balanceTransaction)).toBe(true);
      expect(Object.isFrozen(result.evidence.source.balanceTransactions)).toBe(true);
      expect(result.evidence.requestIds).toHaveLength(6);
    }
  });

  it('resolves a charge directly and preserves pending availability instead of declaring cash available', async () => {
    const original = bt('txn_Charge', 'ch_A', 'charge', 100, 3);
    const result = await reader({ '/balance_transactions/txn_Charge': { ...original, status: 'pending' } }).client
      .readPaymentLineage({ ...pin, source: { kind: 'charge', id: 'ch_A' } });
    expect(result).toMatchObject({ ok: true, evidence: { source: { kind: 'charge', status: 'succeeded',
      balanceTransactions: [{ id: 'txn_Charge', status: 'pending' }] } } });
  });

  it('preserves both failed-refund debit and reinstatement instead of erasing the original movement', async () => {
    const result = await reader({ '/refunds/re_A': { ...refund, status: 'failed', failure_balance_transaction: 'txn_Failure' } })
      .client.readPaymentLineage(pin);
    expect(result).toMatchObject({ ok: true, evidence: { source: { status: 'failed', balanceTransactions: [
      { id: 'txn_Refund', amount: -40 }, { id: 'txn_Failure', amount: 40 },
    ] } } });
  });

  it.each(['pending', 'requires_action', 'failed', 'canceled'])('keeps an unposted %s refund explicit', async status => {
    const result = await reader({ '/refunds/re_A': { ...refund, status, balance_transaction: null } }).client.readPaymentLineage(pin);
    expect(result).toMatchObject({ ok: true, evidence: { source: { status, amountUsdCents: 40, balanceTransactions: [] } } });
  });

  it('binds a won dispute to its original charge while retaining debit, fee and reinstatement', async () => {
    const result = await reader().client.readPaymentLineage(disputePin);
    expect(result).toMatchObject({ ok: true, evidence: { source: { kind: 'dispute', status: 'won', balanceTransactions: [
      { id: 'txn_Dispute', amount: -100, fee: 15, net: -115 }, { id: 'txn_Reinstated', amount: 100, net: 100 },
    ] } } });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each(['warning_needs_response', 'under_review', 'won', 'lost', 'prevented'])('does not infer a posted movement from dispute status %s', async status => {
    expect(await reader({ '/disputes/du_A': { ...dispute, status, balance_transactions: [] } }).client.readPaymentLineage(disputePin))
      .toMatchObject({ ok: true, evidence: { source: { status, balanceTransactions: [] } } });
  });

  it.each([
    { '/account': { object: 'account', id: 'acct_B' } },
    { '/customers/cus_A': { object: 'customer', id: 'cus_A', livemode: true, metadata: { organizationId: 'foreign' } } },
    { '/refunds/re_A': { ...refund, charge: 'ch_B' } },
    { '/refunds/re_A': { ...refund, customer: 'cus_B' } },
    { '/charges/ch_A': { ...charge, customer: 'cus_B' } },
    { '/charges/ch_A': { ...charge, livemode: false } },
    { '/charges/ch_A': { ...charge, balance_transaction: 'txn_Other' } },
    { '/balance_transactions/txn_Charge': bt('txn_Charge', 'ch_B', 'charge', 100, 3) },
    { '/balance_transactions/txn_Refund': bt('txn_Refund', 're_B', 'refund', -40) },
  ])('refuses foreign account, org, customer, receipt or movement substitutions', async overrides => {
    expect(await reader(overrides).client.readPaymentLineage(pin)).toMatchObject({ ok: false, code: 'malformed-response' });
  });

  it.each([
    { currency: 'eur' }, { paid: false }, { captured: false }, { status: 'failed' }, { amount_captured: 0 },
    { amount_captured: 101 }, { amount_refunded: 101 }, { amount_captured: 0.5 }, { id: 'ch_B' },
  ])('refuses unsupported or unbacked original charge accounting', async change => {
    expect(await reader({ '/charges/ch_A': { ...charge, ...change } }).client.readPaymentLineage(pin))
      .toMatchObject({ ok: false, detail: 'stripe original charge pin mismatch' });
  });

  it.each([
    { '/refunds/re_A': { ...refund, status: 'unknown' } },
    { '/refunds/re_A': { ...refund, balance_transaction: null } },
    { '/refunds/re_A': { ...refund, amount: 101 } },
    { '/refunds/re_A': { ...refund, status: 'failed' } },
    { '/refunds/re_A': { ...refund, failure_balance_transaction: 'txn_Failure' } },
    { '/refunds/re_A': { ...refund, status: 'failed', failure_balance_transaction: 'txn_Refund' } },
    { '/balance_transactions/txn_Refund': bt('txn_Refund', 're_A', 'refund', -41) },
    { '/balance_transactions/txn_Refund': { ...bt('txn_Refund', 're_A', 'refund', -40), net: -39 } },
    { '/balance_transactions/txn_Charge': bt('txn_Charge', 'ch_A', 'charge', 101, 3) },
  ])('refuses incomplete, duplicate or numerically inconsistent refund movements', async overrides => {
    expect(await reader(overrides).client.readPaymentLineage(pin)).toMatchObject({ ok: false, code: 'malformed-response' });
  });

  it.each([
    { ...dispute, charge: 'ch_B' }, { ...dispute, livemode: false }, { ...dispute, status: 'unknown' },
    { ...dispute, balance_transactions: null }, { ...dispute, balance_transactions: ['txn_Dispute', 'txn_Dispute'] },
    { ...dispute, balance_transactions: ['txn_Charge'] }, { ...dispute, balance_transactions: ['txn_bad/path'] },
    { ...dispute, balance_transactions: ['txn_Dispute', 'txn_Reinstated', 'txn_Extra'] },
  ])('refuses foreign or incomplete dispute references before accepting a census', async d => {
    expect(await reader({ '/disputes/du_A': d }).client.readPaymentLineage(disputePin)).toMatchObject({ ok: false });
  });

  it('supports expanded references but retrieves accounting afresh instead of trusting embedded accounting', async () => {
    const result = await reader({ '/refunds/re_A': { ...refund, charge: { id: 'ch_A' }, balance_transaction: { id: 'txn_Refund', amount: 999 } },
      '/charges/ch_A': { ...charge, customer: { id: 'cus_A' }, balance_transaction: { id: 'txn_Charge', amount: 999 } } })
      .client.readPaymentLineage(pin);
    expect(result).toMatchObject({ ok: true, evidence: { source: { balanceTransactions: [{ amount: -40 }] } } });
  });

  it('refuses URL-shaped pins before any provider read', async () => {
    const r = reader();
    expect(await r.client.readPaymentLineage({ ...pin, source: { kind: 'refund', id: 're_A/other' } })).toMatchObject({ ok: false });
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });

  it('snapshots nested reversal pins and credentials across awaits', async () => {
    const r = reader(); const input = { ...pin, source: { kind: 'refund' as const, id: 're_A' } };
    const pending = r.client.readPaymentLineage(input);
    input.chargeId = 'ch_B'; input.source.id = 're_B'; r.options.secretKey = 'sk_live_changed';
    expect(await pending).toMatchObject({ ok: true, evidence: { charge: { id: 'ch_A' }, source: { id: 're_A' } } });
    for (const [, init] of r.fetchImpl.mock.calls) expect(init?.headers).toEqual({ authorization: 'Bearer sk_live_key' });
  });

  it('discards partial provenance on a later failure and sanitizes errors/missing request IDs', async () => {
    const r = reader({ '/balance_transactions/txn_Refund': null });
    const failed = await r.client.readPaymentLineage(pin);
    expect(failed).toMatchObject({ ok: false, code: 'provider-error', status: 404 });
    expect(failed).not.toHaveProperty('evidence');
    expect(JSON.stringify(failed)).not.toMatch(/private|sk_live/);
    expect(await reader({}, { requestId: null }).client.readPaymentLineage(pin)).toMatchObject({ ok: false, code: 'malformed-response' });
  });
});
