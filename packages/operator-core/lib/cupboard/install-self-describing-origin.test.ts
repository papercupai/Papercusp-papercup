/**
 * Install prefers the R2 ORIGIN by content hash; GitHub is the verified fallback
 * (cupboard-release-pipeline-content-trust P-011, SPEC-P-011b@1 + the P-012 hostile-mirror leg).
 *
 * The scenario the whole plan exists for: a publisher ships clean bytes, then (or an attacker
 * with the publisher's push access) force-pushes a dirty script into the GitHub MIRROR. The
 * origin copy is what the listing pinned, so:
 *   - origin reachable  -> the CLEAN bytes install, and GitHub is never even contacted;
 *   - origin unreachable / unverifiable -> the install falls back to GitHub at the pinned commit
 *     and REFUSES `content-address-mismatch` because the dirty mirror no longer digests to the
 *     pinned tree. Nothing hostile is ever placed in the user layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalTreeDigest, type TreeDigestEntry } from '@papercusp/artifact-registry';
import { _resetPapercuspRootForTests } from '../papercusp-root';
import type { ContentPinRef } from './install-self-describing-core';
import { installRecipeFromCupboardCore } from './install-recipe-core';
import { buildArtifactPackage } from '../p2p/artifact-package';
import { SELF_DESCRIBING_ARCHIVE_SCHEMA, packSelfDescribingDir } from './self-describing-release';

const GITHUB_URL = 'https://github.com/acme/cupboard-library';
const COMMIT = 'a'.repeat(40);
const REF = 'origin-recipe';

let root: string;
let fixtureRepo: string;
let previousPapercuspHome: string | undefined;

const CLEAN = 'clean';
const HOSTILE = 'hostile';

async function writeRecipe(marker: string): Promise<void> {
  const dir = join(fixtureRepo, REF);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'recipe.json'),
    `${JSON.stringify(
      {
        id: REF,
        title: `${marker} recipe`,
        description: 'Origin-first install fixture.',
        script: `return '${marker}';`,
        toolsUsed: [],
        tags: ['origin'],
        authorityUnresolved: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(join(dir, 'listing.json'), `${JSON.stringify({ kind: 'recipe', version: '1.0.0' })}\n`, 'utf8');
}

function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

async function listFixtureBlobs(dir: string): Promise<TreeDigestEntry[]> {
  const base = join(dir, REF);
  if (!existsSync(base)) return [];
  const out: TreeDigestEntry[] = [];
  for (const name of (await fs.readdir(base)).sort()) {
    out.push({ path: `${REF}/${name}`, sha: gitBlobSha(await fs.readFile(join(base, name))) });
  }
  return out;
}

/** The publisher's view at publish time: the clean mirror digest + the clean origin bytes. */
async function publishClean(): Promise<{ pin: ContentPinRef; bytes: Buffer; releaseContentHash: string }> {
  await writeRecipe(CLEAN);
  const bytes = packSelfDescribingDir(join(fixtureRepo, REF));
  const releaseContentHash = buildArtifactPackage(bytes).rootHash;
  const treeDigest = await canonicalTreeDigest(await listFixtureBlobs(fixtureRepo));
  return { pin: { commitSha: COMMIT, treeDigest, releaseContentHash }, bytes, releaseContentHash };
}

function deps(fetchArtifact?: (hash: string) => Promise<Buffer | null>) {
  const calls = { cloneRepo: 0, fetchAtSha: 0, fetchArtifact: [] as string[] };
  return {
    calls,
    cloneRepo: async (_url: string, dest: string) => {
      calls.cloneRepo++;
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    fetchAtSha: async (_url: string, dest: string, _sha: string) => {
      calls.fetchAtSha++;
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    listTreeBlobs: async (cloneDir: string) => listFixtureBlobs(cloneDir),
    tmpDir: () => root,
    ...(fetchArtifact
      ? {
          fetchArtifact: async (hash: string) => {
            calls.fetchArtifact.push(hash);
            return fetchArtifact(hash);
          },
        }
      : {}),
  };
}

async function installedScript(): Promise<string> {
  const target = join(process.env.PAPERCUSP_HOME!, 'recipes', REF, 'recipe.json');
  return (JSON.parse(await fs.readFile(target, 'utf8')) as { script: string }).script;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'install-origin-'));
  fixtureRepo = join(root, 'mirror');
  await fs.mkdir(fixtureRepo, { recursive: true });
  previousPapercuspHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = join(root, 'papercusp');
  _resetPapercuspRootForTests();
});

