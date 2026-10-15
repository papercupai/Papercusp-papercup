/**
 * cupboard-template-routes.test.ts — the standard-path template routes
 * (cupboard-full-dogfood-2026-07-10 P-003): install-template (clone → validate →
 * drop into the user template store) + publish-template (POST /listings as
 * kind=template). The install CORE is DI-tested end-to-end without git/network;
 * the routes are tested for their validation + wiring (the happy publish asserts
 * the `listing_kind: 'template'` payload; the happy install is exercised via the
 * core, so the route tests stay off the network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';

import {
  installTemplateFromCupboardCore,
  InstallTemplateError,
  type InstallTemplateCoreDeps,
} from '../../cupboard/install-template-core';

// publish-template's collaborators mocked to keep the route off the gh-token +
// GitHub + worker network (the install core imports neither, so these are inert
// for the core tests below).
const h = vi.hoisted(() => ({
  publishListingToCupboard: vi.fn(),
  fetchGithubRepoMeta: vi.fn(),
  defaultReleaseSigner: vi.fn(),
}));
vi.mock('../../cupboard/publish-listing', () => ({
  publishListingToCupboard: h.publishListingToCupboard,
}));
vi.mock('../../cupboard/blueprint-release-signer', async (orig) => ({
  ...(await orig<typeof import('../../cupboard/blueprint-release-signer')>()),
  defaultReleaseSigner: h.defaultReleaseSigner,
}));
vi.mock('../../cupboard/resolve-repo-coords', async (orig) => ({
  ...(await orig<typeof import('../../cupboard/resolve-repo-coords')>()),
  fetchGithubRepoMeta: h.fetchGithubRepoMeta,
}));

import installTemplateRoute from './cupboard-install-template';
import publishTemplateRoute from './cupboard-publish-template';

// ── DI helpers for the install core ───────────────────────────────────────────

/** A fake clone: materialize `<dest>/<ref>/<file>` trees given a spec. */
function fakeClone(refDirs: Record<string, Record<string, string>>) {
  return async (_url: string, dest: string) => {
    for (const [ref, files] of Object.entries(refDirs)) {
      for (const [name, content] of Object.entries(files)) {
        const p = join(dest, ref, name);
        await fs.mkdir(dirname(p), { recursive: true });
        await fs.writeFile(p, content);
      }
    }
  };
}

let scratch: string;
let userDir: string;
let tmpScratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'tpl-routes-'));
  userDir = join(scratch, 'user-templates');
  tmpScratch = join(scratch, 'tmp');
  await fs.mkdir(tmpScratch, { recursive: true });
  h.publishListingToCupboard.mockReset();
  h.fetchGithubRepoMeta.mockReset();
  const keypair = generateEd25519KeypairDer();
  h.defaultReleaseSigner.mockReset();
  h.defaultReleaseSigner.mockResolvedValue({
    githubUserId: 42,
    githubLogin: 'fixture-publisher',
    devicePubkey: keypair.pubkeyBase64,
    sign: async (bytes: Buffer) => signWithPrivateKeyDer(keypair.privateKeyDer, bytes),
  });
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

function depsWith(clone: InstallTemplateCoreDeps['cloneRepo']): InstallTemplateCoreDeps {
  return { cloneRepo: clone, userTemplatesDir: () => userDir, tmpDir: () => tmpScratch };
}

const REPO = 'https://github.com/Papercusp/templates';

// ── install core ──────────────────────────────────────────────────────────────

describe('installTemplateFromCupboardCore', () => {
  it('clones, validates, and copies the <ref>/ dir into the user store', async () => {
    const clone = fakeClone({
      'papercusp-webapp': {
        'template.yaml': 'id: papercusp-webapp\nversion: 1.2.3\n',
        'listing.json': JSON.stringify({ title: 'Web App', description: 'A web app template' }),
        'GUIDE.md': '# Build guide',
        '.git/config': '[core]', // must be excluded from the copy
      },
    });
    const res = await installTemplateFromCupboardCore(
      { githubUrl: REPO, listingRef: 'papercusp-webapp' },
      depsWith(clone),
    );
    expect(res).toMatchObject({
      ok: true,
      ref: 'papercusp-webapp',
      id: 'papercusp-webapp',
      title: 'Web App',
      version: '1.2.3',
      source: REPO,
    });
    expect(res.installedTo).toBe(join(userDir, 'papercusp-webapp'));
    expect(existsSync(join(userDir, 'papercusp-webapp', 'template.yaml'))).toBe(true);
    expect(existsSync(join(userDir, 'papercusp-webapp', 'GUIDE.md'))).toBe(true);
    // .git must NOT be copied into the store.
    expect(existsSync(join(userDir, 'papercusp-webapp', '.git'))).toBe(false);
  });

  it('replaces an existing installed ref (rm target before copy)', async () => {
    await fs.mkdir(join(userDir, 'papercusp-webapp'), { recursive: true });
    await fs.writeFile(join(userDir, 'papercusp-webapp', 'stale.txt'), 'old');
    const clone = fakeClone({
      'papercusp-webapp': { 'template.yaml': 'id: papercusp-webapp\n', 'GUIDE.md': 'g' },
    });
    await installTemplateFromCupboardCore({ githubUrl: REPO, listingRef: 'papercusp-webapp' }, depsWith(clone));
    expect(existsSync(join(userDir, 'papercusp-webapp', 'stale.txt'))).toBe(false);
    expect(existsSync(join(userDir, 'papercusp-webapp', 'template.yaml'))).toBe(true);
  });

  it('422s when the <ref>/ subdir is missing from the mirror', async () => {
    const clone = fakeClone({ 'some-other-template': { 'template.yaml': 'id: x\n' } });
    await expect(
      installTemplateFromCupboardCore({ githubUrl: REPO, listingRef: 'papercusp-webapp' }, depsWith(clone)),
    ).rejects.toMatchObject({ status: 422 });
    // nothing landed in the user store
    expect(existsSync(join(userDir, 'papercusp-webapp'))).toBe(false);
  });

  it('422s when the <ref>/ dir carries no template.yaml (not a template dir)', async () => {
    const clone = fakeClone({ 'papercusp-webapp': { 'GUIDE.md': 'just a guide' } });
    await expect(
      installTemplateFromCupboardCore({ githubUrl: REPO, listingRef: 'papercusp-webapp' }, depsWith(clone)),
    ).rejects.toBeInstanceOf(InstallTemplateError);
    expect(existsSync(join(userDir, 'papercusp-webapp'))).toBe(false);
  });

  it('400s a bad github_url before cloning', async () => {
    const clone = vi.fn();
    await expect(
      installTemplateFromCupboardCore({ githubUrl: 'https://evil.example/x', listingRef: 'a' }, depsWith(clone as never)),
    ).rejects.toMatchObject({ status: 400 });
    expect(clone).not.toHaveBeenCalled();
  });

  it('400s an unsafe ref before cloning', async () => {
    const clone = vi.fn();
    await expect(
      installTemplateFromCupboardCore({ githubUrl: REPO, listingRef: '../escape' }, depsWith(clone as never)),
    ).rejects.toMatchObject({ status: 400 });
    expect(clone).not.toHaveBeenCalled();
  });
});

