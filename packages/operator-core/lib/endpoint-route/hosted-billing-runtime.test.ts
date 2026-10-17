/**
 * Hosted subscription billing — routes driven through the real runtime
 * composition (`createHostedBillingRuntime`), with every external collaborator
 * faked at its seam: the principal resolver, secret resolution, the billing
 * store, and Stripe's HTTP API (`fetchImpl`). Webhook deliveries are signed with
 * `computeStripeSignature`, the adapter's own primitive, whose correctness is
 * pinned independently against a known vector in `cupboard/payment-adapters/stripe.test.ts`.
 *
 * Store semantics (order independence, idempotency, atomicity) are proven
 * against real Postgres in `billing-store.integration.test.ts`; the in-memory
 * store here only has to be honest about the contract the routes rely on.
 *
 * stripe-subscription-signup-2026-10-01 P-005.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HostedUsageRecord } from '../auth/hosted/billing/usage-statement';
import type { HostedOpenRouterRequestCaptureOptions } from '../auth/hosted/billing/usage-store';
import { PostgresHostedBudgetStore } from '../auth/hosted/billing/budget-store';
import { createRoutedModelPort } from '../agent-loop/provider-router';
import { runLoopChatTurn } from '../agent-loop/chat-engine';
import { createOperatorOwnedLoopPort } from '../agent-loop/headless-invoke';
import { createHostedCustomerModelPortFactory } from '../workspace-host/hosted-customer-loop-ports';
import { captureModelProviderRequest, type ModelPort, type ModelRequest } from '../agent-loop/model-port';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createHostedPrincipal, type HostedPermission } from '../auth/hosted-principal';
import type { HostedPrincipalResolution, HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type {
  HostedBillingApplyOutcome,
  HostedBillingCustomer,
  HostedBillingStore,
} from '../auth/hosted/billing/billing-store';
import type { HostedSubscriptionSnapshot } from '../auth/hosted/billing/entitlement-seam';
import type { HostedBillingEvent } from '../auth/hosted/billing/stripe-billing-events';
import { computeStripeSignature } from '../cupboard/payment-adapters/stripe';
import type { CustomerReceiptEntry } from '../cupboard/payment-receipt-store';
import { webhookBodyDigest } from '../cupboard/webhook-inbox';
import {
  HOSTED_BILLING_RUNTIME_MOUNTED_ROUTE_KEYS,
  createHostedBillingRuntime,
  parseHostedBillingPlans,
  parseReceiptsWorkspaceId,
  parseStripePortalConfigurationId,
  parseStripeAccountId,
  readHostedBillingRuntimeConfiguration,
  type HostedBillingRuntimeConfiguration,
  type HostedBillingRuntimeDependencies,
  type HostedOpenRouterAuthorization,
} from './hosted-billing-runtime';

const GCP_SECRET_REF_PREFIX = ['gcp', 'secret'].join('-') + ':';

const ORG = '11111111-2222-4333-8444-555555555555';
const ORIGIN = 'https://app.example';
const WEBHOOK_SECRET = 'whsec_testsecret123';
const NOW = new Date('2026-10-01T12:00:00.000Z');

// ── fakes ───────────────────────────────────────────────────────────────────

class MemoryBillingStore implements HostedBillingStore {
  customers = new Map<string, HostedBillingCustomer>();
  subscription: HostedSubscriptionSnapshot | null = null;
  events = new Map<string, string>();
  applied: Array<{ event: HostedBillingEvent; expectedLivemode: boolean; planKey: string | null }> = [];
  rejected: Array<{ eventId: string; code: string }> = [];
  failReads = false;

  async customerFor(organizationId: string) {
    if (this.failReads) throw new Error('store down');
    return this.customers.get(organizationId) ?? null;
  }

  async recordCustomer(customer: HostedBillingCustomer) {
    const existing = this.customers.get(customer.organizationId);
    if (existing) return existing;
    this.customers.set(customer.organizationId, customer);
    return customer;
  }

  async currentSubscription(_organizationId: string, planKeyForPrice: (priceId: string | null) => string | null) {
    if (this.failReads) throw new Error('store down');
    return this.subscription && { ...this.subscription, planKey: planKeyForPrice(this.subscription.priceId) };
  }

  async applyEvent(input: Parameters<HostedBillingStore['applyEvent']>[0]): Promise<HostedBillingApplyOutcome> {
    const prior = this.events.get(input.event.eventId);
    if (prior !== undefined) {
      return prior === input.bodyDigest ? { outcome: 'duplicate', organizationId: ORG } : { outcome: 'replay-mismatch' };
    }
    this.events.set(input.event.eventId, input.bodyDigest);
    const first = input.event.facts[0];
    this.applied.push({
      event: input.event,
      expectedLivemode: input.expectedLivemode,
      planKey: first && first.kind === 'subscription' ? input.planKeyForPrice(first.priceId) : null,
    });
    return { outcome: 'applied', organizationId: ORG };
  }

  async recordRejectedEvent(input: Parameters<HostedBillingStore['recordRejectedEvent']>[0]) {
    const prior = this.events.get(input.eventId);
    if (prior !== undefined) return prior === input.bodyDigest ? 'duplicate' : 'replay-mismatch';
    this.events.set(input.eventId, input.bodyDigest);
    this.rejected.push({ eventId: input.eventId, code: input.code });
    return 'recorded';
  }
}

interface StripeCall { url: string; headers: Record<string, string>; form: URLSearchParams }

function fakeStripe(responses: Array<{ status?: number; body: unknown }> = []) {
  const calls: StripeCall[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, form: new URLSearchParams(String(init?.body)) });
    const next = responses.shift() ?? { status: 500, body: { error: { message: 'unexpected call' } } };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function principalFor(permissions: HostedPermission[]): HostedPrincipalResolution {
  return {
    ok: true,
    principal: createHostedPrincipal({
      workspaceId: 'control-plane',
      userId: 'user-1',
      activeOrganizationId: ORG,
      sessionId: 'sess-1',
      sessionVersion: 1,
      permissions,
    }),
    session: {} as never,
    membership: {} as never,
  };
}

/** Cookie value → resolution: `owner` manages billing, `member` only views, `revoked` lost membership. */
const resolvePrincipal: HostedPrincipalResolver = async (headers) => {
  const cookie = headers.get('cookie') ?? '';
  if (cookie.includes('session=owner')) return principalFor(['workspace:view', 'billing:manage']);
  if (cookie.includes('session=member')) return principalFor(['workspace:view']);
  if (cookie.includes('session=revoked')) return { ok: false, reason: 'membership_not_active' };
  if (cookie.includes('session=outage')) return { ok: false, reason: 'authority_unavailable' };
  return { ok: false, reason: 'session_cookie_missing' };
};

const SECRETS: Record<string, string> = {
  'env:STRIPE_TEST_KEY': 'sk_test_key123',
  'env:STRIPE_LIVE_KEY': 'sk_live_key123',
  'env:STRIPE_WEBHOOK': WEBHOOK_SECRET,
  'env:NOT_A_WHSEC': 'not-a-webhook-secret',
};

const CONFIG: HostedBillingRuntimeConfiguration = {
  publicOrigin: ORIGIN,
  stripeSecretKeyRef: 'env:STRIPE_TEST_KEY',
  stripeWebhookSecretRef: 'env:STRIPE_WEBHOOK',
  plans: [{ planKey: 'team', priceId: 'price_team', label: 'Team', description: 'For teams' }],
  stripePortalConfigurationId: 'bpc_123',
};

async function runtime(options: {
  config?: Partial<HostedBillingRuntimeConfiguration>;
  deps?: Partial<HostedBillingRuntimeDependencies>;
  stripe?: Array<{ status?: number; body: unknown }>;
} = {}) {
  const store = new MemoryBillingStore();
  const stripe = fakeStripe(options.stripe);
  const built = await createHostedBillingRuntime(
    { ...CONFIG, ...options.config },
    {
      resolvePrincipal,
      resolveSecret: async (ref) => {
        const value = SECRETS[ref];
        if (value === undefined) throw new Error(`unknown ref ${ref}`);
        return value;
      },
      store,
      fetchImpl: stripe.impl,
      clock: () => NOW,
      observeFailure: vi.fn(async () => {}),
      ...options.deps,
    },
  );
  return { ...built, store, stripe };
}

