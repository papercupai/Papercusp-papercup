/**
 * Publish -> R2 origin upload (cupboard-release-pipeline-content-trust P-011, SPEC-P-011@2).
 *
 * A self-describing listing's package bytes must reach the Cupboard origin BEFORE the Worker
 * pins their hash, so a pinned `release_content_hash` always names bytes the origin holds — and
 * the hash the Worker stores must be the Merkle root of exactly the bytes that were uploaded.
 *
 * The fetch seam here is a small FAKE ORIGIN, not a canned 200: its PUT re-derives the Merkle
 * root from the body the way the real Worker does and refuses a mismatch, so a publisher that
 * uploads different bytes than it pins fails this suite the way it would fail in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { buildArtifactPackage } from '../p2p/artifact-package';
import type { BlueprintReleaseSigner } from './blueprint-release';

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
import { buildSelfDescribingRelease } from './self-describing-release';

const baseInput = {
  listing_kind: 'recipe' as const,
  listing_ref: 'demo-recipe',
  github_repository_id: 7,
  github_owner: 'acme',
  github_name: 'cupboard-library',
  github_url: 'https://github.com/acme/cupboard-library',
  title: 'Demo recipe',
};

let dir: string;
const originalFetch = global.fetch;
const fetchMock = vi.fn();
/** Every request the publisher made, in order, as `METHOD path`. */
let wire: string[];
/** What the fake origin holds, keyed by 64-hex. */
let origin: Map<string, Buffer>;
/** When set, the PUT answers with this status instead of storing. */
let putOverride: { status: number; body: string } | 'network-error' | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'publish-origin-upload-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'recipe.json'), '{"id":"demo-recipe","script":"return 1;"}\n');
  writeFileSync(join(dir, 'sub', 'note.md'), 'note\n');
  wire = [];
  origin = new Map();
  putOverride = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    wire.push(`${init.method} ${path}`);
    if (init.method === 'PUT') {
      if (putOverride === 'network-error') throw new Error('ECONNRESET');
      if (putOverride) return new Response(putOverride.body, { status: putOverride.status });
      const hex = path.split('/').pop()!;
      const body = Buffer.from(init.body as Uint8Array);
      if (buildArtifactPackage(body).rootHash !== `sha256:${hex}`) {
        return new Response('{"error":"content-address-mismatch"}', { status: 422 });
      }
      origin.set(hex, body);
      return new Response('{"ok":true}', { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, id: 'listing-1' }), { status: 200 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

function makeSigner(): BlueprintReleaseSigner {
  const keypair = generateEd25519KeypairDer();
  return {
    githubUserId: 42,
    githubLogin: 'publisher',
    devicePubkey: keypair.pubkeyBase64,
    sign: async (bytes: Buffer) => signWithPrivateKeyDer(keypair.privateKeyDer, bytes),
  };
}

async function build() {
  return buildSelfDescribingRelease({
    listingKind: 'recipe',
    listingRef: 'demo-recipe',
    releaseVersion: '1.0.0',
    dir,
    signer: makeSigner(),
  });
}

function postedBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === 'POST')!;
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('publishListingToCupboard — R2 origin upload for self-describing kinds (P-011)', () => {
  it('uploads the package bytes BEFORE the listing is POSTed', async () => {
    const built = await build();
    const r = await publishListingToCupboard({ ...baseInput, release: built.release, uploadReleaseBytes: true });
    expect(r.ok).toBe(true);
    const hex = built.contentHash.replace('sha256:', '');
    expect(wire).toEqual([`PUT /artifacts/sha256/${hex}`, 'POST /listings']);
  });

  it('pins a release_content_hash equal to the Merkle root of exactly the bytes the origin received (SPEC-P-011@2)', async () => {
    const built = await build();
    await publishListingToCupboard({ ...baseInput, release: built.release, uploadReleaseBytes: true });
    const hex = built.contentHash.replace('sha256:', '');
    const stored = origin.get(hex);
    expect(stored).toBeDefined();
    expect(stored!.equals(built.bytes)).toBe(true);
    const body = postedBody();
    expect(body.release_content_hash).toBe(buildArtifactPackage(stored!).rootHash);
    expect(body.release_content_hash).toBe(built.contentHash);
    expect(body.release_version).toBe('1.0.0');
  });

  it('authenticates the upload as the publisher', async () => {
    const built = await build();
    await publishListingToCupboard({ ...baseInput, release: built.release, uploadReleaseBytes: true });
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === 'PUT')!;
    expect(((put[1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer gh-test');
  });

  it('never forwards the upload flag or the release bytes in the listing body', async () => {
    const built = await build();
    await publishListingToCupboard({ ...baseInput, release: built.release, uploadReleaseBytes: true });
    const body = postedBody();
    expect('uploadReleaseBytes' in body).toBe(false);
    expect('release' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain(built.bytes.toString('base64').slice(0, 40));
  });

  it('refuses a release whose uploaded bytes do not hash to the pinned root, and NEVER POSTs the listing', async () => {
    const built = await build();
    const tampered = {
      ...built.release,
      bytes: Buffer.from('different bytes than the manifest signed'),
    };
    const r = await publishListingToCupboard({
      ...baseInput,
      release: tampered as typeof built.release,
      uploadReleaseBytes: true,
    });
    expect(r).toMatchObject({ ok: false, status: 422, error: 'release_artifact_upload_failed' });
    expect(wire.some((w) => w.startsWith('POST'))).toBe(false);
    expect(origin.size).toBe(0);
  });

  it('refuses with the origin status when the origin rejects the upload, and NEVER POSTs the listing', async () => {
    putOverride = { status: 403, body: '{"error":"forbidden"}' };
    const built = await build();
    const r = await publishListingToCupboard({ ...baseInput, release: built.release, uploadReleaseBytes: true });
    expect(r).toMatchObject({ ok: false, status: 403, error: 'release_artifact_upload_failed' });
    expect(wire.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  it('refuses with 502 when the origin is unreachable, and NEVER POSTs the listing', async () => {
    putOverride = 'network-error';
    const built = await build();
    const r = await publishListingToCupboard({ ...baseInput, release: built.release, uploadReleaseBytes: true });
    expect(r).toMatchObject({ ok: false, status: 502, error: 'release_artifact_upload_failed' });
    expect(wire.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  it('does not touch the origin when the caller did not ask for an upload (the metadata-pin path is unchanged)', async () => {
    const built = await build();
    const r = await publishListingToCupboard({ ...baseInput, release: built.release });
    expect(r.ok).toBe(true);
    expect(wire).toEqual(['POST /listings']);
    expect(postedBody().release_content_hash).toBe(built.contentHash);
  });
});
