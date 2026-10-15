/**
 * Self-describing release origin (cupboard-release-pipeline-content-trust P-011).
 *
 * The publisher ships the package bytes of a recipe / plan / goal / template / rubric to the
 * Cupboard R2 ORIGIN; the Worker pins the Merkle root the release gate computed over exactly
 * those bytes, and an install prefers the origin bytes over the GitHub mirror. These tests pin
 * the archive format (deterministic, path-hostile-proof, digest-checked), the release the
 * archive builds (it must clear the REAL publish release gate, not a stub), and the verified
 * fetch the installer trusts (it must return null — never throw, never partial bytes — on
 * anything it cannot verify against the pinned root).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { buildArtifactPackage } from '../p2p/artifact-package';
import type { BlueprintReleaseSigner } from './blueprint-release';
import { prepareReleaseForPublish } from './publish-release-gate';
import {
  DEFAULT_SELF_DESCRIBING_RELEASE_VERSION,
  MAX_SELF_DESCRIBING_ARTIFACT_BYTES,
  SELF_DESCRIBING_ARCHIVE_SCHEMA,
  SelfDescribingArchiveError,
  buildSelfDescribingPublishExtras,
  buildSelfDescribingRelease,
  contentHashHexOf,
  fetchSelfDescribingArtifact,
  fetchVerifiedReleaseFiles,
  isSafeArchivePath,
  packSelfDescribingArchive,
  packSelfDescribingDir,
  putSelfDescribingArtifact,
  unpackSelfDescribingArchive,
} from './self-describing-release';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'self-describing-release-'));
});
afterEach(() => {
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

function writeListingDir(target: string): void {
  mkdirSync(join(target, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(target, 'recipe.json'), '{"id":"demo","script":"return 1;"}\n');
  writeFileSync(join(target, 'listing.json'), '{"kind":"recipe","version":"1.0.0"}\n');
  writeFileSync(join(target, 'nested', 'README.md'), '# demo\n');
  writeFileSync(join(target, 'nested', 'deeper', 'data.bin'), Buffer.from([0, 1, 2, 253, 254, 255]));
}

/** Hand-craft an archive the way a hostile publisher would — bypassing `pack*`'s own checks. */
function rawArchive(files: Array<{ path: unknown; bytes: Buffer; sha256?: string }>): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: SELF_DESCRIBING_ARCHIVE_SCHEMA,
      files: files.map((f) => ({
        path: f.path,
        sha256: f.sha256 ?? createHash('sha256').update(f.bytes).digest('hex'),
        contentBase64: f.bytes.toString('base64'),
      })),
    }),
    'utf8',
  );
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof SelfDescribingArchiveError ? e.code : `non-archive-error:${(e as Error).message}`;
  }
  return undefined;
}