describe('hosted native OpenRouter authorization', () => {
  const context = { modelId: 'vendor/model', servedAccount: 'local-label',
    credentialSha256: createHash('sha256').update('selected-key').digest('hex') };
  const intent = { provider: 'openrouter', modelId: context.modelId };
  const authorized = (): HostedOpenRouterAuthorization => ({
    request: { scope: { controlWorkspaceId: 'control-plane', organizationId: ORG,
      customerWorkspaceId: 'customer-workspace' }, reservationId: 'reservation-1',
    month: '2026-10', budgetKey: 'consumption.usd_cents', maximumCostMicros: 100,
    providerLimitRef: 'fixture:not-commercial-authority', asOfMs: NOW.getTime() },
    credentialRef: 'env:SELECTED_KEY', isByok: true, evidenceRef: 'fixture:authority',
  });
  const resolution = () => {
    const r = principalFor(['workspace:operate']);
    if (r.ok) return { ...r, principal: createHostedPrincipal({ ...r.principal,
      selectedWorkspaceId: 'customer-workspace', permissions: ['workspace:operate'] }) };
    throw new Error('unreachable');
  };
  async function prepared() {
    const principal = vi.fn<HostedPrincipalResolver>(async () => resolution());
    // Typed with the REAL reader signature, whose `| null` is the denial path the
    // 'reader-denied' / 'null-authority' cases below install without a cast.
    const authorize = vi.fn<NonNullable<HostedBillingRuntimeDependencies['openRouterAdmission']>['authorize']>(
      async () => authorized());
    const secret = vi.fn(async () => ' selected-key ');
    const observations: unknown[] = [];
    const capture = vi.fn(async (value: unknown) => { observations.push(value); });
    const createCapture = vi.fn((_options: HostedOpenRouterRequestCaptureOptions) => capture);
    const r = await runtime({ config: { stripeSecretKeyRef: null, stripeWebhookSecretRef: null }, deps: {
      resolvePrincipal: principal, resolveSecret: secret,
      usageStore: { append: async () => 'recorded', readRecords: async () => [],
        readOpenRouterBindings: async () => [], createOpenRouterRequestCapture: createCapture },
      openRouterAdmission: { budget: new PostgresHostedBudgetStore(), authorize, now: () => NOW.getTime() },
    } });
    const headers = new Headers({ cookie: 'session=original' });
    return { r, principal, authorize, secret, capture, createCapture, observations, headers };
  }

  async function customerModel() {
    const p = await prepared();
    const channel = vi.fn(async (_signal: AbortSignal) => resolution());
    const principal = resolution().principal;
    const session = { workspaceId: principal.workspaceId, userId: principal.userId,
      activeOrganizationId: principal.activeOrganizationId, selectedWorkspaceId: principal.selectedWorkspaceId,
      sessionId: principal.sessionId, sessionVersion: principal.sessionVersion };
    const controller = new AbortController();
    const wire = vi.fn(async () => ({ stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'error', error: 'fixture stream ended' }); c.close();
    } }) }));
    const languageModel = vi.fn(async (): Promise<LanguageModelV3> => ({ specificationVersion: 'v3',
      provider: 'fixture', modelId: context.modelId, supportedUrls: {}, doStream: wire,
      async doGenerate() { throw new Error('unused'); } }));
    const token = vi.fn(async () => 'selected-key');
    const select = vi.fn(() => null);
    const factory = createHostedCustomerModelPortFactory({ billing: p.r, resolvePrincipal: channel,
      openRouterAccounts: { active: () => ({ accountId: context.servedAccount, authMode: 'api-key', token }),
        select, onExhausted: () => null }, createLanguageModel: languageModel });
    const port = await factory(session, controller.signal);
    const consume = async (request: ModelRequest = { model: 'openrouter/vendor/model', messages: [] },
      target: ModelPort = port) => {
      const events = [];
      for await (const event of target.stream(request)) {
        if (event.type === 'provider_request') await captureModelProviderRequest(event);
        events.push(event);
      }
      return events;
    };
    return { ...p, channel, session, controller, wire, languageModel, token, select, factory, port, consume };
  }

  it('joins private customer session, runtime pool and awaited billing admission without cookie forwarding', async () => {
    const p = await customerModel();
    await p.consume({ model: 'openrouter/vendor/model', messages: [], account: 'foreign-account', ownerId: 'foreign-user' });
    expect(p.principal).not.toHaveBeenCalled();
    expect(p.select).not.toHaveBeenCalled();
    expect(p.channel).toHaveBeenCalledTimes(5);
    expect(p.authorize).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({ userId: p.session.userId }) }));
    expect(p.createCapture.mock.calls[0]![0].request.scope).toEqual(authorized().request.scope);
    expect(p.capture).toHaveBeenCalledExactlyOnceWith(intent);
    expect(p.wire).toHaveBeenCalledOnce();
  });

  it.each(['claude/sonnet', 'codex/gpt', 'openai/gpt', 'anthropic/claude', ' vendor/model', 'openrouter'])
    ('refuses the unmetered model route %s before authentication or credential selection', async model => {
      const p = await customerModel();
      await expect(p.consume({ model, messages: [] })).rejects.toThrow('hosted_customer_model_unavailable');
      expect(p.channel).not.toHaveBeenCalled(); expect(p.token).not.toHaveBeenCalled();
      expect(p.authorize).not.toHaveBeenCalled(); expect(p.languageModel).not.toHaveBeenCalled();
    });

  it.each(['workspaceId', 'userId', 'activeOrganizationId', 'selectedWorkspaceId', 'sessionId', 'sessionVersion'] as const)
    ('denies a changed customer %s before selecting credentials', async field => {
      const p = await customerModel(); const r = resolution();
      const value = field === 'sessionVersion' ? r.principal.sessionVersion + 1 : 'foreign';
      p.channel.mockResolvedValue({ ...r, principal: createHostedPrincipal({ ...r.principal, [field]: value }) });
      await expect(p.consume()).rejects.toThrow('hosted_customer_model_unavailable');
      expect(p.token).not.toHaveBeenCalled(); expect(p.authorize).not.toHaveBeenCalled();
    });

  it('rechecks customer membership after credential lookup and keeps a denial off the wire', async () => {
    const p = await customerModel();
    p.token.mockImplementation(async () => {
      const r = resolution();
      p.channel.mockResolvedValue({ ...r, principal: createHostedPrincipal({ ...r.principal, permissions: ['workspace:view'] }) });
      return 'selected-key';
    });
    await expect(p.consume()).rejects.toThrow('OpenRouter request capture failed; reservation remains unresolved');
    expect(p.authorize).not.toHaveBeenCalled(); expect(p.createCapture).not.toHaveBeenCalled();
    expect(p.wire).not.toHaveBeenCalled();
  });

  it('binds every stream to fresh admission and snapshots the session independently of its input object', async () => {
    const p = await customerModel();
    p.session.userId = 'mutated';
    let id = 0;
    p.authorize.mockImplementation(async () => { const a = authorized(); return { ...a,
      request: { ...a.request, reservationId: 'customer-' + ++id } }; });
    await p.consume(); await p.consume();
    expect(p.createCapture.mock.calls.map(([o]) => o.request.reservationId)).toEqual(['customer-1', 'customer-2']);
    expect(p.wire).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled channel authentication by invocation cancellation', async () => {
    const p = await customerModel();
    p.channel.mockImplementation(() => new Promise(() => {}));
    const pending = p.consume();
    const denied = expect(pending).rejects.toThrow('hosted_customer_model_unavailable');
    await vi.waitFor(() => expect(p.channel).toHaveBeenCalledOnce());
    p.controller.abort(); await denied;
    expect(p.token).not.toHaveBeenCalled(); expect(p.wire).not.toHaveBeenCalled();
  });

  it.each(['policy', 'credential', 'reservation'] as const)
    ('revalidates a private customer session after the awaited %s reader', async phase => {
      const p = await customerModel();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = vi.fn();
      if (phase === 'policy') p.authorize.mockImplementation(async () => { entered(); await gate; return authorized(); });
      if (phase === 'credential') p.secret.mockImplementation(async () => { entered(); await gate; return 'selected-key'; });
      if (phase === 'reservation') p.capture.mockImplementation(async () => { entered(); await gate; });
      const pending = p.consume();
      const denied = expect(pending).rejects.toThrow('OpenRouter request capture failed; reservation remains unresolved');
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      const r = resolution();
      p.channel.mockResolvedValue({ ...r, principal: createHostedPrincipal({ ...r.principal, permissions: ['workspace:view'] }) });
      release(); await denied;
      expect(p.wire).not.toHaveBeenCalled();
      expect(p.createCapture).toHaveBeenCalledTimes(phase === 'reservation' ? 1 : 0);
    });

  it.each(['workspaceId', 'userId', 'activeOrganizationId', 'selectedWorkspaceId', 'sessionId', 'sessionVersion'] as const)
    ('revalidates cookie-backed %s after credential resolution before reservation', async field => {
      const p = await prepared();
      p.secret.mockImplementation(async () => {
        const r = resolution();
        const value = field === 'sessionVersion' ? r.principal.sessionVersion + 1 : 'foreign';
        p.principal.mockResolvedValue({ ...r, principal: createHostedPrincipal({ ...r.principal, [field]: value }) });
        return 'selected-key';
      });
      await expect(p.r.openRouterRequestCapture(p.headers)(context)(intent)).rejects.toThrow('authorization or capture failed');
      expect(p.createCapture).not.toHaveBeenCalled();
    });

  it('snapshots a customer request before asynchronous channel authentication', async () => {
    const p = await customerModel();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    p.channel.mockImplementationOnce(async () => { await gate; return resolution(); });
    const request: ModelRequest = { model: 'openrouter/vendor/model', messages: [], account: 'foreign' };
    const pending = p.consume(request);
    await vi.waitFor(() => expect(p.channel).toHaveBeenCalledOnce());
    request.model = 'claude/sonnet'; request.account = 'another-account';
    release(); await pending;
    expect(p.observations).toEqual([intent]); expect(p.select).not.toHaveBeenCalled();
    expect(p.wire).toHaveBeenCalledOnce();
  });

  it.each(['pool', 'policy', 'credential', 'reservation'] as const)
    ('settles cancellation while the private model %s reader is stalled', async phase => {
      const p = await customerModel();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = vi.fn();
      if (phase === 'pool') p.token.mockImplementation(async () => { entered(); await gate; return 'selected-key'; });
      if (phase === 'policy') p.authorize.mockImplementation(async () => { entered(); await gate; return authorized(); });
      if (phase === 'credential') p.secret.mockImplementation(async () => { entered(); await gate; return 'selected-key'; });
      if (phase === 'reservation') p.capture.mockImplementation(async () => { entered(); await gate; });
      const outcome = p.consume().then(() => 'fulfilled', () => 'denied');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
        p.controller.abort();
        const deadline = new Promise<string>(resolve => { timer = setTimeout(() => resolve('stalled'), 500); });
        expect(await Promise.race([outcome, deadline])).toBe('denied');
      } finally {
        if (timer) clearTimeout(timer);
        release(); await outcome;
      }
      expect(p.wire).not.toHaveBeenCalled();
    });

  it('uses the real native router and chat loop, awaits host authority before wire, and captures early identity privately', async () => {
    const p = await prepared(); let wire = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    p.authorize.mockImplementation(async () => { await gate; return authorized(); });
    const sdkModel: LanguageModelV3 = { specificationVersion: 'v3', provider: 'fixture', modelId: context.modelId,
      supportedUrls: {}, async doGenerate() { throw new Error('unused'); }, async doStream() {
        wire++; expect(p.capture).toHaveBeenCalledExactlyOnceWith(intent);
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: 'response-metadata', id: 'gen-hosted-test', modelId: context.modelId });
          controller.enqueue({ type: 'error', error: 'upstream failed' }); controller.close();
        } }) };
      } };
    const port = createRoutedModelPort({ catalog: null, createLanguageModel: async () => sdkModel,
      openRouterAccounts: { active: () => ({ accountId: context.servedAccount, authMode: 'api-key',
        token: async () => 'selected-key' }), onExhausted: () => null },
      openRouterRequestCapture: p.r.openRouterRequestCapture(p.headers) });
    p.headers.set('cookie', 'session=changed');
    const events: unknown[] = [];
    const pending = runLoopChatTurn({ chatId: 'chat', workspaceId: 'untrusted-caller-label',
      ownerId: 'another-untrusted-label', system: '', model: 'openrouter/vendor/model', port,
      transcript: [{ role: 'user', content: 'hello', ts: NOW.toISOString() }],
      sink: { event(_name, data) { events.push(data); } } });
    await vi.waitFor(() => expect(p.authorize).toHaveBeenCalledTimes(1));
    expect(wire).toBe(0); expect(p.createCapture).not.toHaveBeenCalled(); release();
    const result = await pending;
    expect(wire).toBe(1); expect(result.stopReason).toBe('error');
    expect(p.principal.mock.calls[0]![0].get('cookie')).toBe('session=original');
    expect(p.secret).toHaveBeenCalledExactlyOnceWith('env:SELECTED_KEY');
    expect(p.createCapture.mock.calls[0]![0]).toMatchObject({ request: authorized().request,
      context, credentialRef: 'env:SELECTED_KEY', isByok: true });
    expect(p.observations).toEqual([intent, { ...intent, response: { id: 'gen-hosted-test', modelId: context.modelId } }]);
    expect(JSON.stringify(events)).not.toMatch(/credentialSha256|SELECTED_KEY|selected-key|reservation-1|customer-workspace/);
  });

  it.each(['allowed', 'reader-denied', 'capture-failed'] as const)('composes the per-invocation native host with %s authenticated admission', async mode => {
    const p = await prepared(); let wire = 0;
    if (mode === 'reader-denied') p.authorize.mockResolvedValue(null);
    if (mode === 'capture-failed') p.capture.mockRejectedValue(new Error('private SQL credential=selected-key'));
    const sdkModel: LanguageModelV3 = { specificationVersion: 'v3', provider: 'fixture', modelId: context.modelId,
      supportedUrls: {}, async doGenerate() { throw new Error('unused'); }, async doStream() {
        wire++; expect(p.capture).toHaveBeenCalledWith(intent);
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: 'response-metadata', id: 'gen-native-test', modelId: context.modelId });
          controller.enqueue({ type: 'text-start', id: 'text' });
          controller.enqueue({ type: 'text-delta', id: 'text', delta: 'done' });
          controller.enqueue({ type: 'text-end', id: 'text' });
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          } });
          controller.close();
        } }) };
      } };
    // The trusted composition supplies session headers and the tenant-owned pool.
    // The invocation's workspace/run labels never reach the host factory.
    const factory = vi.fn((signal?: AbortSignal) => createRoutedModelPort({ catalog: null,
      createLanguageModel: async () => sdkModel,
      openRouterAccounts: { active: () => ({ accountId: context.servedAccount, authMode: 'api-key',
        token: async () => 'selected-key' }), onExhausted: () => null },
      openRouterRequestCapture: p.r.openRouterRequestCapture(p.headers, signal) }));
    const flushTelemetry = vi.fn(async () => {});
    const host = createOperatorOwnedLoopPort({ modelPort: factory, tools: [], flushTelemetry });
    const controller = new AbortController(); const events: unknown[] = [];
    const invoke = () => host.invoke({ role: 'worker', prompt: 'hello', model: 'openrouter/vendor/model',
      runId: 'caller-run-label', workspaceId: 'caller-workspace-label', harnessSlug: 'papercusp',
      featureId: null, chunkId: null, cwd: '/repo', projectDir: '/repo', stateDir: '/repo/.papercusp',
      signal: controller.signal, emit: event => events.push(event) });
    const first = await invoke();
    expect(first.exitCode).toBe(mode === 'allowed' ? 0 : 1);
    expect(wire).toBe(mode === 'allowed' ? 1 : 0);
    expect(factory).toHaveBeenCalledExactlyOnceWith(controller.signal);
    expect(p.principal).toHaveBeenCalledTimes(mode === 'allowed' ? 4 : mode === 'capture-failed' ? 3 : 1);
    if (mode === 'allowed') {
      expect(p.createCapture.mock.calls[0]![0].request.scope).toEqual(authorized().request.scope);
      p.principal.mockResolvedValue({ ok: false, reason: 'membership_not_active' });
      expect((await invoke()).exitCode).toBe(1);
      expect(factory).toHaveBeenCalledTimes(2); expect(p.principal).toHaveBeenCalledTimes(5);
      expect(wire).toBe(1); expect(p.createCapture).toHaveBeenCalledTimes(1);
    }
    expect(JSON.stringify({ events, first })).not.toMatch(/SELECTED_KEY|selected-key|reservation-1|customer-workspace|private SQL/);
    expect(flushTelemetry).toHaveBeenCalledTimes(mode === 'allowed' ? 2 : 1);
  });

  it.each(['controlWorkspaceId', 'organizationId', 'customerWorkspaceId'] as const)('refuses a foreign %s before resolving secrets or reserving', async field => {
    const p = await prepared(); const a = authorized();
    p.authorize.mockResolvedValue({ ...a, request: { ...a.request, scope: { ...a.request.scope, [field]: 'foreign' } } });
    await expect(p.r.openRouterRequestCapture(p.headers)(context)(intent)).rejects.toThrow('authorization or capture failed');
    expect(p.secret).not.toHaveBeenCalled(); expect(p.createCapture).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'permission', 'selection', 'local'] as const)('denies %s session authority before the commercial reader', async mode => {
    const p = await prepared(); const resolved = resolution();
    if (mode === 'revoked') p.principal.mockResolvedValue({ ok: false, reason: 'membership_not_active' });
    else {
      const principal = mode === 'permission' ? createHostedPrincipal({ ...resolved.principal, permissions: ['workspace:view'] })
        : mode === 'selection' ? createHostedPrincipal({ ...resolved.principal, selectedWorkspaceId: undefined })
          : { ...resolved.principal, profile: 'local' };
      p.principal.mockResolvedValue({ ...resolved, principal } as HostedPrincipalResolution);
    }
    await expect(p.r.openRouterRequestCapture(p.headers)(context)(intent)).rejects.toThrow('authorization or capture failed');
    expect(p.authorize).not.toHaveBeenCalled(); expect(p.createCapture).not.toHaveBeenCalled();
  });

  it.each(['different-key', 'unavailable-key', 'null-authority', 'reader-error'] as const)('denies %s without exposing private errors or retrying', async mode => {
    const p = await prepared();
    if (mode === 'different-key') p.secret.mockResolvedValue('different-key');
    if (mode === 'unavailable-key') p.secret.mockRejectedValue(new Error('secret=private credentialRef=env:SELECTED_KEY'));
    if (mode === 'null-authority') p.authorize.mockResolvedValue(null);
    if (mode === 'reader-error') p.authorize.mockRejectedValue(new Error('secret=private tenant=private'));
    const handler = p.r.openRouterRequestCapture(p.headers)(context);
    await expect(handler(intent)).rejects.toThrow(/^Hosted OpenRouter authorization or capture failed; reservation remains unresolved$/);
    await expect(handler(intent)).rejects.toThrow('not resumable');
    expect(p.authorize).toHaveBeenCalledTimes(1); expect(p.createCapture).not.toHaveBeenCalled();
  });

  it('re-resolves membership and requests a new reservation for every stream; a revocation stops the next request', async () => {
    const p = await prepared(); let id = 0;
    p.authorize.mockImplementation(async () => { const a = authorized(); return { ...a,
      request: { ...a.request, reservationId: 'reservation-' + ++id } }; });
    const factory = p.r.openRouterRequestCapture(p.headers);
    await factory(context)(intent); await factory(context)(intent);
    expect(p.principal).toHaveBeenCalledTimes(8); expect(p.authorize).toHaveBeenCalledTimes(2);
    expect(p.createCapture.mock.calls.map(([o]) => o.request.reservationId)).toEqual(['reservation-1', 'reservation-2']);
    p.principal.mockResolvedValue({ ok: false, reason: 'membership_not_active' });
    await expect(factory(context)(intent)).rejects.toThrow('authorization or capture failed');
    expect(p.createCapture).toHaveBeenCalledTimes(2);
  });

  it('snapshots tenant and authority before asynchronous secret resolution', async () => {
    const p = await prepared(); const a = authorized(); p.authorize.mockResolvedValue(a);
    p.secret.mockImplementation(async () => {
      (a.request.scope as { organizationId: string }).organizationId = 'mutated';
      (a as { credentialRef: string }).credentialRef = 'env:CHANGED_KEY';
      return 'selected-key';
    });
    await p.r.openRouterRequestCapture(p.headers)(context)(intent);
    expect(p.createCapture.mock.calls[0]![0]).toMatchObject({ request: { scope: { organizationId: ORG } },
      credentialRef: 'env:SELECTED_KEY' });
  });

  it.each(['abort', 'concurrent'] as const)('does not reserve after an overlapping %s during authority lookup', async mode => {
    const p = await prepared(); const controller = new AbortController(); let release!: () => void;
    p.authorize.mockImplementation(() => new Promise(resolve => { release = () => resolve(authorized()); }));
    const handler = p.r.openRouterRequestCapture(p.headers, controller.signal)(context);
    const pending = handler(intent); const rejected = expect(pending).rejects.toThrow('authorization or capture failed');
    await vi.waitFor(() => expect(p.authorize).toHaveBeenCalledTimes(1));
    if (mode === 'abort') controller.abort();
    else await expect(handler(intent)).rejects.toThrow('not resumable');
    release(); await rejected; expect(p.createCapture).not.toHaveBeenCalled();
  });

  it('retains a capture failure and never recreates authorization or the durable handler', async () => {
    const p = await prepared(); p.capture.mockRejectedValue(new Error('private SQL failure'));
    const handler = p.r.openRouterRequestCapture(p.headers)(context);
    await expect(handler(intent)).rejects.toThrow('reservation remains unresolved');
    await expect(handler(intent)).rejects.toThrow('not resumable');
    expect(p.authorize).toHaveBeenCalledTimes(1); expect(p.createCapture).toHaveBeenCalledTimes(1);
  });

  it('refuses an unconfigured host and an identity frame without dispatch intent', async () => {
    const r = await runtime({ config: { stripeSecretKeyRef: null, stripeWebhookSecretRef: null } });
    await expect(r.openRouterRequestCapture(new Headers())(context)(intent)).rejects.toThrow('authorization or capture failed');
    const p = await prepared();
    await expect(p.r.openRouterRequestCapture(p.headers)(context)({ ...intent, response: { id: 'gen-too-early' } }))
      .rejects.toThrow('authorization or capture failed');
    expect(p.principal).not.toHaveBeenCalled(); expect(p.createCapture).not.toHaveBeenCalled();
  });
});