// ── install route (validation + wiring) ───────────────────────────────────────

async function callInstall(body: unknown) {
  const req = new Request('http://127.0.0.1/api/cupboard/install-template', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = (await installTemplateRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe('POST /cupboard/install-template', () => {
  it('is a loopback route', () => {
    expect((installTemplateRoute as { auth?: unknown }).auth).toBe('loopback');
    expect((installTemplateRoute as { path?: unknown }).path).toBe('/cupboard/install-template');
  });

  it('400s invalid json', async () => {
    const { status, body } = await callInstall('{not json');
    expect(status).toBe(400);
    expect(body?.error).toBe('invalid_json');
  });

  it('400s with neither githubUrl nor listingId', async () => {
    const { status, body } = await callInstall({});
    expect(status).toBe(400);
    expect(body?.error).toBe('githubUrl or listingId required');
  });

  it('400s a githubUrl with no listingRef', async () => {
    const { status, body } = await callInstall({ githubUrl: REPO });
    expect(status).toBe(400);
    expect(body?.error).toBe('listingRef required (the template subdir)');
  });
});

// ── publish route ─────────────────────────────────────────────────────────────

async function callPublish(body: unknown) {
  const req = new Request('http://127.0.0.1/api/cupboard/publish-template', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = (await publishTemplateRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe('POST /cupboard/publish-template', () => {
  it('is a loopback route', () => {
    expect((publishTemplateRoute as { auth?: unknown }).auth).toBe('loopback');
    expect((publishTemplateRoute as { path?: unknown }).path).toBe('/cupboard/publish-template');
  });

  it('400s an invalid ref', async () => {
    const { status, body } = await callPublish({ ref: 'bad/ref', github_url: REPO });
    expect(status).toBe(400);
    expect(String(body?.error)).toContain('invalid template ref');
    expect(h.publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('400s a missing github_url', async () => {
    const { status, body } = await callPublish({ ref: 'papercusp-webapp' });
    expect(status).toBe(400);
    expect(String(body?.error)).toContain('github_url required');
    expect(h.publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('422s when the repo cannot be resolved on GitHub', async () => {
    h.fetchGithubRepoMeta.mockResolvedValueOnce(null);
    const { status } = await callPublish({ ref: 'papercusp-webapp', github_url: REPO });
    expect(status).toBe(422);
    expect(h.publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('publishes with listing_kind=template + resolved coords', async () => {
    h.fetchGithubRepoMeta.mockResolvedValueOnce({ id: 999, html_url: REPO });
    h.publishListingToCupboard.mockResolvedValueOnce({ ok: true, status: 200, data: { id: 'new-listing' } });
    const { status, body } = await callPublish({
      ref: 'papercusp-webapp',
      github_url: REPO,
      title: 'Official Web App',
      description: 'desc',
    });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ok: true, listing: { id: 'new-listing' } });
    expect(h.publishListingToCupboard).toHaveBeenCalledTimes(1);
    expect(h.publishListingToCupboard.mock.calls[0][0]).toMatchObject({
      listing_kind: 'template',
      listing_ref: 'papercusp-webapp',
      github_repository_id: 999,
      github_owner: 'Papercusp',
      github_name: 'templates',
      title: 'Official Web App',
      description: 'desc',
    });
  });

  it('defaults listing_ref to ref and surfaces an upstream failure', async () => {
    h.fetchGithubRepoMeta.mockResolvedValueOnce({ id: 5, html_url: REPO });
    h.publishListingToCupboard.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: 'rate_limited',
      detail: { bucket: 'hour' },
    });
    const { status, body } = await callPublish({ ref: 'papercusp-data-sync', github_url: REPO });
    expect(status, JSON.stringify(body)).toBe(429);
    expect(body?.error).toBe('rate_limited');
    expect(h.publishListingToCupboard.mock.calls[0][0]).toMatchObject({ listing_ref: 'papercusp-data-sync' });
  });
});