describe('self-describing archive format', () => {
  it('round-trips every file byte-for-byte, including binary content and nested paths', () => {
    writeListingDir(dir);
    const files = unpackSelfDescribingArchive(packSelfDescribingDir(dir));
    expect(files.map((f) => f.path)).toEqual([
      'listing.json',
      'nested/README.md',
      'nested/deeper/data.bin',
      'recipe.json',
    ]);
    expect(files.find((f) => f.path === 'nested/deeper/data.bin')!.bytes).toEqual(Buffer.from([0, 1, 2, 253, 254, 255]));
    expect(files.find((f) => f.path === 'recipe.json')!.bytes.toString('utf8')).toContain('"script":"return 1;"');
  });

  it('is deterministic: the same files in any input order pack to byte-identical archives', () => {
    const a = { path: 'a.txt', bytes: Buffer.from('A') };
    const b = { path: 'dir/b.txt', bytes: Buffer.from('B') };
    const forward = packSelfDescribingArchive([a, b]);
    const reverse = packSelfDescribingArchive([b, a]);
    expect(forward.equals(reverse)).toBe(true);
    // ...and therefore the SAME Merkle root, which is what the Worker pins.
    expect(buildArtifactPackage(forward).rootHash).toBe(buildArtifactPackage(reverse).rootHash);
  });

  it('changes the content hash when a single byte of a single file changes', () => {
    const base = packSelfDescribingArchive([{ path: 'a.txt', bytes: Buffer.from('A') }]);
    const edited = packSelfDescribingArchive([{ path: 'a.txt', bytes: Buffer.from('B') }]);
    expect(buildArtifactPackage(base).rootHash).not.toBe(buildArtifactPackage(edited).rootHash);
  });

  it.each([
    ['parent traversal', '../escape.txt'],
    ['embedded traversal', 'a/../../escape.txt'],
    ['absolute path', '/etc/passwd'],
    ['dot segment', './a.txt'],
    ['empty segment', 'a//b.txt'],
    ['trailing slash', 'a/'],
    ['backslash separator', 'a\\b.txt'],
    ['NUL byte', 'a\0b.txt'],
    ['empty path', ''],
  ])('refuses a hostile path on pack AND unpack (%s)', (_label, path) => {
    expect(isSafeArchivePath(path)).toBe(false);
    expect(codeOf(() => packSelfDescribingArchive([{ path, bytes: Buffer.from('x') }]))).toBe('archive-unsafe-path');
    expect(codeOf(() => unpackSelfDescribingArchive(rawArchive([{ path, bytes: Buffer.from('x') }])))).toBe(
      'archive-unsafe-path',
    );
  });

  it('refuses a duplicate path on pack AND unpack', () => {
    const dup = [
      { path: 'a.txt', bytes: Buffer.from('1') },
      { path: 'a.txt', bytes: Buffer.from('2') },
    ];
    expect(codeOf(() => packSelfDescribingArchive(dup))).toBe('archive-unsafe-path');
    expect(codeOf(() => unpackSelfDescribingArchive(rawArchive(dup)))).toBe('archive-unsafe-path');
  });

  it('refuses an entry whose bytes do not match its declared sha256 (tampered content)', () => {
    const tampered = rawArchive([{ path: 'a.txt', bytes: Buffer.from('evil'), sha256: createHash('sha256').update('good').digest('hex') }]);
    expect(codeOf(() => unpackSelfDescribingArchive(tampered))).toBe('archive-digest-mismatch');
  });

  it('refuses malformed JSON, an unknown schema and a malformed entry as archive-malformed', () => {
    expect(codeOf(() => unpackSelfDescribingArchive(Buffer.from('not json at all')))).toBe('archive-malformed');
    expect(codeOf(() => unpackSelfDescribingArchive(Buffer.from(JSON.stringify({ schema: 'other/v9', files: [] }))))).toBe(
      'archive-malformed',
    );
    expect(
      codeOf(() =>
        unpackSelfDescribingArchive(
          Buffer.from(JSON.stringify({ schema: SELF_DESCRIBING_ARCHIVE_SCHEMA, files: [{ path: 'a.txt' }] })),
        ),
      ),
    ).toBe('archive-malformed');
  });

  it('refuses a symlink in the listing dir rather than following it out of the tree', () => {
    writeFileSync(join(dir, 'real.txt'), 'real');
    symlinkSync('/etc/hosts', join(dir, 'link.txt'));
    expect(codeOf(() => packSelfDescribingDir(dir))).toBe('archive-unsafe-path');
  });

  it('refuses an archive larger than the origin accepts', () => {
    // Incompressible-by-construction: base64 inflates 7 MiB past the 8 MiB origin cap.
    const big = Buffer.alloc(7 * 1024 * 1024, 7);
    expect(codeOf(() => packSelfDescribingArchive([{ path: 'big.bin', bytes: big }]))).toBe('archive-too-large');
  });
});

describe('buildSelfDescribingRelease', () => {
  it('builds a release whose content hash is the Merkle root of the exact bytes it ships', async () => {
    writeListingDir(dir);
    const built = await buildSelfDescribingRelease({
      listingKind: 'recipe',
      listingRef: 'demo',
      releaseVersion: '1.2.3',
      dir,
      signer: makeSigner(),
    });
    expect(built.contentHash).toBe(buildArtifactPackage(built.bytes).rootHash);
    expect(built.manifest.rootHash).toBe(built.contentHash);
    expect(built.manifest.release.contentHash).toBe(built.contentHash);
    expect(built.manifest.release).toMatchObject({ listingKind: 'recipe', listingRef: 'demo', releaseVersion: '1.2.3' });
    expect(built.release).toMatchObject({ visibility: 'public' });
  });

  it('clears the REAL publish release gate (signature, Merkle root and chunk table all verify)', async () => {
    writeListingDir(dir);
    const built = await buildSelfDescribingRelease({
      listingKind: 'recipe',
      listingRef: 'demo',
      releaseVersion: '1.0.0',
      dir,
      signer: makeSigner(),
    });
    const prepared = await prepareReleaseForPublish(built.release);
    expect(prepared).toMatchObject({ ok: true });
  });

  it('is refused by the gate once the manifest root no longer matches its release / chunk table', async () => {
    // NB: the gate validates the MANIFEST (root vs chunk table vs signed release); the supplied
    // bytes only sharpen a refusal's diagnosis. Binding the UPLOADED bytes to the pinned root is
    // the Worker's PUT-time Merkle re-derivation (apps/operator-public self-describing-artifacts).
    writeListingDir(dir);
    const built = await buildSelfDescribingRelease({
      listingKind: 'recipe',
      listingRef: 'demo',
      releaseVersion: '1.0.0',
      dir,
      signer: makeSigner(),
    });
    const otherRoot = buildArtifactPackage(
      packSelfDescribingArchive([{ path: 'recipe.json', bytes: Buffer.from('{"script":"rm -rf"}') }]),
    ).rootHash;
    const prepared = await prepareReleaseForPublish({
      visibility: 'public',
      manifest: { ...built.manifest, rootHash: otherRoot },
      bytes: built.bytes,
    });
    expect(prepared.ok).toBe(false);
  });
});