afterEach(async () => {
  if (previousPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousPapercuspHome;
  _resetPapercuspRootForTests();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('install — R2 origin first, verified GitHub fallback (P-011)', () => {
  it('installs the CLEAN origin bytes and never contacts GitHub, even when the mirror was force-pushed dirty', async () => {
    const { pin, bytes } = await publishClean();
    await writeRecipe(HOSTILE); // the mirror is now hostile; the origin is not
    const d = deps(async () => bytes);

    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin }, d);

    expect(await installedScript()).toBe(`return '${CLEAN}';`);
    expect(d.calls.fetchArtifact).toEqual([pin.releaseContentHash]);
    expect(d.calls.fetchAtSha).toBe(0);
    expect(d.calls.cloneRepo).toBe(0);
  });

  it('falls back to the pinned GitHub commit when the origin has no object, and installs the verified mirror', async () => {
    const { pin } = await publishClean();
    const d = deps(async () => null);

    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin }, d);

    expect(await installedScript()).toBe(`return '${CLEAN}';`);
    expect(d.calls.fetchAtSha).toBe(1);
  });

  it('REFUSES content-address-mismatch when the origin is unavailable AND the mirror was force-pushed dirty (SPEC-P-011b@1)', async () => {
    const { pin } = await publishClean();
    await writeRecipe(HOSTILE);
    const d = deps(async () => null);

    await expect(installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin }, d)).rejects.toMatchObject({
      status: 422,
      code: 'content-address-mismatch',
    });
    expect(existsSync(join(process.env.PAPERCUSP_HOME!, 'recipes', REF))).toBe(false);
  });

  it('REFUSES the hostile mirror when the origin throws (network error is "unavailable", not "trusted")', async () => {
    const { pin } = await publishClean();
    await writeRecipe(HOSTILE);
    const d = deps(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin }, d)).rejects.toMatchObject({
      code: 'content-address-mismatch',
    });
    expect(existsSync(join(process.env.PAPERCUSP_HOME!, 'recipes', REF))).toBe(false);
  });

  it('ignores origin bytes that do not hash to the pinned root (a swapped origin object) and verifies via GitHub instead', async () => {
    const { pin } = await publishClean();
    // Build a DIFFERENT, internally valid archive and serve it under the pinned hash.
    const otherDir = join(root, 'other');
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(
      join(otherDir, 'recipe.json'),
      JSON.stringify({ id: REF, title: 'swapped', description: 'x', script: "return 'swapped';", toolsUsed: [], tags: [], authorityUnresolved: false }),
    );
    const swapped = packSelfDescribingDir(otherDir);
    const d = deps(async () => swapped);

    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin }, d);

    expect(await installedScript()).toBe(`return '${CLEAN}';`); // never the swapped origin script
    expect(d.calls.fetchAtSha).toBe(1);
  });

  it('REFUSES when the origin bytes are swapped AND the mirror is dirty — neither hostile source installs', async () => {
    const { pin } = await publishClean();
    await writeRecipe(HOSTILE);
    const swapped = Buffer.from(JSON.stringify({ schema: SELF_DESCRIBING_ARCHIVE_SCHEMA, files: [] }));
    const d = deps(async () => swapped);

    await expect(installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin }, d)).rejects.toMatchObject({
      code: 'content-address-mismatch',
    });
  });

  it('refuses to place a path-traversal archive even though its Merkle root matches the pin, and writes nothing outside the clone', async () => {
    const { pin } = await publishClean();
    const evilBytes = Buffer.from(
      JSON.stringify({
        schema: SELF_DESCRIBING_ARCHIVE_SCHEMA,
        files: [
          {
            path: '../../escape.txt',
            sha256: createHash('sha256').update('pwned').digest('hex'),
            contentBase64: Buffer.from('pwned').toString('base64'),
          },
        ],
      }),
    );
    // The attacker also controls what the listing pinned, so the root MATCHES the evil bytes.
    const evilPin: ContentPinRef = { ...pin, releaseContentHash: buildArtifactPackage(evilBytes).rootHash };
    const d = deps(async () => evilBytes);

    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin: evilPin }, d);

    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
    expect(existsSync(join(root, '..', 'escape.txt'))).toBe(false);
    expect(await installedScript()).toBe(`return '${CLEAN}';`); // came from the verified mirror fallback
    expect(d.calls.fetchAtSha).toBe(1);
  });

  it('does not consult the origin for a pre-P-011 listing (a pin with no release content hash)', async () => {
    const { pin } = await publishClean();
    const legacyPin: ContentPinRef = { commitSha: pin.commitSha, treeDigest: pin.treeDigest };
    const d = deps(async () => null);

    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin: legacyPin }, d);

    expect(d.calls.fetchArtifact).toEqual([]);
    expect(d.calls.fetchAtSha).toBe(1);
  });

  it('goes straight to the verified GitHub path when no origin fetcher is wired (offline / bundle installs)', async () => {
    const { pin } = await publishClean();
    const d = deps(); // no fetchArtifact

    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin }, d);

    expect(await installedScript()).toBe(`return '${CLEAN}';`);
    expect(d.calls.fetchAtSha).toBe(1);
  });
});
