/**
 * @vitest-environment jsdom
 *
 * CupboardDetailPage — direct-execution actions.
 *
 * blueprint "Fork" (official-blueprints-cupboard-publish-2026-06-05 P-004):
 * POSTs /api/cupboard/install-blueprint {listingId,potSlug} — clone + validate +
 * dep-check into ~/.papercusp/blueprints/<id>/ — WITHOUT installPlugins (the
 * consent for plugin deps stays explicit; the toast lists installables).
 *
 * plugin / pack "Install" (EI-27): POSTs /api/cupboard/install-plugin
 * {listingId} — clone the listing repo into global-plugins — and surfaces the
 * manifest's requested capabilities + installable deps in a toast. No
 * harness/acceptCapabilities (per-harness capability consent stays explicit at
 * enable-time). Replaces the dead `/harness?cupboardListing=…` navigation no
 * consumer read.
 *
 * (The snapshot "Fork" cases were removed when the `snapshot` listing kind was
 * retired — retire-snapshots-instance-spec-2026-06-09 D-005; reproducible clone
 * is now the lightweight InstanceSpec, not a published Cupboard snapshot.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';

const h = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));

vi.mock('@/lib/router-compat/navigation', () => ({
  useRouter: () => ({ push: h.push, back: h.back }),
  useParams: () => ({ id: 'bp-listing-1' }),
}));
vi.mock('@/app/adv/create/use-create-data', () => ({
  useResolvedHarnessSlug: () => 'sales-hive',
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import CupboardDetailPage from '../[id]/page';

function listingBase(overrides: Partial<HarnessListing>): HarnessListing {
  return {
    id: 'bp-listing-1' as unknown as number, // worker ids are string uuids
    slug: 'demo-blueprint',
    title: 'Demo blueprint',
    description: 'a published blueprint',
    harness_link: '',
    listing_kind: 'blueprint',
    listing_ref: 'review',
    github_repository_id: 7,
    github_repo: 'papercupai/demo',
    github_repo_must_be_public: true,
    published_by_github_user_id: 10,
    provisional_owner_github_user_id: 10,
    claim_status: 'unclaimed',
    claimed_at: null,
    last_permission_verified_at: null,
    superseded_by_harness_id: null,
    contributor_count_estimate: 0,
    last_activity_at: null,
    language: null,
    tags: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function blueprintListing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return listingBase({ listing_kind: 'blueprint', listing_ref: 'review', ...overrides });
}

function pluginListing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return listingBase({
    slug: 'demo-plugin',
    title: 'Demo plugin',
    description: 'a published plugin',
    listing_kind: 'plugin',
    listing_ref: 'demo-plugin',
    ...overrides,
  });
}

function rubricListing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return listingBase({
    slug: 'release-readiness',
    title: 'Release readiness',
    description: 'Grades whether a release is ready to ship.',
    listing_kind: 'rubric',
    listing_ref: 'release-readiness',
    github_repo: 'acme/rubrics',
    ...overrides,
  });
}

function planListing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return listingBase({
    slug: 'release-plan',
    title: 'Release plan',
    description: 'A reusable plan template.',
    listing_kind: 'plan',
    listing_ref: 'release-plan',
    github_repo: 'acme/plans',
    ...overrides,
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function mockFetch(listing: HarnessListing, action: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/cupboard/listings/')) {
      return new Response(JSON.stringify({ listing }), { status: 200 });
    }
    if (u.includes('/api/cupboard/install-blueprint') || u.includes('/api/cupboard/install-plugin')) {
      void init;
      return new Response(JSON.stringify(action.body), { status: action.status });
    }
    return new Response('{}', { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('CupboardDetailPage — blueprint Fork (install into the local installed tier)', () => {
  it('Fork POSTs install-blueprint with the listing id + active pot (no installPlugins) and toasts installable plugin deps', async () => {
    const fetchMock = mockFetch(blueprintListing(), {
      status: 200,
      body: {
        ok: true,
        id: 'review',
        version: '0.2.0',
        installedTo: '/home/u/.papercusp/blueprints/review',
        depCheck: { ok: true, installable: { plugins: ['repomix'] } },
      },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    expect(btn.getAttribute('data-action')).toBe('install');
    fireEvent.click(btn);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/cupboard/install-blueprint'));
      expect(call).toBeTruthy();
      // Consent stays explicit: the button must NOT auto-install plugin deps.
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        listingId: 'bp-listing-1',
        potSlug: 'sales-hive',
      });
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    const msg = String(h.toastSuccess.mock.calls[0][0]);
    expect(msg).toContain('review');
    expect(msg).toContain('repomix');
    // No navigation for a blueprint install — it lands in ~/.papercusp/blueprints.
    expect(h.push).not.toHaveBeenCalled();
  });

  it('surfaces an install failure (e.g. dep-validation 422) as a toast', async () => {
    mockFetch(blueprintListing(), {
      status: 422,
      body: { ok: false, error: 'blueprint dependencies unresolvable', detail: 'needs plugin "ghost"' },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    fireEvent.click(btn);

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    const msg = String(h.toastError.mock.calls[0][0]);
    expect(msg).toContain('dependencies unresolvable');
    expect(msg).toContain('needs plugin "ghost"');
    expect(h.push).not.toHaveBeenCalled();
  });

  it('renders provider evidence, publisher default, optional gaps and the full transitive review before consent', async () => {
    const candidate = {
      classRef: 'crm.email@1.0.0',
      providerPackage: 'mail-pro',
      providerVersion: '2.1.0',
      verbBindings: { send: 'mail.send' },
      conformanceRunId: 'run-1',
      conformanceStatus: 'passed',
      behavioralStatus: 'passed',
      behavioralRunRef: 'suite-1',
      registryRevision: 'registry-1',
      status: 'active',
      updatedAt: '2026-09-07T00:00:00Z',
      price: null,
      activePotBindings: 17,
      passingStructuralRuns: 4,
      totalStructuralRuns: 4,
    };
    const capabilityGrants = {
      ok: true,
      requirements: [
        {
          classRef: 'crm.email@1.0.0',
          optional: false,
          state: 'choosable',
          candidates: [candidate],
          selection: {
            classRef: 'crm.email@1.0.0',
            providerPackage: 'mail-pro',
            providerVersion: '2.1.0',
            reason: 'publisher-suggestion',
            disclosureRequired: false,
          },
        },
        {
          classRef: 'crm.calendar@1.0.0',
          optional: true,
          state: 'absent',
          candidates: [],
          absentReason: 'no-conformant-provider',
        },
      ],
      satisfied: [],
      selected: [{
        classRef: 'crm.email@1.0.0',
        providerPackage: 'mail-pro',
        providerVersion: '2.1.0',
        reason: 'publisher-suggestion',
        disclosureRequired: false,
      }],
      missingRequired: [],
      requiresChoice: [],
      missingOptional: ['crm.calendar@1.0.0'],
      disclosures: [],
    };
    const capabilityProviderReview = {
      ok: true,
      roots: [{
        providerPackage: 'mail-pro',
        providerVersion: '2.1.0',
        classRefs: ['crm.email@1.0.0'],
        kind: 'plugin',
        status: 'installable',
        listingId: 'listing-mail-pro',
      }],
      units: [
        {
          name: 'mail-pro',
          version: '2.1.0',
          kind: 'plugin',
          listingId: 'listing-mail-pro',
          review: {
            name: 'mail-pro',
            version: '2.1.0',
            kind: 'plugin',
            capabilities: ['net:fetch', 'secrets:read'],
            dependencies: {
              tools: ['http.request'],
              packs: ['mail-codecs'],
              plugins: [],
              events: [{ family: 'mail:sent' }],
            },
          },
        },
        {
          name: 'mail-codecs',
          version: '1.4.0',
          kind: 'pack',
          listingId: 'listing-mail-codecs',
          review: {
            name: 'mail-codecs',
            version: '1.4.0',
            kind: 'pack',
            capabilities: [],
            dependencies: { tools: [], packs: [], plugins: [], events: [] },
          },
        },
      ],
      stillMissing: { tools: [], packs: [], plugins: [], events: [] },
      advisory: [],
      rounds: 2,
    };
    let installCalls = 0;
    const installBodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/cupboard/listings/')) {
        return new Response(JSON.stringify({ listing: blueprintListing() }), { status: 200 });
      }
      if (u.includes('/api/cupboard/install-blueprint')) {
        installCalls += 1;
        installBodies.push(JSON.parse(String(_init?.body ?? '{}')));
        if (installCalls === 1) {
          return new Response(JSON.stringify({
            ok: false,
            error: 'capability_provider_install_consent_required',
            data: { capabilityGrants, capabilityProviderReview },
          }), { status: 409 });
        }
        return new Response(JSON.stringify({
          ok: true,
          id: 'review',
          version: '0.2.0',
          depCheck: { installable: { plugins: [] } },
          capabilityGrants,
          capabilityProviderReview,
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<CupboardDetailPage />);

    fireEvent.click(await screen.findByTestId('cupboard-detail-action'));

    const panel = await screen.findByTestId('cupboard-capability-review');
    expect(panel.getAttribute('data-stage')).toBe('consent');
    expect(screen.getByTestId('cupboard-capability-target-pot').textContent).toContain('sales-hive');
    const candidateRow = screen.getByTestId('cupboard-capability-candidate');
    expect(candidateRow.getAttribute('data-default')).toBe('publisher');
    expect(candidateRow.textContent).toContain('conformance passed');
    expect(candidateRow.textContent).toContain('structural 4/4');
    expect(candidateRow.textContent).toContain('adoption 17');
    expect(candidateRow.textContent).toContain('price unknown');
    expect(screen.getByTestId('cupboard-capability-gap').textContent).toContain('Optional gap');
    const packages = screen.getAllByTestId('cupboard-capability-provider-package');
    expect(packages).toHaveLength(2);
    expect(packages[0]?.textContent).toContain('net:fetch');
    expect(packages[0]?.textContent).toContain('pack:mail-codecs');
    expect(packages[1]?.textContent).toContain('mail-codecs@1.4.0');

    const consent = screen.getByTestId('cupboard-detail-action');
    expect(consent.textContent).toContain('Install reviewed set');
    fireEvent.click(consent);

    await waitFor(() => expect(installCalls).toBe(2));
    expect(installBodies[1]).toEqual({
      listingId: 'bp-listing-1',
      potSlug: 'sales-hive',
      capabilityProviderSelections: { 'crm.email@1.0.0': 'mail-pro@2.1.0' },
      installPlugins: true,
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
  });

  it('renders a required ABSENT class as a blocking gap instead of a generic toast', async () => {
    mockFetch(blueprintListing(), {
      status: 409,
      body: {
        ok: false,
        error: 'capability_provider_unavailable',
        detail: 'no provider',
        data: {
          ok: false,
          requirements: [{
            classRef: 'crm.email@1.0.0',
            optional: false,
            state: 'absent',
            candidates: [],
            absentReason: 'no-conformant-provider',
          }],
          satisfied: [],
          selected: [],
          missingRequired: ['crm.email@1.0.0'],
          requiresChoice: [],
          missingOptional: [],
          disclosures: [],
        },
      },
    });
    render(<CupboardDetailPage />);

    fireEvent.click(await screen.findByTestId('cupboard-detail-action'));
    const panel = await screen.findByTestId('cupboard-capability-review');
    expect(panel.getAttribute('data-stage')).toBe('blocked');
    expect(screen.getByTestId('cupboard-capability-gap').textContent).toContain('Required gap');
    expect(h.toastError).not.toHaveBeenCalled();
  });
});

describe('CupboardDetailPage — plugin Install (direct global install, EI-27)', () => {
  it('Install POSTs install-plugin with the listing id (no harness/acceptCapabilities) and never navigates to the dead /harness?cupboardListing URL', async () => {
    const fetchMock = mockFetch(pluginListing(), {
      status: 200,
      body: {
        ok: true,
        name: 'demo-plugin',
        version: '1.3.0',
        kind: 'plugin',
        capabilities: ['fs:read', 'net:fetch'],
        installedTo: '/home/u/.papercusp/global-plugins/demo-plugin',
        granted: [],
        installableDependencies: { tools: [], packs: [], plugins: ['repomix'] },
      },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    expect(btn.getAttribute('data-action')).toBe('install');
    fireEvent.click(btn);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/cupboard/install-plugin'));
      expect(call).toBeTruthy();
      // No harness/acceptCapabilities — per-harness consent stays explicit.
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ listingId: 'bp-listing-1' });
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    const msg = String(h.toastSuccess.mock.calls[0][0]);
    expect(msg).toContain('demo-plugin');
    expect(msg).toContain('fs:read');
    expect(msg).toContain('repomix');
    // The dead navigation is gone — installing must NOT route anywhere.
    expect(h.push).not.toHaveBeenCalled();
    // And no blueprint endpoint was hit for a plugin listing.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/cupboard/install-blueprint'))).toBe(false);
  });

  it('surfaces a plugin install failure as a toast and does not navigate', async () => {
    mockFetch(pluginListing(), {
      status: 422,
      body: { ok: false, error: 'dependencies unmet', detail: 'missing tool "ghost"' },
    });
    render(<CupboardDetailPage />);

    const btn = await screen.findByTestId('cupboard-detail-action');
    fireEvent.click(btn);

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    const msg = String(h.toastError.mock.calls[0][0]);
    expect(msg).toContain('dependencies unmet');
    expect(msg).toContain('missing tool "ghost"');
    expect(h.push).not.toHaveBeenCalled();
  });

  /**
   * A plugin that declares a DATA PROVIDER needs consent at install
   * (generalized-integrations P-001 / D-006). The server refuses the first call
   * with the exact review; the page must render it (what it reads, which OAuth
   * scopes, which hosts) and the confirming call must echo that review back as
   * `expectedReview` — the server installs only the package that was shown.
   */
  function providerReview(egressHosts: string[] = ['gmail.googleapis.com']) {
    return {
      name: 'demo-plugin',
      version: '1.3.0',
      kind: 'plugin',
      capabilities: [],
      dependencies: { tools: [], packs: [], plugins: [], events: [] },
      provider: {
        id: 'demo-mail',
        contractVersion: 1,
        runtime: 'daemon',
        datatypes: ['email.message'],
        capabilities: ['read', 'sync'],
        oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        egressHosts,
      },
    };
  }

  function sequencedFetch(listing: HarnessListing, responses: Array<{ status: number; body: unknown }>) {
    const queue = [...responses];
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/cupboard/listings/')) {
        return new Response(JSON.stringify({ listing }), { status: 200 });
      }
      if (u.includes('/api/cupboard/install-plugin')) {
        const next = queue.shift() ?? { status: 500, body: { ok: false, error: 'unexpected extra call' } };
        return new Response(JSON.stringify(next.body), { status: next.status });
      }
      return new Response('{}', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function installBodies(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/cupboard/install-plugin'))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
  }

  it('renders the provider review on provider_install_consent_required and re-posts the exact review on confirm', async () => {
    const review = providerReview();
    const fetchMock = sequencedFetch(pluginListing(), [
      {
        status: 409,
        body: {
          ok: false,
          error: 'provider "demo-mail" requires consent',
          code: 'provider_install_consent_required',
          data: { review },
        },
      },
      {
        status: 200,
        body: { ok: true, name: 'demo-plugin', version: '1.3.0', kind: 'plugin', capabilities: [], granted: [] },
      },
    ]);
    render(<CupboardDetailPage />);

    fireEvent.click(await screen.findByTestId('cupboard-detail-action'));

    const panel = await screen.findByTestId('cupboard-provider-review');
    expect(panel.getAttribute('data-provider-id')).toBe('demo-mail');
    expect(screen.getByTestId('cupboard-provider-datatypes').textContent).toContain('email.message');
    expect(screen.getByTestId('cupboard-provider-scopes').textContent).toContain('gmail.readonly');
    expect(screen.getByTestId('cupboard-provider-egress').textContent).toContain('gmail.googleapis.com');
    // A consent refusal is a review step, not a failure.
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();

    const cta = screen.getByTestId('cupboard-detail-action');
    expect(cta.getAttribute('data-capability-stage')).toBe('provider-consent');
    expect(cta.textContent).toContain('Install with provider access');
    fireEvent.click(cta);

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    const bodies = installBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    // First call carries no consent; the second pins exactly what was shown.
    expect(bodies[0]).toEqual({ listingId: 'bp-listing-1' });
    expect(bodies[1]).toEqual({ listingId: 'bp-listing-1', acceptCapabilities: true, expectedReview: review });
    await waitFor(() => expect(screen.queryByTestId('cupboard-provider-review')).toBeNull());
  });

  it('shows the CURRENT review and an error when the plugin changed after review (plugin_review_changed)', async () => {
    const first = providerReview();
    const changed = providerReview(['gmail.googleapis.com', 'exfil.example.com']);
    const fetchMock = sequencedFetch(pluginListing(), [
      { status: 409, body: { ok: false, error: 'consent', code: 'provider_install_consent_required', data: { review: first } } },
      { status: 409, body: { ok: false, error: 'changed', code: 'plugin_review_changed', data: { review: changed } } },
    ]);
    render(<CupboardDetailPage />);

    fireEvent.click(await screen.findByTestId('cupboard-detail-action'));
    await screen.findByTestId('cupboard-provider-review');
    fireEvent.click(screen.getByTestId('cupboard-detail-action'));

    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(String(h.toastError.mock.calls[0][0])).toContain('changed since you reviewed it');
    await waitFor(() =>
      expect(screen.getByTestId('cupboard-provider-egress').textContent).toContain('exfil.example.com'),
    );
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(installBodies(fetchMock)[1]).toEqual({ listingId: 'bp-listing-1', acceptCapabilities: true, expectedReview: first });
  });

  it('Cancel on the provider review drops the consent and restores the plain Install action', async () => {
    sequencedFetch(pluginListing(), [
      { status: 409, body: { ok: false, error: 'consent', code: 'provider_install_consent_required', data: { review: providerReview() } } },
    ]);
    render(<CupboardDetailPage />);

    fireEvent.click(await screen.findByTestId('cupboard-detail-action'));
    await screen.findByTestId('cupboard-provider-review');
    fireEvent.click(screen.getByTestId('cupboard-provider-review-cancel'));

    await waitFor(() => expect(screen.queryByTestId('cupboard-provider-review')).toBeNull());
    expect(screen.getByTestId('cupboard-detail-action').getAttribute('data-capability-stage')).toBe('initial');
  });
});