describe('contentHashHexOf', () => {
  it('accepts sha256:<hex> and bare 64-hex, lowercases, and refuses everything else', () => {
    const hex = 'a'.repeat(64);
    expect(contentHashHexOf(`sha256:${hex}`)).toBe(hex);
    expect(contentHashHexOf(`SHA256:${hex.toUpperCase()}`)).toBe(hex);
    expect(contentHashHexOf(hex)).toBe(hex);
    expect(contentHashHexOf('sha256:short')).toBeNull();
    expect(contentHashHexOf('../../etc')).toBeNull();
    expect(contentHashHexOf('')).toBeNull();
  });
});

describe('putSelfDescribingArtifact / fetchSelfDescribingArtifact', () => {
  const HEX = 'b'.repeat(64);

  it('PUTs the bytes to /artifacts/sha256/<hex> with the bearer token', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const bytes = Buffer.from('payload');
    const r = await putSelfDescribingArtifact({
      baseUrl: 'https://cupboard.test',
      token: 'gh-tok',
      contentHash: `sha256:${HEX}`,
      bytes,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true, contentHash: `sha256:${HEX}` });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`https://cupboard.test/artifacts/sha256/${HEX}`);
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer gh-tok');
    expect(Buffer.from(init.body as Uint8Array).equals(bytes)).toBe(true);
  });

  it('refuses a malformed content hash BEFORE any network call', async () => {
    const fetchImpl = vi.fn();
    const r = await putSelfDescribingArtifact({
      baseUrl: 'https://cupboard.test',
      token: 't',
      contentHash: '../../etc/passwd',
      bytes: Buffer.from('x'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_content_hash' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces the origin refusal status and body, and maps a network failure to 502', async () => {
    const refused = await putSelfDescribingArtifact({
      baseUrl: 'https://cupboard.test',
      token: 't',
      contentHash: HEX,
      bytes: Buffer.from('x'),
      fetchImpl: (async () => new Response('{"error":"content-address-mismatch"}', { status: 422 })) as unknown as typeof fetch,
    });
    expect(refused).toMatchObject({ ok: false, status: 422, error: 'artifact_upload_refused', detail: { error: 'content-address-mismatch' } });

    const unreachable = await putSelfDescribingArtifact({
      baseUrl: 'https://cupboard.test',
      token: 't',
      contentHash: HEX,
      bytes: Buffer.from('x'),
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(unreachable).toMatchObject({ ok: false, status: 502, error: 'artifact_upload_unreachable' });
  });

  it('GET returns the bytes on 200 and null on 404 / network error / malformed hash / oversize', async () => {
    const ok = await fetchSelfDescribingArtifact({
      baseUrl: 'https://cupboard.test',
      contentHash: HEX,
      fetchImpl: (async () => new Response(Buffer.from('bytes'), { status: 200 })) as unknown as typeof fetch,
    });
    expect(ok?.toString('utf8')).toBe('bytes');
    const missing = await fetchSelfDescribingArtifact({
      baseUrl: 'https://cupboard.test',
      contentHash: HEX,
      fetchImpl: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    });
    expect(missing).toBeNull();
    const thrown = await fetchSelfDescribingArtifact({
      baseUrl: 'https://cupboard.test',
      contentHash: HEX,
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    });
    expect(thrown).toBeNull();
    const fetchImpl = vi.fn();
    expect(
      await fetchSelfDescribingArtifact({ baseUrl: 'https://cupboard.test', contentHash: 'nope', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    const oversize = await fetchSelfDescribingArtifact({
      baseUrl: 'https://cupboard.test',
      contentHash: HEX,
      fetchImpl: (async () =>
        new Response(Buffer.alloc(MAX_SELF_DESCRIBING_ARTIFACT_BYTES + 1), { status: 200 })) as unknown as typeof fetch,
    });
    expect(oversize).toBeNull();
  });
});

describe('fetchVerifiedReleaseFiles — what the installer is allowed to trust', () => {
  const archiveOf = (text: string): Buffer => packSelfDescribingArchive([{ path: 'recipe.json', bytes: Buffer.from(text) }]);

  it('returns the unpacked files when the fetched bytes hash to the pinned root', async () => {
    const bytes = archiveOf('{"id":"a"}');
    const root = buildArtifactPackage(bytes).rootHash;
    const files = await fetchVerifiedReleaseFiles(root, async () => bytes);
    expect(files?.map((f) => f.path)).toEqual(['recipe.json']);
    expect(files?.[0]!.bytes.toString('utf8')).toBe('{"id":"a"}');
  });

  it('returns null when the origin has nothing (absent object)', async () => {
    expect(await fetchVerifiedReleaseFiles(buildArtifactPackage(archiveOf('x')).rootHash, async () => null)).toBeNull();
  });

  it('returns null when the bytes served do not hash to the pinned root (swapped origin bytes)', async () => {
    const pinned = buildArtifactPackage(archiveOf('{"id":"clean"}')).rootHash;
    const served = archiveOf('{"id":"hostile"}');
    expect(await fetchVerifiedReleaseFiles(pinned, async () => served)).toBeNull();
  });

  it('returns null when the root matches but the bytes are not a valid archive', async () => {
    const junk = Buffer.from('this is not an archive');
    const root = buildArtifactPackage(junk).rootHash;
    expect(await fetchVerifiedReleaseFiles(root, async () => junk)).toBeNull();
  });

  it('returns null — never throws — when the fetcher throws, the hash is malformed, or the bytes are oversize', async () => {
    const root = buildArtifactPackage(archiveOf('x')).rootHash;
    await expect(
      fetchVerifiedReleaseFiles(root, async () => {
        throw new Error('network down');
      }),
    ).resolves.toBeNull();
    const fetcher = vi.fn(async () => archiveOf('x'));
    await expect(fetchVerifiedReleaseFiles('not-a-hash', fetcher)).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      fetchVerifiedReleaseFiles(root, async () => Buffer.alloc(MAX_SELF_DESCRIBING_ARTIFACT_BYTES + 1)),
    ).resolves.toBeNull();
  });
});

describe('buildSelfDescribingPublishExtras', () => {
  it('returns the release plus the upload flag and the content hash it pinned', async () => {
    writeListingDir(dir);
    const r = await buildSelfDescribingPublishExtras({ listingKind: 'recipe', listingRef: 'demo', dir, signer: makeSigner() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.extras.uploadReleaseBytes).toBe(true);
    expect(r.extras.release.visibility).toBe('public');
    expect(r.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('defaults the release version, and honours an explicit one', async () => {
    writeListingDir(dir);
    const dflt = await buildSelfDescribingPublishExtras({ listingKind: 'recipe', listingRef: 'demo', dir, signer: makeSigner() });
    const explicit = await buildSelfDescribingPublishExtras({
      listingKind: 'recipe',
      listingRef: 'demo',
      dir,
      version: '3.4.5',
      signer: makeSigner(),
    });
    if (!dflt.ok || !explicit.ok) throw new Error('expected ok');
    const versionOf = (x: typeof dflt) => (x.extras.release as { manifest: { release: { releaseVersion: string } } }).manifest.release.releaseVersion;
    expect(versionOf(dflt)).toBe(DEFAULT_SELF_DESCRIBING_RELEASE_VERSION);
    expect(versionOf(explicit)).toBe('3.4.5');
  });

  it('maps an unsafe listing dir to 422 and any other build failure to 500, without throwing', async () => {
    writeFileSync(join(dir, 'real.txt'), 'real');
    symlinkSync('/etc/hosts', join(dir, 'link.txt'));
    const unsafe = await buildSelfDescribingPublishExtras({ listingKind: 'recipe', listingRef: 'demo', dir, signer: makeSigner() });
    expect(unsafe).toMatchObject({ ok: false, status: 422 });
    expect(!unsafe.ok && unsafe.error).toContain('archive-unsafe-path');

    const missing = await buildSelfDescribingPublishExtras({
      listingKind: 'recipe',
      listingRef: 'demo',
      dir: join(dir, 'does-not-exist'),
      signer: makeSigner(),
    });
    expect(missing).toMatchObject({ ok: false, status: 500 });
    expect(!missing.ok && missing.error).toContain('release_build_failed');
  });
});