const post = (init: { cookie?: string; origin?: string | null; body?: unknown } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.cookie) headers.set('cookie', `session=${init.cookie}`);
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
  return { method: 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) };
};

const get = (cookie?: string): RequestInit => ({ headers: cookie ? { cookie: `session=${cookie}` } : {} });

function signedWebhook(rawBody: string, secret = WEBHOOK_SECRET, at = NOW) {
  const t = Math.floor(at.getTime() / 1000);
  return {
    method: 'POST',
    headers: { 'stripe-signature': `t=${t},v1=${computeStripeSignature(secret, t, rawBody)}`, 'content-type': 'application/json' },
    body: rawBody,
  };
}

const subscriptionEvent = (id = 'evt_1', status = 'active', extra: Record<string, unknown> = {}) => JSON.stringify({
  id,
  type: 'customer.subscription.updated',
  created: 1_790_000_000,
  livemode: false,
  data: {
    object: {
      id: 'sub_A',
      customer: 'cus_A',
      status,
      cancel_at_period_end: false,
      canceled_at: null,
      metadata: { organizationId: ORG },
      items: { data: [{ price: { id: 'price_team' }, current_period_end: 1_792_000_000 }] },
    },
  },
  ...extra,
});

const activeSnapshot = (status: HostedSubscriptionSnapshot['status'] = 'active'): HostedSubscriptionSnapshot => ({
  organizationId: ORG,
  stripeSubscriptionId: 'sub_A',
  status,
  planKey: null,
  priceId: 'price_team',
  currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  canceledAt: null,
  livemode: false,
  latestInvoiceStatus: 'paid',
});