/**
 * The event axis on the detail page (cupboard-public-release P-008 / D-003).
 *
 * "Provides events" is discovery — what awaiting this unit buys you. "Requires
 * events" is a DECISION surface, and that is why it earns its own section rather
 * than being folded in with the tools: a REQUIRED family that nothing on the host
 * provides is a HARD install failure (P-007's gate), so the required/optional
 * distinction must survive all the way to the screen. Blend them and the page
 * quietly implies "this install will work" when it won't.
 */
describe('CupboardDetailPage — the event axis (P-008)', () => {
  const eventPluginListing = () =>
    pluginListing({
      provides_events: JSON.stringify([
        { family: 'relay:sent', keyTemplate: 'relay:sent:<id>', describe: 'a relay message landed' },
      ]),
      requires_events: JSON.stringify([
        { family: 'deploy:done' },
        { family: 'canary:flipped', optional: true },
      ]),
    });

  it('renders provided families with their KEY TEMPLATE — the thing an awaiter actually parks on', async () => {
    mockFetch(eventPluginListing(), { status: 200, body: { ok: true } });
    render(<CupboardDetailPage />);

    const section = await screen.findByTestId('cupboard-detail-provides-events');
    expect(section).toBeTruthy();
    expect(section.textContent).toContain('relay:sent');
    // Naming the family without its template would leave the user unable to
    // actually await it — the template IS the usable artifact.
    expect(section.textContent).toContain('relay:sent:<id>');
    expect(section.textContent).toContain('a relay message landed');
  });

  it('renders required families and marks REQUIRED vs OPTIONAL distinctly', async () => {
    mockFetch(eventPluginListing(), { status: 200, body: { ok: true } });
    render(<CupboardDetailPage />);

    await screen.findByTestId('cupboard-detail-requires-events');
    const rows = screen.getAllByTestId('cupboard-detail-required-event');
    expect(rows).toHaveLength(2);

    const hard = rows.find((r) => r.getAttribute('data-family') === 'deploy:done');
    const soft = rows.find((r) => r.getAttribute('data-family') === 'canary:flipped');
    // The distinction that decides whether the install SUCCEEDS.
    expect(hard?.getAttribute('data-optional')).toBe('false');
    expect(hard?.textContent).toContain('required');
    expect(soft?.getAttribute('data-optional')).toBe('true');
    expect(soft?.textContent).toContain('optional');
  });

  it('omits both sections when the listing declares no events (a pre-012/013 row)', async () => {
    mockFetch(pluginListing(), { status: 200, body: { ok: true } });
    render(<CupboardDetailPage />);

    // Wait for the page to actually render before asserting an absence, or this
    // passes vacuously against a still-loading page.
    await screen.findByTestId('cupboard-detail-action');
    expect(screen.queryByTestId('cupboard-detail-provides-events')).toBeNull();
    expect(screen.queryByTestId('cupboard-detail-requires-events')).toBeNull();
  });

  it('degrades to no section — never a crashed page — on a MALFORMED declaration', async () => {
    // The row is a third party's declaration. A bad one must cost us the section,
    // not the whole listing page (fail-soft parse; the worker validates on publish).
    mockFetch(
      pluginListing({
        provides_events: '{not json',
        requires_events: JSON.stringify([{ nope: 1 }, { family: 'ok:done' }]),
      }),
      { status: 200, body: { ok: true } },
    );
    render(<CupboardDetailPage />);

    await screen.findByTestId('cupboard-detail-action');
    expect(screen.queryByTestId('cupboard-detail-provides-events')).toBeNull();
    // The one WELL-FORMED entry still renders; only the junk entry is dropped.
    const rows = screen.getAllByTestId('cupboard-detail-required-event');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-family')).toBe('ok:done');
  });
});

