/**
 * cupboard-release-pipeline-content-trust-2026-09-16 P-012 — the HOSTILE-PUBLISHER acceptance
 * scenario, end to end through the REAL Worker routes (publish, review/approve, the R2 origin,
 * the GitHub push webhook) against REAL SQLite with every shipped migration applied, and the REAL
 * installer core (`installRecipeFromCupboardCore`) reading a fixture GitHub mirror.
 *
 * D-009: GitHub is an injected fake (`stubGithub` + a fetch seam that answers the App's
 * installation-token / Check Run endpoints). Nothing here needs the registered App.
 *
 * The four things the plan exists to guarantee, one `it` each:
 *  1. clean publish -> approve -> the attacker force-pushes a DIRTY script into the mirror ->
 *     install (origin unavailable) is REFUSED `content-address-mismatch`, nothing is placed;
 *  2. the same hostile mirror, origin reachable -> the approved CLEAN bytes install, GitHub is
 *     never contacted, and an attacker cannot PUT dirty bytes at the clean content address;
 *  3. a publish that bypassed the client scrubber and carries an identity -> Worker 422
 *     `identity_leak`, no row minted;
 *  4. a push AFTER approval -> the row is marked drift, the pin/approval never move, and the
 *     install still serves the approved bytes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalTreeDigest, type TreeDigestEntry } from '@papercusp/artifact-registry';
import { installRecipeFromCupboardCore } from '@papercusp/operator-core/lib/cupboard/install-recipe-core.ts';
import { packSelfDescribingDir } from '@papercusp/operator-core/lib/cupboard/self-describing-release.ts';
import { buildArtifactPackage } from '@papercusp/operator-core/lib/p2p/artifact-package.ts';
import { _resetPapercuspRootForTests } from '@papercusp/operator-core/lib/papercusp-root.ts';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub, type GhStubTreeEntry } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1';

type Raw = ReturnType<typeof makeSqliteDb>['raw'];
type Env = ReturnType<typeof makeEnv>['env'];

const realFetch = globalThis.fetch;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const REF = 'hostile-demo';
const REPO_ID = 8;
const HOOK_SIGNER = 'hostile-hook';
const APP_ID = '424242';
const INSTALLATION_ID = 99;
const GITHUB_URL = 'https://github.com/papercupai/demo-project';
const PUBLISHER = { id: 5, login: 'pub' };
const OPERATOR = { id: 7, login: 'op' };
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// A throwaway App key + webhook signature (the registered App is owner-gated, D-009)
// ---------------------------------------------------------------------------
let pkcs8Bytes: Uint8Array;

function toPem(label: string, der: Uint8Array): string {
  let binary = '';
  for (const b of der) binary += String.fromCharCode(b);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  pkcs8Bytes = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
});

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(HOOK_SIGNER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// The fixture: a recipe, the GitHub mirror that holds it, and GitHub's tree/blob API over it
// ---------------------------------------------------------------------------
const CLEAN = 'clean';
const HOSTILE = 'hostile';
type Files = Record<string, string>;

function recipeFiles(marker: string): Files {
  return {
    'listing.json': `${JSON.stringify({ kind: 'recipe', version: '1.0.0' })}\n`,
    'recipe.json': `${JSON.stringify(
      { id: REF, title: `${marker} recipe`, description: 'Hostile-publisher fixture.', script: `return '${marker}';`, toolsUsed: [], tags: ['p012'], authorityUnresolved: false },
      null,
      2,
    )}\n`,
  };
}

const gitBlobSha = (content: Buffer): string => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

function treeEntries(files: Files): GhStubTreeEntry[] {
  return Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, text]) => ({ path: `${REF}/${name}`, sha: gitBlobSha(Buffer.from(text)), size: Buffer.byteLength(text) }));
}

/** Point the GitHub fake at `files` as the repo's tree at `head`, answering as `user`. */
function gh(user: { id: number; login: string }, head: string, files: Files): void {
  const entries = treeEntries(files);
  const blobs: Record<string, { content: string }> = {};
  for (const e of entries) blobs[e.sha] = { content: Buffer.from(files[e.path.slice(REF.length + 1)]!).toString('base64') };
  stubGithub({
    user,
    repo: { id: REPO_ID, private: false, permissions: { admin: true }, default_branch: 'main' },
    head: { sha: head },
    tree: { entries },
    blobs,
  });
}

let root: string;
let previousHome: string | undefined;
/** commit sha -> the files the MIRROR serves at that commit. */
let mirror: Map<string, Files>;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'hostile-publisher-'));
  previousHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = join(root, 'papercusp');
  _resetPapercuspRootForTests();
  mirror = new Map();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousHome;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The Worker under test
// ---------------------------------------------------------------------------
interface Ctx {
  api: ReturnType<typeof buildApi>;
  env: Env;
  raw: Raw;
}

