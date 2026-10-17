/**
 * Shared Cupboard listing-publish core (revive-cupboard-distribution P1/P2).
 * gh-token + attestation + resolveCupboardBaseUrl are mocked; fetch is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const sync = vi.hoisted(() => ({ invalidate: vi.fn(async () => {}) }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: sync.invalidate }));

vi.mock('../identity/gh-token', () => ({
  getGhAuthToken: vi.fn(async () => ({ kind: 'ok', token: 'gh-test' })),
}));
vi.mock('./base-url', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.test',
}));
vi.mock('./publisher-attestation', () => ({
  resolvePublisherAttestation: vi.fn(async () => null),
}));

import { publishListingToCupboard } from './publish-listing';
import * as ghToken from '../identity/gh-token';
import * as cupboardPublish from './publisher-attestation';
import { DEFAULT_PINNING_POLICY } from '../p2p/artifact-distribution';
import { buildArtifactPackage, sha256Prefixed } from '../p2p/artifact-package';

const baseInput = {
  listing_kind: 'plugin' as const,
  listing_ref: 'my-plugin',
  github_repository_id: 7,
  github_owner: 'acme',
  github_name: 'my-plugin',
  github_url: 'https://github.com/acme/my-plugin',
  title: 'My Plugin',
};

const originalFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  sync.invalidate.mockClear();
  vi.mocked(ghToken.getGhAuthToken).mockResolvedValue({ kind: 'ok', token: 'gh-test' } as any);
  vi.mocked(cupboardPublish.resolvePublisherAttestation).mockResolvedValue(null);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, id: 'listing-1' }), { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
});

describe('publishListingToCupboard', () => {
  it('returns 401 when gh auth is unavailable', async () => {
    vi.mocked(ghToken.getGhAuthToken).mockResolvedValue({ kind: 'gh_auth_required', error: { kind: 'no_token' } } as any);
    const r = await publishListingToCupboard(baseInput);
    expect(r).toMatchObject({ ok: false, status: 401, error: 'gh_auth_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs /listings with the bearer token and returns the parsed data', async () => {
    const r = await publishListingToCupboard(baseInput);
    expect(r.ok).toBe(true);
    expect((r as { data: { id: string } }).data.id).toBe('listing-1');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://cupboard.test/listings');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer gh-test');
    const body = JSON.parse(opts.body as string);
    expect(body.listing_kind).toBe('plugin');
    expect(body.listing_ref).toBe('my-plugin');
    expect(sync.invalidate).toHaveBeenCalledWith('cupboard.myListings');
  });

  it('attaches the publisher attestation when available', async () => {
    vi.mocked(cupboardPublish.resolvePublisherAttestation).mockResolvedValue({
      attestation_gist_id: 'gist1',
      publisher_device_pubkey: 'pk1',
    } as any);
    await publishListingToCupboard(baseInput);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.attestation_gist_id).toBe('gist1');
    expect(body.publisher_device_pubkey).toBe('pk1');
  });

  it('bounds a hung best-effort publisher attestation and still posts the listing', async () => {
    vi.useFakeTimers();
    vi.mocked(cupboardPublish.resolvePublisherAttestation).mockImplementationOnce(
      () => new Promise(() => {}),
    );

    const pending = publishListingToCupboard(baseInput, { attestationMs: 25 });
    await vi.runAllTimersAsync();
    const r = await pending;

    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).not.toHaveProperty('attestation_gist_id');
    expect(body).not.toHaveProperty('publisher_device_pubkey');
  });

  it('returns a structured stage timeout when the Cupboard POST never settles', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));

    const pending = publishListingToCupboard(baseInput, { upstreamMs: 25 });
    await vi.runAllTimersAsync();
    const r = await pending;

    expect(r).toEqual({
      ok: false,
      status: 504,
      error: 'cupboard_timeout',
      detail: { stage: 'cupboard_post', timeoutMs: 25 },
    });
  });

  it('surfaces a non-2xx upstream as cupboard_error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_field' }), { status: 400 }));
    const r = await publishListingToCupboard(baseInput);
    expect(r).toMatchObject({ ok: false, status: 400, error: 'cupboard_error' });
  });

  it('returns cupboard_unreachable when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await publishListingToCupboard(baseInput);
    expect(r).toMatchObject({ ok: false, status: 502, error: 'cupboard_unreachable' });
  });

  it('passes provides_tools through to the wire body for a pack listing (migration 006)', async () => {
    const r = await publishListingToCupboard({
      ...baseInput,
      listing_kind: 'pack',
      listing_ref: 'markdown-tools',
      provides_tools: ['md.render', 'md.lint'],
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.listing_kind).toBe('pack');
    expect(body.provides_tools).toEqual(['md.render', 'md.lint']);
  });

  it('falls back to /harnesses on a 404 only for kind=harness', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, id: 'h1' }), { status: 200 }));
    const r = await publishListingToCupboard({ ...baseInput, listing_kind: 'harness', topic_hex: 'a'.repeat(64) });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://cupboard.test/harnesses');
  });
});

/**
 * P-008 catalog axes + the D-045 §3b release gate.
 *
 * Every assertion here is about a field the WORKER already validated and stored
 * and that nothing could send — the same shape as the `provides_events` bug this
 * module's own comments describe. So the load-bearing checks are that the field
 * now ARRIVES, and that the publisher-only half deliberately does not.
 */