/**
 * A rubric changes how future work is judged, so its grading contract must be
 * inspectable before install (cupboard-plan-rubric-recipe-sharing P-005).
 * The listing row is intentionally only a pointer; the detail page reads the
 * public self-describing directory that the installer will consume.
 */
describe('CupboardDetailPage — rubric criteria + METHOD.md (P-005)', () => {
  const contentsUrl = 'https://api.github.com/repos/acme/rubrics/contents/release-readiness';
  const rubricUrl = 'https://raw.example/release-readiness/rubric.json';
  const methodUrl = 'https://raw.example/release-readiness/METHOD.md';

  function mockRubricFetch(
    opts: { contentsStatus?: number; malformed?: boolean; omitMethod?: boolean } = {},
  ) {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/cupboard/listings/')) {
        return new Response(JSON.stringify({ listing: rubricListing() }), { status: 200 });
      }
      if (u === contentsUrl) {
        if (opts.contentsStatus && opts.contentsStatus !== 200) {
          return new Response('{}', { status: opts.contentsStatus });
        }
        return new Response(
          JSON.stringify([
            { name: 'rubric.json', type: 'file', download_url: rubricUrl },
            ...(opts.omitMethod
              ? []
              : [{ name: 'METHOD.md', type: 'file', download_url: methodUrl }]),
          ]),
          { status: 200 },
        );
      }
      if (u === rubricUrl) {
        return new Response(JSON.stringify(opts.malformed ? { title: 'broken' } : {
          title: 'Release readiness',
          characteristic: 'safe, verified releases',
          description: 'Checks the release gate and operator evidence.',
          ratingScale: ['pass', 'fail'],
          criteria: [{
            key: 'gate-green',
            title: 'Green checkpoint',
            model: 'The current release candidate has a green gate verdict.',
            method: 'Read the checkpoint verdict for the exact candidate SHA.',
            driftMarkers: 'A newer candidate or a red/unknown verdict.',
            replication: 'Re-read the candidate SHA and rerun the checkpoint query.',
          }],
        }), { status: 200 });
      }
      if (u === methodUrl) {
        return new Response('# Release method\n\nVerify the candidate, then grade every criterion.', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('renders every criterion and the published METHOD.md before install', async () => {
    const fetchMock = mockRubricFetch();
    render(<CupboardDetailPage />);

    const criteria = await screen.findByTestId('cupboard-rubric-criteria');
    expect(criteria.textContent).toContain('Green checkpoint');
    expect(criteria.textContent).toContain('gate-green');
    expect(criteria.textContent).toContain('current release candidate has a green gate verdict');
    expect(criteria.textContent).toContain('Read the checkpoint verdict');
    expect(criteria.textContent).toContain('A newer candidate');
    expect(criteria.textContent).toContain('Re-read the candidate SHA');
    expect(criteria.textContent).toContain('pass · fail');

    const method = screen.getByTestId('cupboard-rubric-method');
    expect(method.textContent).toContain('METHOD.md runbook');
    expect(method.textContent).toContain('Verify the candidate, then grade every criterion.');
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([contentsUrl, rubricUrl, methodUrl]),
    );
  });

  it('fails soft to the exact source directory when GitHub content is unavailable', async () => {
    mockRubricFetch({ contentsStatus: 503 });
    render(<CupboardDetailPage />);

    const error = await screen.findByTestId('cupboard-rubric-contents-error');
    expect(error.textContent).toContain('GitHub contents → 503');
    const link = error.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/acme/rubrics/tree/HEAD/release-readiness');
    // The content miss degrades this panel, not the whole listing or its install action.
    expect(screen.getByTestId('cupboard-detail-action')).toBeTruthy();
  });

  it('fails soft when rubric.json is present but malformed', async () => {
    mockRubricFetch({ malformed: true });
    render(<CupboardDetailPage />);

    const error = await screen.findByTestId('cupboard-rubric-contents-error');
    expect(error.textContent).toContain('rubric.json is not a valid rubric manifest');
    expect(error.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/acme/rubrics/tree/HEAD/release-readiness',
    );
    expect(screen.getByTestId('cupboard-detail-action')).toBeTruthy();
  });

  it('renders criteria without fetching an optional METHOD.md that was not published', async () => {
    const fetchMock = mockRubricFetch({ omitMethod: true });
    render(<CupboardDetailPage />);

    expect(await screen.findByTestId('cupboard-rubric-criteria')).toBeTruthy();
    expect(screen.getByTestId('cupboard-rubric-method').textContent).toContain(
      'No METHOD.md runbook was published with this rubric.',
    );
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(methodUrl);
  });
});

describe('CupboardDetailPage — plan rubric dependencies before install (P-012)', () => {
  it('renders every required and optional rubric with its blocking posture', async () => {
    mockFetch(
      planListing({
        requires_rubrics: JSON.stringify([
          { rubricRef: 'plan-class-feature-ship' },
          { rubricRef: 'release-readiness', optional: true },
        ]),
      }),
      { status: 200, body: {} },
    );
    render(<CupboardDetailPage />);

    const panel = await screen.findByTestId('cupboard-detail-requires-rubrics');
    expect(panel.textContent).toContain('plan-class-feature-ship');
    expect(panel.textContent).toContain('release-readiness');
    const rows = screen.getAllByTestId('cupboard-detail-required-rubric');
    expect(rows.map((row) => row.getAttribute('data-rubric-ref'))).toEqual([
      'plan-class-feature-ship',
      'release-readiness',
    ]);
    expect(rows.map((row) => row.getAttribute('data-optional'))).toEqual(['false', 'true']);
    expect(panel.textContent).toContain('required');
    expect(panel.textContent).toContain('optional');
    expect(screen.getByTestId('cupboard-detail-action')).toBeTruthy();
  });
});

/**
 * The standalone-app download handoff (cupboard-app-distribution-2026-07-14
 * P-005). A standalone app is a separate downloadable product — the Cupboard
 * never re-hosts it. The detail page fetches the app's `latest.json`, resolves
 * the viewer-OS installer entry, and hands off the download link. It must fail
 * SOFT: a since-broken release degrades to "view the releases on GitHub", never
 * a dead-ended page.
 */
const LATEST_JSON_URL = 'https://github.com/acme/oddsmith/releases/latest/download/latest.json';
const APP_MANIFEST = {
  version: '1.4.0',
  notes: 'Fixes the odds cache.',
  pub_date: '2026-07-14T00:00:00Z',
  platforms: {
    'darwin-aarch64': { signature: 'sig-mac', url: 'https://gh/rel/mac.tar.gz' },
    'linux-x86_64': { signature: 'sig-linux', url: 'https://gh/rel/linux.AppImage' },
    'windows-x86_64': { signature: 'sig-win', url: 'https://gh/rel/win.msi' },
  },
};

function appListing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return listingBase({
    slug: 'oddsmith',
    title: 'Oddsmith',
    description: 'a standalone desktop app',
    listing_kind: 'app',
    listing_ref: null,
    github_repo: 'acme/oddsmith',
    delivery_type: 'standalone',
    latest_json_url: LATEST_JSON_URL,
    release_repo: 'acme/oddsmith',
    platforms: JSON.stringify(['darwin-aarch64', 'linux-x86_64', 'windows-x86_64']),
    ...overrides,
  });
}