describe('hosted usage production collector composition', () => {
  it('uses durable server generation bindings and the bound key through authenticated usage routes, without publishing binding metadata', async () => {
    const records: HostedUsageRecord[] = [];
    const readOpenRouterBindings = vi.fn(async (input) => [{
      scope: { ...input.scope, customerWorkspaceId: 'customer-bound' }, generationId: 'gen-runtime-recorded',
      payer: 'consumption' as const, isByok: false, credentialRef: 'env:EXECUTION_OPENROUTER_KEY',
      credentialSha256: createHash('sha256').update('runtime-key').digest('hex'),
      revision: 2, occurredAtMs: NOW.getTime() - 1000, observedAtMs: NOW.getTime(), evidenceRef: 'execution:metadata-read',
    }]);
    const usageStore = { readOpenRouterBindings, readRecords: vi.fn(async () => records),
      append: vi.fn(async (r: HostedUsageRecord) => { records.push(r); return 'recorded' as const; }) };
    const resolveSecret = vi.fn(async () => 'runtime-key');
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"data":{"id":"gen-runtime-recorded","is_byok":false,"total_cost":0.0000001,"prompt":"private"}}'));
    const { app } = await runtime({ config: { stripeSecretKeyRef: null, stripeWebhookSecretRef: null },
      deps: { usageStore, resolveSecret, fetchImpl } });
    expect((await app.request('/api/hosted/billing/usage?month=2026-10', get())).status).toBe(401);
    expect(readOpenRouterBindings).not.toHaveBeenCalled(); expect(resolveSecret).not.toHaveBeenCalled();
    const response = await app.request('/api/hosted/billing/usage?month=2026-10', get('owner'));
    expect(response.status).toBe(200);
    expect(readOpenRouterBindings).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledWith('env:EXECUTION_OPENROUTER_KEY', expect.any(AbortSignal));
    expect(usageStore.append).toHaveBeenCalledTimes(1);
    const body = await response.text();
    expect(body).toContain('"reportedMicrosExact":"0.1"'); expect(body).toContain('"settlementEligible":false');
    expect(body).not.toMatch(/credential|sha256|runtime-key|private|EXECUTION_OPENROUTER/);
  });
});

