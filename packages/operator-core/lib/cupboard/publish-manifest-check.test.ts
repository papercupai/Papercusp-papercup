/**
 * publish-manifest-check.test.ts — the publish-time installability gate for
 * kind=plugin listings (EI-387 / cupboard-full-dogfood-2026-07-10 P-005).
 *
 * The gate reads the backing repo's papercusp.json in the SAME location order
 * the installer uses (install-plugin-core `locatePlugin`: listing_ref subdir
 * first, then repo root; first valid {name, version} wins) and 422s a publish
 * that would list an un-installable repo. These tests pin that it is never
 * stricter than the installer (malformed/absent at one path falls through) and
 * that an unsafe subdir ref is skipped exactly as the installer skips it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  assertPluginManifestPublishable,
  CUPBOARD_LISTING_REF_RE,
  pluginListingRef,
  PublishManifestError,
  type PublishManifestCheckDeps,
} from './publish-manifest-check';

/** A fetchRepoFile that serves a fixed `<path> → content` map (missing ⇒ null). */
function fakeRepo(files: Record<string, string>): PublishManifestCheckDeps['fetchRepoFile'] {
  return vi.fn(async (_owner: string, _repo: string, path: string) => files[path] ?? null);
}

const VALID = JSON.stringify({ name: 'markdown-tools', version: '0.1.0' });

describe('assertPluginManifestPublishable', () => {
  it('accepts a valid root papercusp.json', async () => {
    const res = await assertPluginManifestPublishable(
      { owner: 'acme', repo: 'plugins' },
      { fetchRepoFile: fakeRepo({ 'papercusp.json': VALID }) },
    );
    expect(res).toEqual({ name: 'markdown-tools', version: '0.1.0', path: 'papercusp.json' });
  });

  it('prefers the listing_ref subdir manifest over the root (installer order)', async () => {
    const fetchRepoFile = fakeRepo({
      'sub/papercusp.json': JSON.stringify({ name: 'sub-plugin', version: '2.0.0' }),
      'papercusp.json': JSON.stringify({ name: 'root-plugin', version: '9.9.9' }),
    });
    const res = await assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins', listingRef: 'sub' }, { fetchRepoFile });
    expect(res).toMatchObject({ name: 'sub-plugin', version: '2.0.0', path: 'sub/papercusp.json' });
  });

  it('falls through a missing subdir manifest to the root (never stricter than install)', async () => {
    const res = await assertPluginManifestPublishable(
      { owner: 'acme', repo: 'plugins', listingRef: 'sub' },
      { fetchRepoFile: fakeRepo({ 'papercusp.json': VALID }) },
    );
    expect(res.path).toBe('papercusp.json');
  });

  it('falls through a malformed subdir manifest to a valid root (matches readManifest → null)', async () => {
    const fetchRepoFile = fakeRepo({ 'sub/papercusp.json': '{ not json', 'papercusp.json': VALID });
    const res = await assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins', listingRef: 'sub' }, { fetchRepoFile });
    expect(res.path).toBe('papercusp.json');
  });

  it('skips an unsafe listing_ref subdir (@scope/name) and probes only the root', async () => {
    const fetchRepoFile = fakeRepo({ 'papercusp.json': JSON.stringify({ name: '@sc/x', version: '1.0.0' }) });
    await assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins', listingRef: '@papercupai/repomix' }, { fetchRepoFile });
    // Only the root was fetched — the unsafe subdir path was never attempted.
    expect(fetchRepoFile).toHaveBeenCalledTimes(1);
    expect(fetchRepoFile).toHaveBeenCalledWith('acme', 'plugins', 'papercusp.json');
  });

  it('422s when no papercusp.json exists anywhere', async () => {
    await expect(
      assertPluginManifestPublishable({ owner: 'acme', repo: 'empty' }, { fetchRepoFile: fakeRepo({}) }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('422s (PublishManifestError) when the manifest lacks a version', async () => {
    const fetchRepoFile = fakeRepo({ 'papercusp.json': JSON.stringify({ name: 'x' }) });
    await expect(
      assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins' }, { fetchRepoFile }),
    ).rejects.toBeInstanceOf(PublishManifestError);
  });

  it('422s when the manifest name is blank / non-string', async () => {
    for (const bad of [JSON.stringify({ name: '   ', version: '1.0.0' }), JSON.stringify({ name: 3, version: '1.0.0' })]) {
      await expect(
        assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins' }, { fetchRepoFile: fakeRepo({ 'papercusp.json': bad }) }),
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it('treats a fetch that throws as "not readable here" and 422s (no valid manifest)', async () => {
    const fetchRepoFile = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      assertPluginManifestPublishable({ owner: 'acme', repo: 'plugins' }, { fetchRepoFile }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// EI-25707770061626540: a scoped manifest name was sent as listing_ref and the
// Cupboard worker refused it with a bare `invalid_field`.
describe('pluginListingRef', () => {
  it('strips the npm scope from a scoped slug (the live @papercupai/bug-triage listing is bug-triage)', () => {
    expect(pluginListingRef('@papercupai/bug-triage')).toEqual({ ok: true, listingRef: 'bug-triage' });
  });

  it('keeps an unscoped slug unchanged', () => {
    expect(pluginListingRef('firecrawl')).toEqual({ ok: true, listingRef: 'firecrawl' });
  });

  it('every derived ref satisfies the worker rule', () => {
    for (const slug of ['@papercupai/bug-triage', '@a/b.c_d-e', 'plain', 'nested/dir']) {
      const ref = pluginListingRef(slug);
      expect(ref.ok).toBe(true);
      if (ref.ok) expect(CUPBOARD_LISTING_REF_RE.test(ref.listingRef)).toBe(true);
    }
  });

  it('passes a valid explicit override through, trimmed', () => {
    expect(pluginListingRef('@papercupai/bug-triage', '  packs/triage ')).toEqual({ ok: true, listingRef: 'packs/triage' });
  });

  it('refuses an override the worker would reject, naming the field and the allowed charset', () => {
    const ref = pluginListingRef('bug-triage', '@papercupai/bug-triage');
    expect(ref.ok).toBe(false);
    if (!ref.ok) expect(ref.error).toMatch(/invalid listing_ref "@papercupai\/bug-triage".*letters, digits/);
  });

  it('refuses when no valid ref can be derived from the slug', () => {
    expect(pluginListingRef('@scope/').ok).toBe(false);
  });

  it('matches the Cupboard worker LISTING_REF_RE exactly (pinned against the worker source)', () => {
    const worker = readFileSync(
      fileURLToPath(new URL('../../../../apps/operator-public/src/routes/listings.ts', import.meta.url)),
      'utf8',
    );
    const match = /const LISTING_REF_RE = (\/.+\/[a-z]*);/.exec(worker);
    expect(match, 'LISTING_REF_RE not found in the worker listings route').not.toBeNull();
    expect(String(CUPBOARD_LISTING_REF_RE)).toBe(match![1]);
  });
});