/** Serve the listing + the app's latest.json (with a chosen status/body). */
function mockAppFetch(listing: HarnessListing, manifest: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/api/cupboard/listings/')) {
      return new Response(JSON.stringify({ listing }), { status: 200 });
    }
    if (u === LATEST_JSON_URL) {
      return new Response(
        typeof manifest.body === 'string' ? manifest.body : JSON.stringify(manifest.body),
        { status: manifest.status },
      );
    }
    return new Response('{}', { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Stub the viewer OS via navigator (viewerOsFamily reads userAgent + platform),
 *  restoring the real descriptors after the callback (jsdom's default UA is
 *  Linux, which would otherwise leak into "Get for Linux"). */
async function withViewerOs(ua: string, platform: string, fn: () => Promise<void>) {
  const origUa = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  const origPlat = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  try {
    await fn();
  } finally {
    if (origUa) Object.defineProperty(window.navigator, 'userAgent', origUa);
    if (origPlat) Object.defineProperty(window.navigator, 'platform', origPlat);
  }
}

describe('CupboardDetailPage — standalone app download (P-005)', () => {
  it('resolves the viewer-OS installer and hands off the direct download link (no generic install button)', async () => {
    await withViewerOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', async () => {
      mockAppFetch(appListing(), { status: 200, body: APP_MANIFEST });
      render(<CupboardDetailPage />);

      const primary = await screen.findByTestId('cupboard-app-download-primary');
      // The viewer is on macOS ⇒ the primary CTA resolves the mac installer.
      expect(primary.getAttribute('data-platform-key')).toBe('darwin-aarch64');
      expect(primary.getAttribute('href')).toBe('https://gh/rel/mac.tar.gz');
      expect(primary.textContent).toContain('Get for macOS');
      // Version is surfaced.
      expect(screen.getByTestId('cupboard-app-version').textContent).toContain('1.4.0');
      // The OTHER platforms are offered as options (not the viewer's own OS).
      const options = screen.getAllByTestId('cupboard-app-download-option');
      const keys = options.map((o) => o.getAttribute('data-platform-key')).sort();
      expect(keys).toEqual(['linux-x86_64', 'windows-x86_64']);
      // A standalone app has NO generic install/download button — the panel owns it.
      expect(screen.queryByTestId('cupboard-detail-action')).toBeNull();
    });
  });

  it('offers every platform (no single primary) when the viewer OS is undetectable', async () => {
    await withViewerOs('UnknownAgent/1.0', 'UnknownOS', async () => {
      mockAppFetch(appListing(), { status: 200, body: APP_MANIFEST });
      render(<CupboardDetailPage />);

      await screen.findByTestId('cupboard-app-download-no-primary');
      expect(screen.queryByTestId('cupboard-app-download-primary')).toBeNull();
      // All three platforms are equal options.
      const options = screen.getAllByTestId('cupboard-app-download-option');
      expect(options).toHaveLength(3);
    });
  });

  it('fails SOFT to a GitHub releases link when the manifest is unreachable', async () => {
    await withViewerOs('Mozilla/5.0 (Macintosh)', 'MacIntel', async () => {
      mockAppFetch(appListing(), { status: 404, body: 'not found' });
      render(<CupboardDetailPage />);

      const fallback = await screen.findByTestId('cupboard-app-download-unavailable');
      // The denormalized platform availability still tells the viewer what ships.
      expect(fallback.textContent).toContain('macOS');
      // …and there's a real escape hatch to the publisher's releases.
      const gh = screen.getByTestId('cupboard-app-download-github');
      expect(gh.getAttribute('href')).toBe('https://github.com/acme/oddsmith/releases');
      // No crashed page, no primary download.
      expect(screen.queryByTestId('cupboard-app-download-primary')).toBeNull();
    });
  });

  it('fails SOFT on a malformed manifest (still-parseable JSON, wrong shape)', async () => {
    await withViewerOs('Mozilla/5.0 (Macintosh)', 'MacIntel', async () => {
      mockAppFetch(appListing(), { status: 200, body: { version: '1.0.0' /* no platforms */ } });
      render(<CupboardDetailPage />);

      await screen.findByTestId('cupboard-app-download-unavailable');
      expect(screen.queryByTestId('cupboard-app-download-primary')).toBeNull();
    });
  });

  it('is unavailable (no fetch) when the app carries no latest_json_url', async () => {
    await withViewerOs('Mozilla/5.0 (Macintosh)', 'MacIntel', async () => {
      const fetchMock = mockAppFetch(appListing({ latest_json_url: null }), { status: 200, body: APP_MANIFEST });
      render(<CupboardDetailPage />);

      await screen.findByTestId('cupboard-app-download-unavailable');
      // We never reached out for a manifest we don't have a URL for.
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === LATEST_JSON_URL)).toBe(false);
    });
  });
});