// ── configuration ───────────────────────────────────────────────────────────

describe('hosted billing configuration parsing', () => {
  it('production requires pinned Secret Manager references for both Stripe secrets', () => {
    const ref = `${GCP_SECRET_REF_PREFIX}projects/123456789012/locations/us-central1/secrets/test-stripe/versions/2`;
    const env = { PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'production', PAPERCUSP_HOSTED_PUBLIC_ORIGIN: ORIGIN,
      PAPERCUSP_STRIPE_SECRET_KEY_REF: ref, PAPERCUSP_STRIPE_WEBHOOK_SECRET_REF: ref };
    expect(readHostedBillingRuntimeConfiguration(env)).toMatchObject({ requireManagedSecrets: true });
    for (const name of ['PAPERCUSP_STRIPE_SECRET_KEY_REF', 'PAPERCUSP_STRIPE_WEBHOOK_SECRET_REF']) {
      for (const value of ['', 'env:KEY', 'file:/run/secret', 'integration:STRIPE_KEY', ref.replace('/2', '/latest')]) {
        expect(() => readHostedBillingRuntimeConfiguration({ ...env, [name]: value })).toThrow('requires_pinned_secret_manager');
      }
    }
  });

  it('refuses a manually assembled production billing config before reading local secrets', async () => {
    const resolveSecret = vi.fn(async () => 'must-not-read');
    await expect(runtime({ config: { requireManagedSecrets: true }, deps: { resolveSecret } }))
      .rejects.toThrow('requires_pinned_secret_manager');
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it('accepts an absent or valid expected Stripe account and refuses a malformed identity', () => {
    expect(parseStripeAccountId(undefined)).toBeNull();
    expect(parseStripeAccountId(' acct_papercusp ')).toBe('acct_papercusp');
    expect(() => parseStripeAccountId('cus_other')).toThrow('PAPERCUSP_STRIPE_ACCOUNT_ID');
    expect(() => parseStripeAccountId('acct_x/other')).toThrow('PAPERCUSP_STRIPE_ACCOUNT_ID');
  });
  it('accepts an absent or valid portal configuration id and refuses a malformed one', () => {
    expect(parseStripePortalConfigurationId(undefined)).toBeNull();
    expect(parseStripePortalConfigurationId('   ')).toBeNull();
    expect(parseStripePortalConfigurationId(' bpc_1ULZRf ')).toBe('bpc_1ULZRf');
    expect(() => parseStripePortalConfigurationId('pc_123')).toThrow('PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID');
    expect(() => parseStripePortalConfigurationId('bpc_1;drop')).toThrow('PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID');
  });

  it('parses the plan list strictly: malformed JSON, bad ids and duplicate keys are configuration errors', () => {
    expect(parseHostedBillingPlans(undefined)).toEqual([]);
    expect(parseHostedBillingPlans('[{"planKey":"team","priceId":"price_1","label":" Team "}]'))
      .toEqual([{ planKey: 'team', priceId: 'price_1', label: 'Team', description: null }]);
    expect(() => parseHostedBillingPlans('{')).toThrow('PAPERCUSP_HOSTED_BILLING_PLANS');
    expect(() => parseHostedBillingPlans('{"planKey":"team"}')).toThrow('PAPERCUSP_HOSTED_BILLING_PLANS');
    expect(() => parseHostedBillingPlans('[{"planKey":"team","priceId":"prod_1","label":"T"}]')).toThrow('[0]');
    expect(() => parseHostedBillingPlans(
      '[{"planKey":"team","priceId":"price_1","label":"T"},{"planKey":"team","priceId":"price_2","label":"U"}]',
    )).toThrow('[1]');
    expect(() => parseHostedBillingPlans(
      '[{"planKey":"team","priceId":"price_1","label":"T"},{"planKey":"pro","priceId":"price_1","label":"U"}]',
    )).toThrow('[1]');
    expect(() => parseHostedBillingPlans(JSON.stringify([{ planKey: 'team', priceId: 'price_1', label: 'T',
      entitlementBundle: { bundleId: 'label-only' } }]))).toThrow('hosted_paid_policy_invalid');
  });

  it('loads an explicit versioned resource policy without exposing it in the public plan list', async () => {
    const bundle = { schemaVersion: 1, bundleId: 'paid-team', bundleVersion: 1,
      record: { source: 'billing', actor: { kind: 'service', principalId: 'service:billing' },
        auditReceiptId: 'policy:team:1', effectiveFrom: '2026-01-01T00:00:00Z', effectiveUntil: null },
      entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 5 }, browserAccess: { pty: true, files: true },
        supportTier: 'paid', quotas: { 'pool.agents': 20, 'pool.hosts': 2, 'pool.cpu-millicores': 8000, 'pool.memory-mib': 16384,
          'pool.db-gib': 256, 'pool.workspace-gib': 32 }, budgets: { 'pool.cost.usd.minor': 10000 }, rolloutFlags: {} } };
    const plans = parseHostedBillingPlans(JSON.stringify([{ planKey: 'team', priceId: 'price_1', label: 'T', entitlementBundle: bundle }]));
    expect(plans[0]!.entitlementBundle).toMatchObject({ bundleId: 'paid-team', bundleVersion: 1 });
    const runtime = await createHostedBillingRuntime({ publicOrigin: ORIGIN, stripeSecretKeyRef: null, stripeWebhookSecretRef: null, plans },
      { resolvePrincipal: async () => ({ ok: false, reason: 'session_cookie_missing' }), store: new MemoryBillingStore() });
    const response = await runtime.mounted.find(route => route.path === '/hosted/billing/plans')!.handler(new Request(`${ORIGIN}/api/hosted/billing/plans`), { principal: null });
    expect((await response.json()).plans).toEqual([{ planKey: 'team', label: 'T', description: null }]);
  });

  it('reads the runtime configuration from the environment and requires the public origin', () => {
    expect(() => readHostedBillingRuntimeConfiguration({})).toThrow('PAPERCUSP_HOSTED_PUBLIC_ORIGIN');
    expect(readHostedBillingRuntimeConfiguration({
      PAPERCUSP_HOSTED_PUBLIC_ORIGIN: ORIGIN,
      PAPERCUSP_STRIPE_SECRET_KEY_REF: ' file:/run/stripe-key ',
      PAPERCUSP_HOSTED_BILLING_PLANS: '[{"planKey":"team","priceId":"price_1","label":"Team"}]',
      PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_9',
    })).toEqual({
      publicOrigin: ORIGIN,
      stripeSecretKeyRef: 'file:/run/stripe-key',
      stripeWebhookSecretRef: null,
      plans: [{ planKey: 'team', priceId: 'price_1', label: 'Team', description: null }],
      stripePortalConfigurationId: 'bpc_9',
      stripeAccountId: null,
      receiptsWorkspaceId: null,
    });
    expect(readHostedBillingRuntimeConfiguration({
      PAPERCUSP_HOSTED_PUBLIC_ORIGIN: ORIGIN,
      PAPERCUSP_HOSTED_BILLING_RECEIPTS_WORKSPACE_ID: ' papercusp-workspace ',
    }).receiptsWorkspaceId).toBe('papercusp-workspace');
  });

  it('accepts an absent or valid receipts workspace id and refuses a malformed one', () => {
    expect(parseReceiptsWorkspaceId(undefined)).toBeNull();
    expect(parseReceiptsWorkspaceId('  ')).toBeNull();
    expect(parseReceiptsWorkspaceId('ws_platform-1.prod')).toBe('ws_platform-1.prod');
    expect(() => parseReceiptsWorkspaceId('ws;drop')).toThrow('PAPERCUSP_HOSTED_BILLING_RECEIPTS_WORKSPACE_ID');
    expect(() => parseReceiptsWorkspaceId('-leading-dash')).toThrow('PAPERCUSP_HOSTED_BILLING_RECEIPTS_WORKSPACE_ID');
  });
});

