import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveListingByKind } from './resolve-listing-by-kind';
import { listingIsPaid } from './install-door-gate';

afterEach(() => vi.unstubAllGlobals());

describe('canonical storefront identity through listing resolution', () => {
  const row = { id: 'listing-1', listing_kind: 'plugin', github_url: 'https://github.com/acme/plugin',
    listing_ref: 'paid-plugin', pricing_model: 'per-use', price_amount_micros: '25',
    sku_ref: 'opaque:sku-exact', publisher_github_user_id: 42, release_version: '1.2.0',
    release_content_hash: `sha256:${'a'.repeat(64)}` };
  it('keeps the canonical paid model, opaque SKU, numeric publisher and exact release', async () => {
    const fetch = vi.fn(async () => Response.json({ listing: row }));
    vi.stubGlobal('fetch', fetch);
    const r = await resolveListingByKind(row.id, 'plugin');
    expect(r).toMatchObject({ priceModel: 'per-use', priceAmountMicros: 25, skuRef: row.sku_ref,
      publisherId: 'gh:42', releaseVersion: row.release_version, releaseContentHash: row.release_content_hash });
    expect('error' in r).toBe(false);
    if ('error' in r) throw new Error(r.error);
    expect(listingIsPaid({ ...r, listingKind: 'plugin', listingRef: r.ref })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('canonical pricing_model wins over a conflicting legacy price_model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ listing: { ...row, price_model: 'free' } })));
    expect(await resolveListingByKind(row.id, 'plugin')).toMatchObject({ priceModel: 'per-use' });
  });
  it('does not invent a publisher from a client-like string or a tool name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ listing: { ...row, publisher_github_user_id: '42' } })));
    expect(await resolveListingByKind(row.id, 'plugin')).not.toHaveProperty('publisherId');
  });
  it('preserves the kind guard before interpreting commerce coordinates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ listing: { ...row, listing_kind: 'blueprint' } })));
    expect(await resolveListingByKind(row.id, 'plugin')).toMatchObject({ status: 422 });
  });
});
