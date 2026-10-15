/**
 * Commerce webhook intake + entitlement read, end to end (P-010; D-025).
 *
 * These run against REAL SQLite with the real migrations applied (see
 * `sqlite-d1.ts`), because the feature's central promise is a database
 * constraint — `UNIQUE (provider, provider_event_id)` — that a SQL-string fake
 * cannot enforce.
 *
 * Signatures are computed independently with `node:crypto`, never via the
 * adapter's own `computeStripeSignature`.
 */

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApi } from '../routes/index.ts';
import type { Env } from '../env.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';
import { USER_ID_FORM, isCanonicalUserId } from '@papercusp/operator-core/lib/cupboard/commerce-door-gate-io';

/**
 * Only `resolveGithubBearer` is mocked — the real `AuthError` is kept, so the
 * route's `instanceof AuthError` branch is the one actually exercised rather
 * than a look-alike that would pass whether or not the branch were correct.
 * The webhook routes below do not consult it (they authenticate by signature).
 */
const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});

// Imported AFTER the vi.mock above; the mock spreads the real module, so this
// is the genuine AuthError class the route branches on.
const { AuthError } = await import('../auth.ts');

const SIGNING_FIXTURE = 'cupboard-fixture-signing-material';

function sign(rawBody: string, timestampSec: number, material = SIGNING_FIXTURE): string {
  const mac = createHmac('sha256', material).update(`${timestampSec}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

function harness(
  overrides: Partial<Env> = {},
  options: Parameters<typeof buildApi>[0] = {},
) {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv({ STRIPE_WEBHOOK_SECRET: SIGNING_FIXTURE, ...overrides });
  env.DB = db;
  return { api: buildApi(options), env, raw };
}

const NOW_SEC = Math.floor(Date.now() / 1000);

function stripeBody(over: Record<string, unknown> = {}, object: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    created: NOW_SEC,
    data: {
      object: {
        id: 'cs_1',
        payment_status: 'paid',
        amount_total: 2500,
        currency: 'usd',
        payment_intent: 'pi_1',
        metadata: { orderId: 'order-1' },
        ...object,
      },
    },
    ...over,
  });
}

/** The operator's own facts: the order exists before Stripe confirms payment. */
function seedOrder(raw: ReturnType<typeof makeSqliteDb>['raw']): void {
  const rows: Array<[string, string, number, string, string, string]> = [
    ['seed-1', 'product.defined', 1_000, 'operator', '{"productId":"prod-1","skuRef":"sku-1","creatorId":"creator-1","title":"A Pot"}', 'null'],
    ['seed-2', 'offer.defined', 2_000, 'operator', '{"offerId":"offer-1","productId":"prod-1","pricingModel":"one-time","price":{"amountMinor":2500,"currency":"USD"}}', 'null'],
    ['seed-3', 'order.created', 3_000, 'operator', '{"orderId":"order-1","offerId":"offer-1","buyerId":"buyer-1"}', 'null'],
  ];
  for (const [id, kind, at, provider, payload] of rows) {
    raw
      .prepare(
        'INSERT INTO commerce_ledger_events (ledger_event_id, kind, occurred_at_ms, provider, provider_event_id, payload_json) VALUES (?, ?, ?, ?, NULL, ?)',
      )
      .run(id, kind, at, provider, payload);
  }
}

async function post(api: ReturnType<typeof buildApi>, env: Env, body: string, signature: string | null, provider = 'stripe') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature) headers['Stripe-Signature'] = signature;
  return api.request(`/commerce/webhooks/${provider}`, { method: 'POST', headers, body }, env);
}

describe('POST /commerce/webhooks/:provider — authentication', () => {
  it('refuses an unsigned delivery with 401 and records NOTHING', async () => {
    const { api, env, raw } = harness();
    const res = await post(api, env, stripeBody(), null);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('missing-signature');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM commerce_webhook_inbox').get()).toMatchObject({ n: 0 });
  });

  it('refuses a delivery signed with the wrong material, and stores nothing', async () => {
    const { api, env, raw } = harness();
    const body = stripeBody();
    const res = await post(api, env, body, sign(body, NOW_SEC, 'the-wrong-material'));
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('bad-signature');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM commerce_webhook_inbox').get()).toMatchObject({ n: 0 });
  });

  it('refuses a signature outside the timestamp tolerance', async () => {
    const { api, env } = harness();
    const stale = NOW_SEC - 3600;
    const body = stripeBody();
    const res = await post(api, env, body, sign(body, stale));
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('stale-timestamp');
  });

  it('fails CLOSED with 503 when the deployment has no signing secret configured', async () => {
    const { api, env } = harness({ STRIPE_WEBHOOK_SECRET: undefined });
    const body = stripeBody();
    const res = await post(api, env, body, sign(body, NOW_SEC));
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toBe('provider_not_configured');
  });

  it('404s an unknown provider, distinctly from an unconfigured one', async () => {
    const { api, env } = harness();
    const body = stripeBody();
    const res = await post(api, env, body, sign(body, NOW_SEC), 'paypal');
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('unknown_provider');
  });
});

describe('POST /commerce/webhooks/:provider — ingestion', () => {
  it('accepts a signed payment, appends ledger events, and projects an entitlement', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const body = stripeBody();

    const res = await post(api, env, body, sign(body, NOW_SEC));
    expect(res.status).toBe(200);
    const json = await res.json() as { outcome: string; ledger_event_ids: string[] };
    expect(json.outcome).toBe('accepted');
    expect(json.ledger_event_ids).toEqual(['stripe:evt_1:0']);

    expect(raw.prepare("SELECT state, refunded_minor FROM commerce_orders WHERE order_id = 'order-1'").get())
      .toMatchObject({ state: 'paid', refunded_minor: 0 });
    expect(raw.prepare("SELECT state, buyer_id, product_id FROM commerce_entitlements WHERE entitlement_id = 'ent:order-1'").get())
      .toMatchObject({ state: 'active', buyer_id: 'buyer-1', product_id: 'prod-1' });
    expect(raw.prepare('SELECT outcome FROM commerce_webhook_inbox').get()).toMatchObject({ outcome: 'accepted' });
  });

  it('treats an exact re-delivery as a duplicate and grants nothing further', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const body = stripeBody();
    const signature = sign(body, NOW_SEC);

    expect((await post(api, env, body, signature)).status).toBe(200);
    const replay = await post(api, env, body, signature);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { outcome: string }).outcome).toBe('duplicate');

    // The UNIQUE(provider, provider_event_id) constraint is the durable half.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM commerce_webhook_inbox').get()).toMatchObject({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM commerce_entitlements').get()).toMatchObject({ n: 1 });
  });

  it('refuses a replay of the same event id whose BYTES differ', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const first = stripeBody();
    await post(api, env, first, sign(first, NOW_SEC));

    // Same Stripe event id, tampered amount, correctly signed for the new bytes.
    const tampered = stripeBody({}, { amount_total: 100 });
    const res = await post(api, env, tampered, sign(tampered, NOW_SEC));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('replay-mismatch');
    expect(raw.prepare("SELECT amount_minor FROM commerce_orders WHERE order_id = 'order-1'").get())
      .toMatchObject({ amount_minor: 2500 });
  });

  it('202s an authenticated event that carries no ledger meaning', async () => {
    const { api, env, raw } = harness();
    const body = stripeBody({ type: 'customer.created' }, {});
    const res = await post(api, env, body, sign(body, NOW_SEC));
    expect(res.status).toBe(202);
    expect((await res.json() as { outcome: string }).outcome).toBe('ignored');
    expect(raw.prepare('SELECT outcome FROM commerce_webhook_inbox').get()).toMatchObject({ outcome: 'ignored' });
  });

  it('revokes the entitlement when a full refund arrives', async () => {
    const { api, env, raw } = harness();
    seedOrder(raw);
    const paid = stripeBody();
    await post(api, env, paid, sign(paid, NOW_SEC));

    const refund = JSON.stringify({
      id: 'evt_refund_1',
      type: 'charge.refunded',
      created: NOW_SEC + 10,
      data: {
        object: {
          id: 'ch_1',
          metadata: { orderId: 'order-1' },
          currency: 'usd',
          refunds: { data: [{ id: 're_1', status: 'succeeded', amount: 2500, currency: 'usd' }] },
        },
      },
    });
    const res = await post(api, env, refund, sign(refund, NOW_SEC));
    expect(res.status).toBe(200);

    expect(raw.prepare("SELECT state, refunded_minor FROM commerce_orders WHERE order_id = 'order-1'").get())
      .toMatchObject({ state: 'refunded', refunded_minor: 2500 });
    expect(raw.prepare("SELECT state, revoke_reason FROM commerce_entitlements WHERE entitlement_id = 'ent:order-1'").get())
      .toMatchObject({ state: 'revoked', revoke_reason: 'refunded' });
  });
});

/**
 * `buyer-1` is the buyer the ledger fixture books its order to (`seedOrder`),
 * so it is the org whose entitlements these tests read. `loadOrgs` is injected
 * for the same reason as in the checkout suite: production has no org writer
 * yet, so the member-permitted branch would otherwise be unreachable.
 */
describe('GET /commerce/entitlements', () => {
  const BUYER_ORG = 'buyer-1';
  const MEMBER = 'gh:42'; // what the mocked bearer below resolves to
  const STRANGER = 'gh:99';

  function entitlementsHarness(memberships: Array<{ userId: string; role: 'owner' | 'member' }> = [{ userId: MEMBER, role: 'member' }]) {
    const orgs = new Map([
      [BUYER_ORG, { orgId: BUYER_ORG, displayName: 'Buyer One', memberships: memberships.map((m) => ({ ...m, addedAtMs: 1_000 })) }],
    ]);
    // STRIPE_SECRET_KEY is set so the checkout door in the agreement test below
    // reaches its authorization check rather than short-circuiting on a 503.
    return harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { loadOrgs: async () => orgs });
  }

  /** Grant the entitlement the reads below look for. */
  async function grant(api: ReturnType<typeof buildApi>, env: Env, raw: ReturnType<typeof makeSqliteDb>['raw']) {
    seedOrder(raw);
    const body = stripeBody();
    await post(api, env, body, sign(body, NOW_SEC));
  }

  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'buyer-user' });
  });

  // THE REGRESSION TEST (WI-2146412). This route once answered any caller who
  // named a buyer, with no bearer at all — a stranger could read anyone's
  // purchase history by guessing an id.
  it('401s an ANONYMOUS caller, disclosing no entitlements', async () => {
    const { api, env, raw } = entitlementsHarness();
    await grant(api, env, raw);
    auth.resolveGithubBearer.mockRejectedValue(new AuthError('missing_bearer'));

    const res = await api.request(`/commerce/entitlements?buyer=${BUYER_ORG}`, {}, env);
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string; reason: string; entitlements?: unknown };
    expect(json.error).toBe('unauthorized');
    expect(json.reason).toBe('missing_bearer');
    // The entitlement really does exist — this is a refusal, not an empty read.
    expect(json.entitlements).toBeUndefined();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM commerce_entitlements WHERE state = 'active'").get())
      .toMatchObject({ n: 1 });
  });

  it('authenticates BEFORE validating the buyer param — an anonymous caller learns nothing', async () => {
    const { api, env } = entitlementsHarness();
    auth.resolveGithubBearer.mockRejectedValue(new AuthError('github_rejected'));
    const res = await api.request('/commerce/entitlements', {}, env);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('unauthorized');
  });

  it('defaults to the authenticated principal without inheriting organization purchases', async () => {
    const { api, env, raw } = entitlementsHarness();
    await grant(api, env, raw);
    const res = await api.request('/commerce/entitlements', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ buyer: MEMBER, entitlements: [] });
  });

  it('refuses an explicitly empty buyer rather than substituting a principal', async () => {
    const { api, env } = entitlementsHarness();
    const res = await api.request('/commerce/entitlements?buyer=', {}, env);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('buyer_required');
  });

  it('serves only ACTIVE entitlements to a MEMBER of the buying org', async () => {
    const { api, env, raw } = entitlementsHarness();
    await grant(api, env, raw);

    const mine = await api.request(`/commerce/entitlements?buyer=${BUYER_ORG}`, {}, env);
    expect(mine.status).toBe(200);
    const json = await mine.json() as { buyer: string; entitlements: Array<{ product_id: string; state: string }> };
    expect(json.buyer).toBe(BUYER_ORG);
    expect(json.entitlements).toHaveLength(1);
    expect(json.entitlements[0]).toMatchObject({ product_id: 'prod-1', state: 'active' });
  });

  it('permits the SELF case: the buyer named IS the authenticated principal', async () => {
    const { api, env } = entitlementsHarness([]);
    const res = await api.request(`/commerce/entitlements?buyer=${MEMBER}`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as { buyer: string }).buyer).toBe(MEMBER);
  });

  it('403s a NON-MEMBER of the buying org, disclosing no entitlements', async () => {
    const { api, env, raw } = entitlementsHarness([{ userId: STRANGER, role: 'owner' }]);
    await grant(api, env, raw);

    const res = await api.request(`/commerce/entitlements?buyer=${BUYER_ORG}`, {}, env);
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string; entitlements?: unknown };
    expect(json.error).toBe('not_org_member');
    expect(json.entitlements).toBeUndefined();
  });

  it('403s a buyer that is neither the principal nor an org they belong to', async () => {
    // `resolveBuyerPrincipal` would have resolved this to an INDIVIDUAL buyer
    // named 'someone-else'; the shared gate asserts kind === 'organization'
    // instead, which is what makes this a refusal rather than a comparison
    // that lets one person read another's purchases.
    const { api, env } = entitlementsHarness([]);
    const res = await api.request('/commerce/entitlements?buyer=someone-else', {}, env);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('org_membership_unknown');
  });

  it('refuses a principal naming ANOTHER user’s id — self is equality, not a namespace', async () => {
    const { api, env } = entitlementsHarness([]);
    const res = await api.request(`/commerce/entitlements?buyer=${STRANGER}`, {}, env);
    expect(res.status).toBe(403);
  });

  // The read door and the write door must answer the same question the same
  // way: a buyer you may not spend for is a buyer you may not read either.
  it('agrees with the checkout door: same buyer, same principal, same verdict', async () => {
    const { api, env } = entitlementsHarness([{ userId: STRANGER, role: 'owner' }]);
    const read = await api.request(`/commerce/entitlements?buyer=${BUYER_ORG}`, {}, env);
    const write = await api.request(
      '/commerce/checkout-sessions',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...CHECKOUT_BODY, buyerOrgId: BUYER_ORG }) },
      env,
    );
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect((await read.json() as { error: string }).error).toBe((await write.json() as { error: string }).error);
  });

  it('stops serving an entitlement once it is revoked', async () => {
    const { api, env, raw } = entitlementsHarness();
    await grant(api, env, raw);
    raw.prepare("UPDATE commerce_entitlements SET state = 'revoked' WHERE entitlement_id = 'ent:order-1'").run();

    const res = await api.request(`/commerce/entitlements?buyer=${BUYER_ORG}`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as { entitlements: unknown[] }).entitlements).toEqual([]);
  });
});

describe('migration 019 schema', () => {
  it('enforces UNIQUE(provider, provider_event_id) on the webhook inbox', () => {
    const { raw } = makeSqliteDb();
    const insert = () =>
      raw
        .prepare(
          "INSERT INTO commerce_webhook_inbox (provider, provider_event_id, provider_event_type, body_digest, received_at_ms, outcome, rejection_code, ledger_event_ids_json) VALUES ('stripe', 'evt_1', 'x', 'digest', 1, 'accepted', NULL, '[]')",
        )
        .run();
    insert();
    expect(insert).toThrow(/UNIQUE/i);
  });

  it('rejects an outcome outside the accepted/ignored/rejected set', () => {
    const { raw } = makeSqliteDb();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO commerce_webhook_inbox (provider, provider_event_id, provider_event_type, body_digest, received_at_ms, outcome, rejection_code, ledger_event_ids_json) VALUES ('stripe', 'evt_2', 'x', 'digest', 1, 'maybe', NULL, '[]')",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it("projects complete per-use terms into commerce_offers", () => {
    const { raw } = makeSqliteDb();
    const columns = raw
      .prepare("PRAGMA table_info('commerce_offers')")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "unit_price_micros",
        "meter_unit",
        "price_version",
        "split_manifest_hash",
      ]),
    );
  });
});

/**
 * POST /commerce/checkout-sessions (D-045 §3c) — the hosted half of the
 * cupboard:checkout door.
 *
 * NOTE the path carries NO `/v1` prefix: `buildApi()` is mounted at the Worker
 * root and every sub-route uses `api.route('/', …)`. WI-2146343's brief named
 * `/v1/commerce/checkout-sessions`, which would 404.
 *
 * Stripe is reached through an injected `fetchImpl`, so these exercise the real
 * route, real SQLite and the real migrations without network access. What they
 * are actually about is the two ways this endpoint can cost real money: creating
 * a SECOND session for one order, and recording an order for a session that does
 * not exist.
 */
const CATALOG_SEED: Array<[string, string, number, string]> = [
  ['cat-1', 'product.defined', 1_000, '{"productId":"prod-1","skuRef":"sku-1","creatorId":"creator-1","title":"A Pot"}'],
  ['cat-2', 'offer.defined', 2_000, '{"offerId":"offer-1","productId":"prod-1","pricingModel":"one-time","price":{"amountMinor":2500,"currency":"USD"}}'],
];

function seedCatalog(raw: ReturnType<typeof makeSqliteDb>['raw'], extra: Array<[string, string, number, string]> = []): void {
  for (const [id, kind, at, payload] of [...CATALOG_SEED, ...extra]) {
    raw
      .prepare(
        'INSERT INTO commerce_ledger_events (ledger_event_id, kind, occurred_at_ms, provider, provider_event_id, payload_json) VALUES (?, ?, ?, ?, NULL, ?)',
      )
      .run(id, kind, at, 'operator', payload);
  }
}

/** Records every outbound Stripe call so "exactly once" is assertable. */
function stripeStub(response: { status: number; body: string } = { status: 200, body: JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.test/pay/cs_test_1' }) }) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    const i = init as RequestInit;
    calls.push({ url: String(url), body: String(i.body ?? ''), headers: (i.headers ?? {}) as Record<string, string> });
    return new Response(response.body, { status: response.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// `gh:42` is the SELF-purchase case: it is exactly the principal the mocked
// bearer below resolves to ({ id: 42 }), so these tests exercise creation and
// idempotency rather than re-testing authorization. Naming any other buyer now
// requires an org membership — see the authorization block at the end of this
// file, and `principalId` in routes/commerce.ts for the `gh:<id>` convention.
const CHECKOUT_BODY = {
  buyerOrgId: 'gh:42',
  offerId: 'offer-1',
  successUrl: 'https://example.test/ok',
  cancelUrl: 'https://example.test/no',
  idempotencyKey: 'checkout-key-1',
};

async function checkout(api: ReturnType<typeof buildApi>, env: Env, body: Record<string, unknown> = CHECKOUT_BODY) {
  return api.request(
    '/commerce/checkout-sessions',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

describe('POST /commerce/checkout-sessions — authentication', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
  });

  it('401s an unauthenticated caller and never reaches Stripe', async () => {
    auth.resolveGithubBearer.mockRejectedValue(new AuthError('missing_bearer'));
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);
    const res = await checkout(api, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'missing_bearer' });
    expect(stripe.calls).toHaveLength(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM commerce_ledger_events WHERE kind = 'order.created'").get()).toMatchObject({ n: 0 });
  });

  it('401s BEFORE disclosing whether this deployment has Stripe configured', async () => {
    // An anonymous caller must not be able to probe deployment config: with no
    // secret key AND no bearer, the answer is 401, never the 503.
    auth.resolveGithubBearer.mockRejectedValue(new AuthError('github_rejected'));
    const stripe = stripeStub();
    const { api, env } = harness({ STRIPE_SECRET_KEY: undefined }, { fetchImpl: stripe.impl });
    const res = await checkout(api, env);
    expect(res.status).toBe(401);
  });
});

describe('POST /commerce/checkout-sessions — refusals', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'buyer-user' });
  });

  it('fails CLOSED with 503 when the deployment has no Stripe secret key', async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness(
      { STRIPE_SECRET_KEY: undefined },
      { fetchImpl: stripe.impl },
    );
    seedCatalog(raw);
    const res = await checkout(api, env);
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toBe('provider_not_configured');
    // The point of failing closed: we never called the provider.
    expect(stripe.calls).toHaveLength(0);
  });

  it("authors, catalogs, persists, and preflights a per-use offer through production doors", async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness(
      { STRIPE_SECRET_KEY: undefined },
      { fetchImpl: stripe.impl },
    );
    const splitManifestHash = `sha256:${"a".repeat(64)}`;
    const publish = await api.request(
      "/commerce/offers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-use",
          offerId: "offer-use",
          skuRef: "sku-use",
          title: "Metered tool",
          pricingModel: "per-use",
          price: { amountMinor: 0, currency: "USD" },
          perUse: {
            unitPriceMicros: 25,
            meterUnit: "tool-call",
            priceVersion: "price-v1",
            splitManifestHash,
          },
        }),
      },
      env,
    );
    expect(publish.status).toBe(201);
    expect(await publish.json()).toMatchObject({
      replayed: false,
      product: { productId: "prod-use", creatorId: "gh:42" },
      offer: {
        offerId: "offer-use",
        pricingModel: "per-use",
        perUse: {
          unitPriceMicros: 25,
          meterUnit: "tool-call",
          priceVersion: "price-v1",
          splitManifestHash,
        },
      },
    });

    expect(
      raw
        .prepare(
          "SELECT unit_price_micros, meter_unit, price_version, split_manifest_hash FROM commerce_offers WHERE offer_id = ?",
        )
        .get("offer-use"),
    ).toMatchObject({
      unit_price_micros: 25,
      meter_unit: "tool-call",
      price_version: "price-v1",
      split_manifest_hash: splitManifestHash,
    });

    const catalog = await api.request(
      "/commerce/offers?pricing=per-use",
      {},
      env,
    );
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      offers: [
        {
          offerId: "offer-use",
          pricingModel: "per-use",
          perUse: {
            unitPriceMicros: 25,
            meterUnit: "tool-call",
            priceVersion: "price-v1",
            splitManifestHash,
          },
        },
      ],
    });

    const preflight = await checkout(api, env, {
      ...CHECKOUT_BODY,
      offerId: "offer-use",
      maxSpendMicros: 1_000,
    });
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({
      checkoutKind: "microcharge-preflight",
      rail: "p2p-microcharge",
      channel: {
        payer: "gh:42",
        seller: "gh:42",
        releaseRef: "sku-use",
        escrowMicros: "1000",
        committedMicros: "0",
      },
      terms: {
        unitPriceMicros: 25,
        meterUnit: "tool-call",
        priceVersion: "price-v1",
        splitManifestHash,
        currency: "USD",
      },
    });
    expect(stripe.calls).toHaveLength(0);
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM commerce_ledger_events WHERE kind = 'order.created'",
        )
        .get(),
    ).toMatchObject({ n: 0 });
  });

  it("requires an escrow cap for a per-use preflight", async () => {
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: undefined });
    seedCatalog(raw, [
      [
        "cat-use",
        "offer.defined",
        2_500,
        JSON.stringify({
          offerId: "offer-use",
          productId: "prod-1",
          pricingModel: "per-use",
          price: { amountMinor: 0, currency: "USD" },
          perUse: {
            unitPriceMicros: 25,
            meterUnit: "tool-call",
            priceVersion: "price-v1",
            splitManifestHash: `sha256:${"b".repeat(64)}`,
          },
        }),
      ],
    ]);
    const res = await checkout(api, env, {
      ...CHECKOUT_BODY,
      offerId: "offer-use",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "max_spend_required" });
  });

  it('404s an offer the ledger has never defined', async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, offerId: 'offer-does-not-exist' });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('unknown_offer');
    expect(stripe.calls).toHaveLength(0);
  });

  it('422s an inactive offer, distinctly from an unknown one', async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw, [
      ['cat-3', 'offer.defined', 2_500, '{"offerId":"offer-off","productId":"prod-1","pricingModel":"one-time","price":{"amountMinor":2500,"currency":"USD"},"active":false}'],
    ]);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, offerId: 'offer-off' });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe('inactive_offer');
  });

  it('422s a free offer — those never go through Checkout', async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw, [
      ['cat-4', 'offer.defined', 2_500, '{"offerId":"offer-free","productId":"prod-1","pricingModel":"free","price":{"amountMinor":0,"currency":"USD"}}'],
    ]);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, offerId: 'offer-free' });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe('unsupported_pricing_model');
    expect(stripe.calls).toHaveLength(0);
  });

  it('422s quantity > 1 rather than silently charging for one seat', async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, quantity: 3 });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe('unsupported_quantity');
    expect(stripe.calls).toHaveLength(0);
  });

  it.each(['buyerOrgId', 'offerId', 'successUrl', 'cancelUrl', 'idempotencyKey'])('400s when %s is missing', async (field) => {
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);
    const body: Record<string, unknown> = { ...CHECKOUT_BODY };
    delete body[field];
    const res = await checkout(api, env, body);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_request');
  });

  it('502s when Stripe refuses, and records NO order for a session that does not exist', async () => {
    const stripe = stripeStub({ status: 402, body: JSON.stringify({ error: { message: 'Your card was declined.' } }) });
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);
    const res = await checkout(api, env);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'provider_error', detail: 'Your card was declined.' });
    // An order.created whose session does not exist is an order nothing can pay.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM commerce_ledger_events WHERE kind = 'order.created'").get()).toMatchObject({ n: 0 });
  });
});

describe('POST /commerce/checkout-sessions — creation and idempotency', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'buyer-user' });
  });

  it('creates a session, appends order.created, and projects a pending order', async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);

    const res = await checkout(api, env);
    expect(res.status).toBe(201);
    const json = await res.json() as { orderId: string; providerSessionId: string; url: string };
    expect(json.providerSessionId).toBe('cs_test_1');
    expect(json.url).toBe('https://checkout.test/pay/cs_test_1');
    expect(json.orderId).toMatch(/^ord_[0-9a-f]{32}$/);

    // Sent form-encoded, carrying the order id Stripe will echo back on the webhook.
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(stripe.calls[0].body).toContain(`client_reference_id=${json.orderId}`);
    expect(stripe.calls[0].body).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=2500');
    expect(stripe.calls[0].headers['idempotency-key']).toBe(json.orderId);

    const order = raw.prepare('SELECT order_id, buyer_id, state, amount_minor, provider_ref FROM commerce_orders WHERE order_id = ?').get(json.orderId);
    expect(order).toMatchObject({ order_id: json.orderId, buyer_id: 'gh:42', state: 'pending', amount_minor: 2500, provider_ref: 'cs_test_1' });
  });

  it('replays the SAME idempotencyKey to the same order without a second Stripe call', async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);

    const first = await checkout(api, env);
    const firstJson = await first.json() as { orderId: string; url: string };
    const second = await checkout(api, env);
    const secondJson = await second.json() as { orderId: string; providerSessionId: string; url: string; replayed: boolean };

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondJson.replayed).toBe(true);
    expect(secondJson.orderId).toBe(firstJson.orderId);
    expect(secondJson.providerSessionId).toBe('cs_test_1');
    // The URL is not reducer state — it is read back from the originating event.
    expect(secondJson.url).toBe(firstJson.url);

    // The two properties that make this idempotent rather than merely repeatable.
    expect(stripe.calls).toHaveLength(1);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM commerce_ledger_events WHERE kind = 'order.created'").get()).toMatchObject({ n: 1 });
  });

  it('gives two buyers sharing an idempotencyKey DIFFERENT orders', async () => {
    // The key is client-chosen, so it is scoped to its buyer: otherwise the
    // second buyer would be handed the first buyer's order and checkout URL.
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);

    // Each buyer must now BE its own authenticated principal (WI-2146391): a
    // caller may only name itself or an org it belongs to. That makes this
    // stronger than it was — the two orders are opened by two genuinely
    // different identities rather than by one caller naming two strings.
    auth.resolveGithubBearer.mockResolvedValue({ id: 1, login: 'buyer-a' });
    const a = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: 'gh:1' });
    auth.resolveGithubBearer.mockResolvedValue({ id: 2, login: 'buyer-b' });
    const b = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: 'gh:2' });
    const aJson = await a.json() as { orderId: string };
    const bJson = await b.json() as { orderId: string };

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(aJson.orderId).not.toBe(bJson.orderId);
    expect(stripe.calls).toHaveLength(2);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM commerce_ledger_events WHERE kind = 'order.created'").get()).toMatchObject({ n: 2 });
  });

  it('a different idempotencyKey for the same buyer+offer opens a distinct order', async () => {
    const stripe = stripeStub();
    const { api, env, raw } = harness({ STRIPE_SECRET_KEY: 'test-secret-material' }, { fetchImpl: stripe.impl });
    seedCatalog(raw);

    const first = await checkout(api, env);
    const second = await checkout(api, env, { ...CHECKOUT_BODY, idempotencyKey: 'checkout-key-2' });
    expect((await first.json() as { orderId: string }).orderId).not.toBe((await second.json() as { orderId: string }).orderId);
    expect(stripe.calls).toHaveLength(2);
  });
});

/**
 * POST /commerce/checkout-sessions — AUTHORIZATION (WI-2146391).
 *
 * The gap these close: the route authenticated WHO was calling but never that
 * they could act for `buyerOrgId`, so any authenticated user could open a
 * Checkout Session — and an `order.created` ledger event — in any org's name.
 *
 * The membership rule itself lives in `authorizeOrgActor` (D-045 §3d) and is
 * NOT restated here; what these assert is that the route consults it, maps its
 * refusals to the wire, and — the part that is easy to get wrong — consults it
 * BEFORE the idempotent-replay branch.
 *
 * `loadOrgs` is injected because production has no org writer yet, so the
 * member-permitted branch would otherwise be unreachable and untested.
 */
describe('POST /commerce/checkout-sessions — authorization', () => {
  const ORG_ID = 'org-acme';
  const MEMBER = 'gh:42'; // the principal the mocked bearer below resolves to
  const STRANGER = 'gh:99';

  // The one thing that must agree between the Worker and the desktop door.
  // Membership is matched by string equality, so a divergence here would not
  // error — it would refuse every legitimate member as a stranger. Asserted
  // against the shared predicate rather than restated, so if su-43e03bbc's
  // half changes form this fails instead of silently 403ing production.
  it('emits principal ids in the form both halves pinned', () => {
    expect(isCanonicalUserId(MEMBER)).toBe(true);
    expect(isCanonicalUserId(STRANGER)).toBe(true);
    expect(USER_ID_FORM).toBe('gh:<numeric github id>');
    // The fixture ids above are exactly what the route derives from a bearer.
    expect(MEMBER).toBe(`gh:${42}`);
  });

  function orgHarness(memberships: Array<{ userId: string; role: 'owner' | 'admin' | 'member' }>) {
    const orgs = new Map([
      [
        ORG_ID,
        {
          orgId: ORG_ID,
          displayName: 'Acme',
          memberships: memberships.map((m) => ({ ...m, addedAtMs: 1_000 })),
        },
      ],
    ]);
    const stripe = stripeStub();
    const { db, raw } = makeSqliteDb();
    const { env } = makeEnv({ STRIPE_WEBHOOK_SECRET: SIGNING_FIXTURE, STRIPE_SECRET_KEY: 'test-secret-material' });
    env.DB = db;
    const api = buildApi({ fetchImpl: stripe.impl, loadOrgs: async () => orgs });
    seedCatalog(raw);
    return { api, env, raw, stripe };
  }

  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'buyer-user' });
  });

  it('201s a MEMBER buying in their org’s name, booking the order to the ORG', async () => {
    const { api, env, raw, stripe } = orgHarness([{ userId: MEMBER, role: 'member' }]);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: ORG_ID });
    expect(res.status).toBe(201);
    expect(stripe.calls).toHaveLength(1);
    const json = (await res.json()) as { orderId: string };
    expect(raw.prepare('SELECT buyer_id FROM commerce_orders WHERE order_id = ?').get(json.orderId))
      .toMatchObject({ buyer_id: ORG_ID });
  });

  it('403s a NON-MEMBER of a real org, reaching neither Stripe nor the ledger', async () => {
    const { api, env, raw, stripe } = orgHarness([{ userId: STRANGER, role: 'owner' }]);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: ORG_ID });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('not_org_member');
    expect(stripe.calls).toHaveLength(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM commerce_ledger_events WHERE kind = 'order.created'").get())
      .toMatchObject({ n: 0 });
  });

  it('403s an org that does not exist, never falling through to the individual-buyer path', async () => {
    const { api, env, stripe } = orgHarness([{ userId: MEMBER, role: 'member' }]);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: 'org-does-not-exist' });
    expect(res.status).toBe(403);
    // `resolveBuyerPrincipal` would have resolved this to an INDIVIDUAL buyer
    // named 'org-does-not-exist'; the gate asserts kind === 'organization'
    // instead, which is what makes this a refusal rather than a comparison.
    expect((await res.json() as { error: string }).error).toBe('org_membership_unknown');
    expect(stripe.calls).toHaveLength(0);
  });

  it('permits the SELF case: the buyer named IS the authenticated principal', async () => {
    const { api, env, stripe } = orgHarness([]);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: MEMBER });
    expect(res.status).toBe(201);
    expect(stripe.calls).toHaveLength(1);
  });

  it('refuses a principal naming ANOTHER user’s id — self is equality, not a namespace', async () => {
    const { api, env, stripe } = orgHarness([]);
    const res = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: STRANGER });
    expect(res.status).toBe(403);
    expect(stripe.calls).toHaveLength(0);
  });

  it('403s a NON-MEMBER replaying a member’s key — the check PRECEDES the replay branch', async () => {
    // THE ORDERING TEST. Replay returns the original order's live Checkout URL,
    // so had authorization run after the replay lookup, a stranger would get a
    // 200 carrying a payment handle they were never entitled to see.
    const { api, env, stripe } = orgHarness([{ userId: MEMBER, role: 'member' }]);

    const first = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: ORG_ID });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { orderId: string; url: string };

    // A different principal replays the SAME idempotencyKey against the same org.
    auth.resolveGithubBearer.mockResolvedValue({ id: 99, login: 'stranger' });
    const replay = await checkout(api, env, { ...CHECKOUT_BODY, buyerOrgId: ORG_ID });

    expect(replay.status).toBe(403);
    const replayJson = (await replay.json()) as { error: string; url?: string; orderId?: string };
    expect(replayJson.error).toBe('not_org_member');
    // The payment handle must not appear anywhere in a refusal.
    expect(replayJson.url).toBeUndefined();
    expect(replayJson.orderId).toBeUndefined();
    expect(JSON.stringify(replayJson)).not.toContain(firstJson.url);
    // And no second Checkout Session was opened.
    expect(stripe.calls).toHaveLength(1);
  });
});