// ── runtime composition ─────────────────────────────────────────────────────

describe('createHostedBillingRuntime', () => {
  it('checks the configured Stripe account before admitting billing', async () => {
    const built = await runtime({ config: { stripeAccountId: 'acct_papercusp' }, stripe: [{ body: { id: 'acct_papercusp' } }] });
    expect(built.configured).toBe(true);
    expect(built.stripe.calls[0].url).toBe('https://api.stripe.com/v1/account');
    expect(built.stripe.calls[0].headers.Authorization).toBe('Bearer sk_test_key123');
  });

  it.each([
    [{ body: { id: 'acct_wrong_business' } }, 'stripe_account_mismatch'],
    [{ status: 401, body: { error: { message: 'expired' } } }, 'stripe_account_unavailable'],
    [{ body: {} }, 'stripe_account_unavailable'],
  ])('fails closed when the credential account cannot satisfy its pin', async (response, reason) => {
    const built = await runtime({ config: { stripeAccountId: 'acct_papercusp' }, stripe: [response] });
    expect(built.configured).toBe(false);
    expect(built.unavailableReason).toBe(reason);
    const checkout = await built.app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(checkout.status).toBe(503);
    expect(built.stripe.calls).toHaveLength(1);
  });

  it('refuses billing on account verification transport failure without exposing the error', async () => {
    const built = await runtime({ config: { stripeAccountId: 'acct_papercusp' }, deps: { fetchImpl: (async () => { throw new Error('sensitive provider details'); }) as typeof fetch } });
    expect(built.unavailableReason).toBe('stripe_account_unavailable');
    expect(built.configured).toBe(false);
  });

  it('keeps both cloud offers distinct and never exposes provider price ids', async () => {
    const offers = [
      { planKey: 'papercusp-cloud', priceId: 'price_hosted', label: 'Papercusp cloud', description: 'Managed by Papercusp' },
      { planKey: 'byoc-cloud', priceId: 'price_byoc', label: 'Bring your own cloud', description: 'Runs in your cloud account' },
    ];
    const built = await runtime({ config: { plans: offers } });
    const body = await (await built.app.request('/api/hosted/billing/plans')).json();
    expect(body.plans).toEqual(offers.map(({ priceId: _priceId, ...publicOffer }) => publicOffer));
    expect(body.livemode).toBe(false);
  });
  it('mounts exactly the declared surface', async () => {
    const built = await runtime();
    expect(built.mounted.map((r) => `${r.method} ${r.path}`)).toEqual(HOSTED_BILLING_RUNTIME_MOUNTED_ROUTE_KEYS);
    expect(built.configured).toBe(true);
    expect(built.unavailableReason).toBeNull();
  });

  it.each([
    ['no secret refs', { stripeSecretKeyRef: null, stripeWebhookSecretRef: null }, 'billing_not_configured'],
    ['no plans', { plans: [] }, 'no_plans_configured'],
    ['a webhook secret that is not whsec_', { stripeWebhookSecretRef: 'env:NOT_A_WHSEC' }, 'invalid_webhook_secret'],
    ['a live key without the owner flag', { stripeSecretKeyRef: 'env:STRIPE_LIVE_KEY' }, 'live_mode_not_allowed'],
  ] as const)('stays mounted but unconfigured with %s', async (_label, config, reason) => {
    const built = await runtime({ config });
    expect(built.configured).toBe(false);
    expect(built.unavailableReason).toBe(reason);
    const plans = await (await built.app.request('/api/hosted/billing/plans')).json();
    expect(plans).toMatchObject({ ok: true, configured: false, unavailableReason: reason });
    const checkout = await built.app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(checkout.status).toBe(503);
    expect(await checkout.json()).toMatchObject({ error: { code: 'billing_unavailable', safeMessage: reason } });
    const webhook = await built.app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent()));
    expect(webhook.status).toBe(503);
  });

  it('a live key constructs only when the live-mode flag reads true, and a flag read failure refuses', async () => {
    const live = await runtime({ config: { stripeSecretKeyRef: 'env:STRIPE_LIVE_KEY' }, deps: { liveModeAllowed: async () => true } });
    expect(live.configured).toBe(true);
    expect(await (await live.app.request('/api/hosted/billing/plans')).json()).toMatchObject({ livemode: true });
    const broken = await runtime({
      config: { stripeSecretKeyRef: 'env:STRIPE_LIVE_KEY' },
      deps: { liveModeAllowed: async () => { throw new Error('flags down'); } },
    });
    expect(broken.unavailableReason).toBe('live_mode_not_allowed');
  });
});

// ── public plan list ────────────────────────────────────────────────────────

describe('GET /hosted/billing/plans', () => {
  it('is public and never exposes Stripe price ids', async () => {
    const { app } = await runtime();
    const response = await app.request('/api/hosted/billing/plans');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      configured: true,
      livemode: false,
      unavailableReason: null,
      plans: [{ planKey: 'team', label: 'Team', description: 'For teams' }],
    });
    expect(JSON.stringify(body)).not.toContain('price_team');
  });
});

