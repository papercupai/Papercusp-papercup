/**
 * cupboard-install-plugin.test.ts — POST /api/cupboard/install-plugin, the
 * provider-consent round trip (generalized-integrations P-001 / D-006).
 *
 * A plugin that declares a data provider refuses its first install with 409
 * `{ code:'provider_install_consent_required', data:{ review } }`; the caller
 * consents by re-posting `acceptCapabilities:true` + `expectedReview`. The
 * route is the seam the Cupboard UI talks through, so it must (1) forward the
 * refusal's `code` and `data` — without them the UI cannot render the review
 * and the install is stuck on an opaque error — and (2) pass a consented
 * `expectedReview` through to the install core, and drop a non-object one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const installPluginFromCupboard = vi.fn();
vi.mock('../../cupboard/install-io', () => ({
  installPluginFromCupboard: (...args: unknown[]) => installPluginFromCupboard(...args),
}));

import route from './cupboard-install-plugin';

async function post(body: unknown) {
  const req = new Request('http://127.0.0.1/api/cupboard/install-plugin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = (await route.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const review = {
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
    capabilities: ['read'],
    oauthScopes: ['scope-a'],
    egressHosts: ['mail.example.com'],
  },
};

beforeEach(() => installPluginFromCupboard.mockReset());

describe('POST /api/cupboard/install-plugin — provider consent (P-001)', () => {
  it('forwards the refusal code and review so the UI can render the consent panel', async () => {
    installPluginFromCupboard.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'provider "demo-mail" requires consent',
      code: 'provider_install_consent_required',
      data: { review },
    });

    const { status, body } = await post({ listingId: 'L1' });

    expect(status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      code: 'provider_install_consent_required',
      data: { review },
    });
    expect(installPluginFromCupboard).toHaveBeenCalledWith({ listingId: 'L1', acceptCapabilities: false });
  });

  it('passes a consented expectedReview through to the install core', async () => {
    installPluginFromCupboard.mockResolvedValue({ ok: true, result: { name: 'demo-plugin' } });

    const { status } = await post({ listingId: 'L1', acceptCapabilities: true, expectedReview: review });

    expect(status).toBe(200);
    expect(installPluginFromCupboard).toHaveBeenCalledWith({
      listingId: 'L1',
      acceptCapabilities: true,
      expectedReview: review,
    });
  });

  it('drops a non-object expectedReview instead of forwarding it as consent', async () => {
    installPluginFromCupboard.mockResolvedValue({ ok: true, result: { name: 'demo-plugin' } });

    await post({ listingId: 'L1', acceptCapabilities: true, expectedReview: 'yes' });
    await post({ listingId: 'L1', acceptCapabilities: true, expectedReview: [review] });

    for (const call of installPluginFromCupboard.mock.calls) {
      expect(call[0]).not.toHaveProperty('expectedReview');
    }
  });

  it('keeps an error without code/data free of those keys', async () => {
    installPluginFromCupboard.mockResolvedValue({ ok: false, status: 422, error: 'dependencies unmet' });

    const { status, body } = await post({ listingId: 'L1' });

    expect(status).toBe(422);
    expect(body).toEqual({ ok: false, error: 'dependencies unmet' });
  });
});