describe('publishListingToCupboard — catalog visibility', () => {
  it('sends visibility and tenant_id so a private listing is publishable at all', async () => {
    const r = await publishListingToCupboard({ ...baseInput, visibility: 'private', tenant_id: 'pot-42' });
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.visibility).toBe('private');
    expect(body.tenant_id).toBe('pot-42');
  });

  it('omits visibility when unset, leaving the worker default rather than forcing public', async () => {
    await publishListingToCupboard(baseInput);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect('visibility' in body).toBe(false);
  });

  it('refuses a private listing with no tenant, before any network call', async () => {
    const r = await publishListingToCupboard({ ...baseInput, visibility: 'private' });
    expect(r).toMatchObject({ ok: false, status: 400, error: 'tenant_required_for_private_visibility' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('publishListingToCupboard — release gate', () => {
  const CHUNK = 8;
  const BYTES = Buffer.from('the-quick-brown-fox-jumps-over-a-lazy-dog!', 'utf8');

  const validRelease = () => {
    const pkg = buildArtifactPackage(BYTES, { chunkSizeBytes: CHUNK });
    const release = {
      schemaVersion: 1 as const,
      listingKind: 'plugin' as const,
      listingRef: 'demo',
      releaseVersion: '2.0.0',
      contentHash: pkg.rootHash,
      signature: 'release-sig',
      dependencies: [],
      compatibility: { runtime: 'papercusp>=1' },
      permissions: [],
      capabilities: [],
      license: 'MIT',
      publisher: { githubUserId: 42, login: 'avi' },
      reviewStatus: 'approved' as const,
    };
    return {
      release,
      manifest: {
        schemaVersion: 1 as const,
        release,
        rootHash: pkg.rootHash,
        totalSizeBytes: pkg.totalSizeBytes,
        chunks: pkg.chunks,
        visibility: 'public' as const,
        encryption: null,
        pinning: DEFAULT_PINNING_POLICY,
        signature: 'manifest-sig',
      },
    };
  };

  it('pins the validated release identity onto the row', async () => {
    const { release, manifest } = validRelease();
    const r = await publishListingToCupboard({
      ...baseInput,
      release: { visibility: 'public', manifest, bytes: BYTES },
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.release_version).toBe('2.0.0');
    expect(body.release_content_hash).toBe(release.contentHash);
    expect(body.release_signature).toBe('release-sig');
    expect(typeof body.release_manifest_digest).toBe('string');
  });

  it('NEVER forwards the release block itself — it carries publisher-only material', async () => {
    const { manifest } = validRelease();
    await publishListingToCupboard({ ...baseInput, release: { visibility: 'public', manifest, bytes: BYTES } });
    const raw = fetchMock.mock.calls[0]![1].body as string;
    expect('release' in JSON.parse(raw)).toBe(false);
    // The whole point: no chunk list, no bytes, nothing but the pinned identity.
    expect(raw).not.toContain('pinning');
    expect(raw).not.toContain('chunks');
  });

  it('refuses an unpublishable release with 422 and never POSTs it', async () => {
    const { manifest } = validRelease();
    const flat = sha256Prefixed(BYTES);
    const r = await publishListingToCupboard({
      ...baseInput,
      release: {
        visibility: 'public',
        manifest: { ...manifest, rootHash: flat, release: { ...manifest.release, contentHash: flat } },
        bytes: BYTES,
      },
    });
    expect(r).toMatchObject({ ok: false, status: 422, error: 'release_release_not_publishable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes normally when no release block is supplied (the metadata-only listing)', async () => {
    const r = await publishListingToCupboard(baseInput);
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect('release_version' in body).toBe(false);
  });
});
