import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { installCore, readProvenance, verifyProvenance } = vi.hoisted(() => ({ installCore: vi.fn(),
  readProvenance: vi.fn(), verifyProvenance: vi.fn() }));
vi.mock('./install-plugin-core', async (importOriginal) => ({
  ...await importOriginal<typeof import('./install-plugin-core')>(), installPluginFromCupboardCore: installCore,
  readInstalledPluginProvenance: readProvenance, verifyInstalledPluginCommerceProvenance: verifyProvenance,
}));
vi.mock('../backup', () => ({ triggerSnapshotEvent: async () => {} }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
import { installPluginFromCupboard, resolveListingCoords, installCupboardUnitFromListing,
  readInstalledPluginCommerceProvenance } from './install-io';

const row = { id: 'listing-1', listing_kind: 'plugin', github_url: 'https://github.com/acme/real-plugin',
  listing_ref: 'real-plugin', pricing_model: 'per-use', sku_ref: 'opaque-release-sku',
  publisher_github_user_id: 42, release_version: '1.0.0', release_content_hash: `sha256:${'a'.repeat(64)}` };
beforeEach(() => {
  installCore.mockReset().mockResolvedValue({ ok: true, installableDependencies: {}, review: {} });
  readProvenance.mockReset().mockResolvedValue({ listing: { listingId: row.id } });
  verifyProvenance.mockReset().mockResolvedValue({ confirmed: true });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ listing: row })));
});
afterEach(() => vi.unstubAllGlobals());

describe('production plugin installer preserves exact storefront receipt', () => {
  it('passes the same resolved publisher, SKU and release to the core without a second listing read', async () => {
    expect((await installPluginFromCupboard({ listingId: row.id })).ok).toBe(true);
    expect(installCore).toHaveBeenCalledWith(expect.objectContaining({ listing: expect.objectContaining({
      skuRef: row.sku_ref, publisherId: 'gh:42', releaseVersion: '1.0.0', priceModel: 'per-use',
      releaseContentHash: row.release_content_hash }), githubUrl: row.github_url, listingRef: row.listing_ref }), expect.any(Object));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('cannot substitute a different repo or subdirectory while retaining a paid listing identity', async () => {
    for (const extra of [{ githubUrl: 'https://github.com/other/plugin' }, { listingRef: 'shadow-plugin' }]) {
      expect(await installPluginFromCupboard({ listingId: row.id, ...extra })).toMatchObject({ ok: false, status: 422 });
    }
    expect(installCore).not.toHaveBeenCalled();
  });
  it('dependency installation retains the same exact receipt', async () => {
    expect((await installCupboardUnitFromListing({ name: row.listing_ref, kind: 'plugin', listingId: row.id })).ok).toBe(true);
    expect(installCore.mock.calls[0]?.[0]?.listing).toMatchObject({ publisherId: 'gh:42', skuRef: row.sku_ref });
  });
  it('the generic coords reader still resolves knowledge packs while the plugin installer rejects that kind', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ listing: { ...row, listing_kind: 'knowledge-pack' } })));
    expect(await resolveListingCoords(row.id)).toMatchObject({ githubUrl: row.github_url, listingRef: row.listing_ref });
    expect(await installPluginFromCupboard({ listingId: row.id })).toMatchObject({ ok: false, status: 422 });
    expect(installCore).not.toHaveBeenCalled();
  });
  it('production admission resolves the exact id and verifies loaded bytes against its hosted identity', async () => {
    const installation = { name: 'different-from-tool-alias', version: '1.0.0', path: '/actual/project/plugin' };
    expect(await readInstalledPluginCommerceProvenance(installation)).toEqual({ confirmed: true });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`/listings/${row.id}`), expect.any(Object));
    expect(verifyProvenance).toHaveBeenCalledWith(installation, expect.objectContaining({ listingId: row.id,
      skuRef: row.sku_ref, publisherId: 'gh:42', releaseContentHash: row.release_content_hash }), expect.any(Object));
  });
  it.each(['knowledge-pack', 'template', undefined])('refuses a hosted %s as loaded plugin authority', async (listing_kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ listing: { ...row, listing_kind } })));
    await expect(readInstalledPluginCommerceProvenance({ name: 'x', version: '1', path: '/x' }))
      .rejects.toMatchObject({ code: 'installation_commerce_binding_invalid' });
    expect(verifyProvenance).not.toHaveBeenCalled();
  });
  it('unmanaged plugins do no hosted lookup and malformed retained ids fail closed', async () => {
    readProvenance.mockResolvedValueOnce(null).mockResolvedValueOnce({ listing: {} });
    expect(await readInstalledPluginCommerceProvenance({ name: 'x', version: '1', path: '/x' })).toBeNull();
    await expect(readInstalledPluginCommerceProvenance({ name: 'x', version: '1', path: '/x' }))
      .rejects.toMatchObject({ code: 'installation_commerce_binding_invalid' });
    expect(fetch).not.toHaveBeenCalled();
    expect(verifyProvenance).not.toHaveBeenCalled();
  });
});