// ── authority ───────────────────────────────────────────────────────────────

describe('route authority', () => {
  it.each([
    [undefined, 401, 'unauthorized'],
    ['revoked', 403, 'forbidden'],
    ['outage', 503, 'authority_unavailable'],
  ] as const)('subscription with session %s → %i', async (cookie, status, code) => {
    const { app } = await runtime();
    const response = await app.request('/api/hosted/billing/subscription', get(cookie));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, error: { code } });
  });

  it('a member who can view but not manage billing is refused checkout and portal before any Stripe call', async () => {
    const { app, stripe } = await runtime();
    for (const path of ['/api/hosted/billing/checkout', '/api/hosted/billing/portal']) {
      const response = await app.request(path, post({ cookie: 'member', body: { planKey: 'team' } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden', message: 'permission_missing' } });
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it('refuses cross-origin and origin-less mutating requests (CSRF) before any Stripe call', async () => {
    const { app, stripe } = await runtime();
    for (const origin of ['https://evil.example', null]) {
      for (const path of ['/api/hosted/billing/checkout', '/api/hosted/billing/portal']) {
        const response = await app.request(path, post({ cookie: 'owner', origin, body: { planKey: 'team' } }));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'cross_origin_blocked' } });
      }
    }
    expect(stripe.calls).toHaveLength(0);
  });
});

// ── subscription read ───────────────────────────────────────────────────────

describe('GET /hosted/billing/subscription', () => {
  it('a member with no subscription sees not_subscribed and cannot manage', async () => {
    const { app } = await runtime();
    const body = await (await app.request('/api/hosted/billing/subscription', get('member'))).json();
    expect(body).toMatchObject({
      ok: true,
      configured: true,
      canManage: false,
      subscription: null,
      entitlement: { entitled: false, reason: 'not_subscribed', bundleKey: null, providerId: 'stub:plan-key-bundle' },
    });
  });

  it('reports the active subscription with its configured plan label and the stub entitlement', async () => {
    const { app, store } = await runtime();
    store.subscription = activeSnapshot();
    const body = await (await app.request('/api/hosted/billing/subscription', get('owner'))).json();
    expect(body).toMatchObject({
      canManage: true,
      subscription: {
        status: 'active',
        planKey: 'team',
        planLabel: 'Team',
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        latestInvoiceStatus: 'paid',
      },
      entitlement: { entitled: true, reason: 'active', bundleKey: 'hosted-paid:team', patch: null },
    });
  });

  it('asks the injected entitlement provider, never deciding policy itself', async () => {
    const entitlementFor = vi.fn(() => ({
      entitled: true, reason: 'active' as const, bundleKey: 'metered:team', patch: null, source: 'billing' as const, providerId: 'metering',
    }));
    const { app, store } = await runtime({ deps: { entitlementProvider: { id: 'metering', entitlementFor } } });
    store.subscription = activeSnapshot();
    const body = await (await app.request('/api/hosted/billing/subscription', get('owner'))).json();
    expect(body.entitlement).toMatchObject({ bundleKey: 'metered:team', providerId: 'metering' });
    expect(entitlementFor).toHaveBeenCalledWith(expect.objectContaining({ planKey: 'team' }), NOW);
  });

  it('a store outage is 503, not an empty subscription', async () => {
    const { app, store } = await runtime();
    store.failReads = true;
    const response = await app.request('/api/hosted/billing/subscription', get('owner'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'billing_store_unavailable' } });
  });
});

// ── checkout ────────────────────────────────────────────────────────────────