function setup(): Ctx {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv({ DB: db, CUPBOARD_OPERATOR_GITHUB_IDS: String(OPERATOR.id) });
  const fullEnv = {
    ...env,
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_PRIVATE_KEY: toPem('RSA PRIVATE KEY', pkcs8Bytes.slice(26)),
    GITHUB_APP_WEBHOOK_SECRET: HOOK_SIGNER,
  } as Env;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    if (/\/app\/installations\/\d+\/access_tokens$/.test(u)) return new Response(JSON.stringify({ token: 'ghs_install_token' }), { status: 201 });
    if (/\/repos\/[^/]+\/[^/]+\/check-runs$/.test(u) && init?.method === 'POST') return new Response('{}', { status: 201 });
    return globalThis.fetch(url, init); // tree / blob / user / repo -> the shared GitHub fake, read lazily
  }) as typeof fetch;
  return { api: buildApi({ fetchImpl }), env: fullEnv, raw };
}

const JSON_AUTH = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };

const listingBody = (ref: string, releaseContentHash?: string) => ({
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: GITHUB_URL,
  project_ref: 'papercupai/demo-project',
  github_repository_id: REPO_ID,
  listing_kind: 'recipe',
  listing_ref: ref,
  ...(releaseContentHash ? { release_version: '1.0.0', release_content_hash: releaseContentHash } : {}),
});

const rowFor = (ctx: Ctx, ref: string): Record<string, unknown> =>
  ctx.raw.prepare('SELECT * FROM harnesses WHERE listing_ref = ?').get(ref) as unknown as Record<string, unknown>;

/** The publisher ships the ORIGIN bytes (PUT) and then publishes; an operator approves. */
async function publishAndApprove(ctx: Ctx): Promise<{ row: Record<string, unknown>; bytes: Buffer; hex: string }> {
  const files = recipeFiles(CLEAN);
  mirror.set(A, files);
  // The bytes a real publish ships: the canonical archive of the clean dir.
  const dir = join(root, 'publisher-dir');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(join(dir, name), text);
  const bytes = packSelfDescribingDir(dir);
  const releaseRoot = buildArtifactPackage(bytes).rootHash;
  const hex = releaseRoot.slice('sha256:'.length);

  gh(PUBLISHER, A, files);
  const put = await ctx.api.request(`/artifacts/sha256/${hex}`, { method: 'PUT', headers: { Authorization: 'Bearer t' }, body: new Uint8Array(bytes) }, ctx.env);
  expect(put.status).toBe(201);
  const published = await ctx.api.request('/listings', { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(listingBody(REF, releaseRoot)) }, ctx.env);
  expect(published.status).toBe(200);
  const pending = rowFor(ctx, REF);
  expect(pending).toMatchObject({ pinned_commit_sha: A, release_content_hash: releaseRoot, review_status: 'pending' });
  // The Worker pinned exactly what the installer will recompute from the mirror.
  expect(pending.pinned_tree_digest).toBe(await canonicalTreeDigest(treeEntries(files) as TreeDigestEntry[]));

  gh(OPERATOR, A, files);
  const approved = await ctx.api.request(`/admin/listings/${pending.id}/review`, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ decision: 'approve' }) }, ctx.env);
  expect(approved.status).toBe(200);
  const row = rowFor(ctx, REF);
  expect(row).toMatchObject({ review_status: 'approved', approved_commit_sha: A, approved_tree_digest: pending.pinned_tree_digest, drift: 0 });
  return { row, bytes, hex };
}

// ---------------------------------------------------------------------------
// The installer under test, reading the fixture mirror
// ---------------------------------------------------------------------------
async function listBlobs(dir: string): Promise<TreeDigestEntry[]> {
  const base = join(dir, REF);
  if (!existsSync(base)) return [];
  const out: TreeDigestEntry[] = [];
  for (const name of (await fs.readdir(base)).sort()) out.push({ path: `${REF}/${name}`, sha: gitBlobSha(await fs.readFile(join(base, name))) });
  return out;
}

function installDeps(fetchArtifact?: (hash: string) => Promise<Buffer | null>) {
  const calls = { fetchAtSha: 0, cloneRepo: 0, fetchArtifact: 0 };
  return {
    calls,
    cloneRepo: async () => {
      calls.cloneRepo++;
      throw new Error('a pinned install must never fall back to an unpinned tip clone');
    },
    fetchAtSha: async (_url: string, dest: string, sha: string) => {
      calls.fetchAtSha++;
      const files = mirror.get(sha);
      if (!files) throw new Error(`mirror has no commit ${sha}`);
      await fs.mkdir(join(dest, REF), { recursive: true });
      for (const [name, text] of Object.entries(files)) await fs.writeFile(join(dest, REF, name), text);
    },
    listTreeBlobs: async (cloneDir: string) => listBlobs(cloneDir),
    tmpDir: () => root,
    ...(fetchArtifact
      ? {
          fetchArtifact: async (hash: string) => {
            calls.fetchArtifact++;
            return fetchArtifact(hash);
          },
        }
      : {}),
  };
}

const pinOf = (row: Record<string, unknown>, withOrigin: boolean) => ({
  commitSha: row.pinned_commit_sha as string,
  treeDigest: row.pinned_tree_digest as string,
  ...(withOrigin ? { releaseContentHash: row.release_content_hash as string } : {}),
});