/**
 * The detail page must SURFACE the upstream cause, not swallow it
 * (cupboard-dead-default-host-2026-07-19).
 *
 * The operator proxy collapses every upstream failure — TLS hang, DNS miss,
 * connection refused — into a bare 503, forwarding the real reason only in the
 * JSON body's `error`. This page used to reject with `new Error('HTTP ' +
 * status)`, throwing that body away, so a Cupboard pointed at a dead host
 * reported nothing more useful than "it may be briefly unavailable" and sent
 * real debugging down the wrong path. `cupboardHttpError` folds the body in.
 */
describe('CupboardDetailPage — Cupboard failure surfaces its upstream cause', () => {
  function mockListingFailure(status: number, body: unknown) {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/cupboard/listings/')) {
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
      }
      return new Response('{}', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('names the proxy-forwarded upstream cause on a 503 instead of a bare status', async () => {
    mockListingFailure(503, { error: 'TimeoutError: The operation was aborted due to timeout' });
    render(<CupboardDetailPage />);

    const state = await screen.findByTestId('cupboard-error-state');
    // The actual cause must reach the user — this is the whole point.
    expect(state.textContent).toContain('TimeoutError');
    expect(state.textContent).toContain("Couldn't reach the Cupboard server");
  });

  it('still degrades gracefully when the proxy body carries no cause', async () => {
    mockListingFailure(503, {});
    render(<CupboardDetailPage />);

    const state = await screen.findByTestId('cupboard-error-state');
    expect(state.textContent).toContain("Couldn't reach the Cupboard server");
    // No invented detail parenthetical when the body told us nothing.
    expect(state.textContent).toContain('may be briefly unavailable');
  });

  it('reports a missing listing as gone, not as unreachable', async () => {
    mockListingFailure(404, { error: 'cupboard: HTTP 404' });
    render(<CupboardDetailPage />);

    const state = await screen.findByTestId('cupboard-error-state');
    expect(state.textContent).toContain("doesn't exist");
  });
});