describe('POST /hosted/billing/checkout', () => {
  it('creates the org customer once, then a subscription Checkout returning to the hosted origin', async () => {
    const { app, store, stripe } = await runtime({
      stripe: [
        { body: { id: 'cus_new' } },
        { body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' } },
        { body: { id: 'cs_2', url: 'https://checkout.stripe.com/c/cs_2' } },
      ],
    });
    const first = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/cs_1' });
    expect(store.customers.get(ORG)).toEqual({ organizationId: ORG, stripeCustomerId: 'cus_new', livemode: false });

    expect(stripe.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/customers', '/v1/checkout/sessions']);
    const session = stripe.calls[1]!;
    expect(session.form.get('customer')).toBe('cus_new');
    expect(session.form.get('line_items[0][price]')).toBe('price_team');
    expect(session.form.get('success_url')).toBe(`${ORIGIN}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    expect(session.form.get('cancel_url')).toBe(`${ORIGIN}/billing?checkout=canceled`);
    const window = Math.floor(NOW.getTime() / 600_000);
    expect(session.headers['idempotency-key']).toBe(`papercusp-sub-checkout:${ORG}:team:${window}`);

    // A second attempt reuses the recorded customer — no second /customers call.
    await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(stripe.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/customers', '/v1/checkout/sessions', '/v1/checkout/sessions']);
  });

  it('refuses an unknown plan key without calling Stripe', async () => {
    const { app, stripe } = await runtime();
    for (const body of [{ planKey: 'enterprise' }, { planKey: 7 }, {}]) {
      const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'unknown_plan' } });
    }
    expect(stripe.calls).toHaveLength(0);
  });

  it.each(['trialing', 'active', 'past_due', 'unpaid', 'paused'] as const)(
    'refuses a second subscription while one is %s',
    async (status) => {
      const { app, store, stripe } = await runtime();
      store.subscription = activeSnapshot(status);
      const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'already_subscribed' } });
      expect(stripe.calls).toHaveLength(0);
    },
  );

  it('allows a fresh subscription after the previous one was canceled', async () => {
    const { app, store } = await runtime({ stripe: [{ body: { id: 'cus_1' } }, { body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' } }] });
    store.subscription = activeSnapshot('canceled');
    const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(response.status).toBe(200);
  });

  it('refuses a customer recorded in the other Stripe mode', async () => {
    const { app, store, stripe } = await runtime();
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_live', livemode: true });
    const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'customer_mode_mismatch' } });
    expect(stripe.calls).toHaveLength(0);
  });

  it('a Stripe failure is 502 and never echoes the provider message', async () => {
    const { app, store } = await runtime({ stripe: [{ status: 402, body: { error: { message: 'sk_test_secret leaked?' } } }] });
    const response = await app.request('/api/hosted/billing/checkout', post({ cookie: 'owner', body: { planKey: 'team' } }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('provider_error');
    expect(text).not.toContain('sk_test');
    expect(store.customers.size).toBe(0);
  });
});

// ── customer portal ─────────────────────────────────────────────────────────

describe('POST /hosted/billing/portal', () => {
  it('needs an existing billing customer', async () => {
    const { app, stripe } = await runtime();
    const response = await app.request('/api/hosted/billing/portal', post({ cookie: 'owner' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'no_billing_customer' } });
    expect(stripe.calls).toHaveLength(0);
  });

  it('opens the portal with the explicit configuration and the hosted return URL', async () => {
    const { app, store, stripe } = await runtime({ stripe: [{ body: { url: 'https://billing.stripe.com/p/session_1' } }] });
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_A', livemode: false });
    const response = await app.request('/api/hosted/billing/portal', post({ cookie: 'owner' }));
    expect(await response.json()).toEqual({ ok: true, url: 'https://billing.stripe.com/p/session_1' });
    expect(new URL(stripe.calls[0]!.url).pathname).toBe('/v1/billing_portal/sessions');
    expect(stripe.calls[0]!.form.get('customer')).toBe('cus_A');
    expect(stripe.calls[0]!.form.get('configuration')).toBe('bpc_123');
    expect(stripe.calls[0]!.form.get('return_url')).toBe(`${ORIGIN}/billing`);
  });

  it("falls back to the account's default configuration when none is configured", async () => {
    const { app, store, stripe } = await runtime({
      config: { stripePortalConfigurationId: null },
      stripe: [{ body: { url: 'https://billing.stripe.com/p/session_2' } }],
    });
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_A', livemode: false });
    await app.request('/api/hosted/billing/portal', post({ cookie: 'owner' }));
    expect(stripe.calls[0]!.form.has('configuration')).toBe(false);
  });
});

// ── payment receipts (P-046, WI-10004802) ───────────────────────────────────

const RECEIPT_CREATED = 1_790_000_000;
const anchoredEntry = (id: string): CustomerReceiptEntry => ({
  balanceTransactionId: id,
  created: RECEIPT_CREATED + 60,
  amount: 2500,
  currency: 'usd',
  result: { ok: true, receipt: { format: 'papercusp.payment-receipt', transaction: { id } } as never },
});
const pendingEntry = (id: string): CustomerReceiptEntry => ({
  balanceTransactionId: id,
  created: RECEIPT_CREATED,
  amount: 1000,
  currency: 'usd',
  result: { ok: false, error: 'not-in-log' },
});

describe('GET /hosted/billing/receipts', () => {
  it('answers 503 receipts_unavailable when no receipts source is configured', async () => {
    const { app } = await runtime();
    const response = await app.request('/api/hosted/billing/receipts', get('owner'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'receipts_unavailable' } });
  });

  it('refuses a member who cannot manage billing before the receipts source is asked', async () => {
    const receipts = vi.fn(async () => [anchoredEntry('txn_a')]);
    const { app, store } = await runtime({ deps: { receipts } });
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_A', livemode: false });
    const member = await app.request('/api/hosted/billing/receipts', get('member'));
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: { code: 'forbidden', message: 'permission_missing' } });
    const anonymous = await app.request('/api/hosted/billing/receipts', get());
    expect(anonymous.status).toBe(401);
    expect(receipts).not.toHaveBeenCalled();
  });

  it('an organization with no billing customer has an empty list and the source is never asked', async () => {
    const receipts = vi.fn(async () => [anchoredEntry('txn_a')]);
    const { app } = await runtime({ deps: { receipts } });
    const response = await app.request('/api/hosted/billing/receipts', get('owner'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, receipts: [] });
    expect(receipts).not.toHaveBeenCalled();
  });

  it("asks the source for the org's own customer only, and reports anchored and pending receipts in its order", async () => {
    const receipts = vi.fn(async () => [anchoredEntry('txn_b'), pendingEntry('txn_a')]);
    const { app, store } = await runtime({ deps: { receipts } });
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_A', livemode: false });
    store.customers.set('other-org', { organizationId: 'other-org', stripeCustomerId: 'cus_OTHER', livemode: false });
    const response = await app.request('/api/hosted/billing/receipts', get('owner'));
    expect(receipts.mock.calls).toEqual([['cus_A']]);
    expect(await response.json()).toEqual({
      ok: true,
      receipts: [
        {
          balanceTransactionId: 'txn_b',
          created: new Date((RECEIPT_CREATED + 60) * 1000).toISOString(),
          amount: 2500,
          currency: 'usd',
          status: 'anchored',
          pendingReason: null,
          receipt: { format: 'papercusp.payment-receipt', transaction: { id: 'txn_b' } },
        },
        {
          balanceTransactionId: 'txn_a',
          created: new Date(RECEIPT_CREATED * 1000).toISOString(),
          amount: 1000,
          currency: 'usd',
          status: 'not-yet-anchored',
          pendingReason: 'not-in-log',
          receipt: null,
        },
      ],
    });
  });

  it('a billing-store or receipts-source outage is 503, never an empty list', async () => {
    const failing = await runtime({ deps: { receipts: async () => { throw new Error('ledger down'); } } });
    failing.store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_A', livemode: false });
    const sourceDown = await failing.app.request('/api/hosted/billing/receipts', get('owner'));
    expect(sourceDown.status).toBe(503);
    expect(await sourceDown.json()).toMatchObject({ error: { code: 'receipts_unavailable' } });

    const storeDown = await runtime({ deps: { receipts: async () => [] } });
    storeDown.store.failReads = true;
    const response = await storeDown.app.request('/api/hosted/billing/receipts', get('owner'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'billing_store_unavailable' } });
  });

  it('a configured receipts workspace reads inside that workspace context', async () => {
    const seen: string[] = [];
    const { app, store } = await runtime({
      config: { receiptsWorkspaceId: 'ws-platform' },
      deps: {
        runWorkspace: async <T,>(workspaceId: string) => {
          seen.push(workspaceId);
          return [] as unknown as T;
        },
      },
    });
    store.customers.set(ORG, { organizationId: ORG, stripeCustomerId: 'cus_A', livemode: false });
    const response = await app.request('/api/hosted/billing/receipts', get('owner'));
    expect(await response.json()).toEqual({ ok: true, receipts: [] });
    expect(seen).toEqual(['ws-platform']);
  });
});

// ── webhook ─────────────────────────────────────────────────────────────────

describe('POST /hosted/billing/webhook', () => {
  it('refuses an unsigned, mis-signed or stale delivery before parsing, recording nothing', async () => {
    const { app, store } = await runtime();
    const body = subscriptionEvent();
    const unsigned = await app.request('/api/hosted/billing/webhook', { method: 'POST', body });
    expect(unsigned.status).toBe(400);
    expect(await unsigned.json()).toMatchObject({ error: { code: 'missing-signature' } });
    const wrongSecret = await app.request('/api/hosted/billing/webhook', signedWebhook(body, 'whsec_someoneelse'));
    expect(await wrongSecret.json()).toMatchObject({ error: { code: 'bad-signature' } });
    const stale = await app.request('/api/hosted/billing/webhook', signedWebhook(body, WEBHOOK_SECRET, new Date(NOW.getTime() - 3_600_000)));
    expect(await stale.json()).toMatchObject({ error: { code: 'stale-timestamp' } });
    expect(store.events.size).toBe(0);
  });

  it('applies a signed subscription event in the configured mode with the configured plan mapping', async () => {
    const { app, store } = await runtime();
    const body = subscriptionEvent();
    const response = await app.request('/api/hosted/billing/webhook', signedWebhook(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: 'applied' });
    expect(store.applied).toHaveLength(1);
    expect(store.applied[0]).toMatchObject({ expectedLivemode: false, planKey: 'team', event: { eventId: 'evt_1' } });
    expect(store.events.get('evt_1')).toBe(webhookBodyDigest(body));
  });

  it('a byte-identical redelivery is a duplicate; the same id with different bytes is a 409 replay', async () => {
    const { app } = await runtime();
    await app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent()));
    const again = await app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent()));
    expect(await again.json()).toEqual({ ok: true, outcome: 'duplicate' });
    const tampered = await app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent('evt_1', 'canceled')));
    expect(tampered.status).toBe(409);
    expect(await tampered.json()).toMatchObject({ error: { code: 'replay-mismatch' } });
  });

  it('acknowledges (2xx) and records a signed event it cannot attribute, so Stripe stops retrying', async () => {
    const { app, store } = await runtime();
    const orphan = JSON.parse(subscriptionEvent('evt_orphan'));
    orphan.data.object.metadata = {};
    const response = await app.request('/api/hosted/billing/webhook', signedWebhook(JSON.stringify(orphan)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: 'rejected', code: 'missing-organization' });
    expect(store.rejected).toEqual([{ eventId: 'evt_orphan', code: 'missing-organization' }]);
    expect(store.applied).toHaveLength(0);
  });

  it('a signed body that is not a Stripe event is 400 and is not recorded', async () => {
    const { app, store } = await runtime();
    const response = await app.request('/api/hosted/billing/webhook', signedWebhook('{"hello":"world"}'));
    expect(response.status).toBe(400);
    expect(store.events.size).toBe(0);
  });

  it('a store failure is a non-2xx so Stripe redelivers', async () => {
    const observed: unknown[] = [];
    const { app, store } = await runtime({ deps: { observeFailure: async observation => { observed.push(observation); } } });
    store.applyEvent = async () => { throw new Error('connection reset'); };
    const response = await app.request('/api/hosted/billing/webhook', signedWebhook(subscriptionEvent()));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'billing_store_unavailable' } });
    expect(observed).toEqual([{ failureClass: 'endpoint-store-unavailable', eventId: 'evt_1' }]);
  });
});