async function installedScript(): Promise<string> {
  const target = join(process.env.PAPERCUSP_HOME!, 'recipes', REF, 'recipe.json');
  return (JSON.parse(await fs.readFile(target, 'utf8')) as { script: string }).script;
}

const installedDirExists = (): boolean => existsSync(join(process.env.PAPERCUSP_HOME!, 'recipes', REF));

describe('hostile publisher — publish, approve, then poison the mirror (P-012)', () => {
  it('REFUSES content-address-mismatch when the mirror was force-pushed dirty and the origin is unavailable', async () => {
    const ctx = setup();
    const { row } = await publishAndApprove(ctx);

    // The attacker force-pushes a dirty script into the mirror at the approved commit.
    mirror.set(A, recipeFiles(HOSTILE));

    const d = installDeps(); // legacy / origin-less install: GitHub at the pinned commit is all there is
    await expect(installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin: pinOf(row, false) }, d)).rejects.toMatchObject({
      status: 422,
      code: 'content-address-mismatch',
    });
    expect(d.calls.fetchAtSha).toBe(1); // it DID look at the mirror ...
    expect(installedDirExists()).toBe(false); // ... and placed nothing hostile in the user layer
  });

  it('serves the approved CLEAN bytes from the origin on the same hostile mirror, and the origin refuses a dirty PUT at the clean address', async () => {
    const ctx = setup();
    const { row, hex } = await publishAndApprove(ctx);
    mirror.set(A, recipeFiles(HOSTILE));

    // The attacker also tries to overwrite the origin object with dirty bytes at the CLEAN address.
    const dirtyDir = join(root, 'dirty-dir');
    await fs.mkdir(dirtyDir, { recursive: true });
    for (const [name, text] of Object.entries(recipeFiles(HOSTILE))) await fs.writeFile(join(dirtyDir, name), text);
    gh(PUBLISHER, A, recipeFiles(HOSTILE));
    const poisoned = await ctx.api.request(`/artifacts/sha256/${hex}`, { method: 'PUT', headers: { Authorization: 'Bearer t' }, body: new Uint8Array(packSelfDescribingDir(dirtyDir)) }, ctx.env);
    expect(poisoned.status).toBe(422);
    expect(await poisoned.json()).toMatchObject({ error: 'content-address-mismatch' });

    const d = installDeps(async (hash) => {
      const res = await ctx.api.request(`/artifacts/sha256/${hash.slice('sha256:'.length)}`, {}, ctx.env);
      return res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null;
    });
    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin: pinOf(row, true) }, d);

    expect(await installedScript()).toBe(`return '${CLEAN}';`);
    expect(d.calls.fetchArtifact).toBe(1);
    expect(d.calls.fetchAtSha).toBe(0); // the poisoned mirror was never even consulted
  });

  it('refuses a publish that bypassed the client scrubber and carries an identity: Worker 422 identity_leak, no row minted', async () => {
    const ctx = setup();
    const leaky = recipeFiles(CLEAN);
    leaky['recipe.json'] = leaky['recipe.json']!.replace("return 'clean';", "return 'ssh -i /home/alice/.ssh/id_rsa alice@corp-example.com';");
    gh(PUBLISHER, A, leaky);

    // Posted straight at the Worker: the client-side scrubber is bypassed by construction.
    const res = await ctx.api.request('/listings', { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(listingBody(REF)) }, ctx.env);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'identity_leak', commitSha: A });
    expect(ctx.raw.prepare('SELECT COUNT(*) AS n FROM harnesses WHERE listing_ref = ?').get(REF)).toMatchObject({ n: 0 });
  });

  it('marks drift on a push AFTER approval, never moves the pin or approval, and still installs the approved bytes', async () => {
    const ctx = setup();
    const { row } = await publishAndApprove(ctx);

    // The publisher (or an attacker holding their push access) lands a new dirty commit on main.
    mirror.set(B, recipeFiles(HOSTILE));
    gh(PUBLISHER, B, recipeFiles(HOSTILE));
    const body = JSON.stringify({ ref: 'refs/heads/main', after: B, repository: { id: REPO_ID, default_branch: 'main' }, installation: { id: INSTALLATION_ID } });
    const res = await ctx.api.request(
      '/github/webhook',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': await signBody(body) }, body },
      ctx.env,
    );
    expect(res.status).toBe(200);

    const after = rowFor(ctx, REF);
    expect(after).toMatchObject({
      drift: 1,
      review_status: 'approved',
      pinned_commit_sha: row.pinned_commit_sha,
      pinned_tree_digest: row.pinned_tree_digest,
      approved_commit_sha: A,
      approved_tree_digest: row.approved_tree_digest,
    });

    // The install still resolves the PINNED commit — the pushed dirty tip is invisible to it.
    const d = installDeps();
    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: REF, pin: pinOf(after, false) }, d);
    expect(await installedScript()).toBe(`return '${CLEAN}';`);
    expect(d.calls.fetchAtSha).toBe(1);
  });
});
