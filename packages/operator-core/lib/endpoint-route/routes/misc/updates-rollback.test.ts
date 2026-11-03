import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeTauriUpdateAuthorization } from '@papercusp/tauri-release-kit/signature';
vi.mock('../../../operator-state-pg', () => ({ readOperatorState: vi.fn(async () => ({ update_channel: 'alpha' })) }));
vi.mock('../../../managed-update-policy', async importOriginal => ({
  ...(await importOriginal<object>()), readManagedUpdateChannel: vi.fn(() => null),
}));
vi.mock('./updates-github', async importOriginal => ({
  ...(await importOriginal<object>()), releaseHostBase: vi.fn(() => 'https://release.test'),
  resolveGithubToken: vi.fn(async () => null),
}));
import route from './updates-rollback';
import {
  pickStaticRollbackArtifact,
  selectRollbackRelease,
  selectStaticRollbackRelease,
  fetchStaticUpdateAuthorization,
} from './updates-rollback';
import type { GhRelease } from './updates-manifest';
import type { StaticHistoryRelease } from './updates-history';

/** Minimal GitHub release fixture (mirrors updates-history.test.ts). */
function rel(
  tag: string,
  published_at: string,
  opts: { prerelease?: boolean; draft?: boolean; assets?: string[] } = {},
): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    body: `notes for ${tag}`,
    published_at,
    prerelease: opts.prerelease ?? (tag.includes('-alpha') || tag.includes('-beta')),
    draft: opts.draft ?? false,
    assets: (opts.assets ?? []).map((name, i) => ({
      id: i + 1,
      name,
      browser_download_url: `https://example/${name}`,
    })),
  };
}

const RELEASES: GhRelease[] = [
  rel('desktop-v0.0.7-alpha', '2026-07-10T00:00:00Z'),
  rel('desktop-v0.0.6-beta', '2026-07-08T00:00:00Z'),
  rel('desktop-v0.0.5', '2026-07-05T00:00:00Z', { prerelease: false }), // stable
  rel('desktop-v0.0.4-draft', '2026-07-09T00:00:00Z', { draft: true }), // never selectable
];

describe('selectRollbackRelease — rollback target selection (pure)', () => {
  it('matches by the full git tag', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.5', channel: 'stable' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.release.tag_name).toBe('desktop-v0.0.5');
  });

  it('matches by the normalized version too (what the updater compares)', () => {
    const r = selectRollbackRelease(RELEASES, { tag: '0.0.5', channel: 'stable' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.release.tag_name).toBe('desktop-v0.0.5');
  });

  it('matches case-insensitively on the tag', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'DESKTOP-V0.0.7-ALPHA', channel: 'alpha' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.release.tag_name).toBe('desktop-v0.0.7-alpha');
  });

  it('reports unknown_tag for a tag that is not present', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'desktop-v9.9.9', channel: 'alpha' });
    expect(r).toEqual({ ok: false, reason: 'unknown_tag' });
  });

  it('never selects a draft release (even by exact tag)', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.4-draft', channel: 'alpha' });
    expect(r).toEqual({ ok: false, reason: 'unknown_tag' });
  });

  it('refuses a cross-channel rollback: a stable user cannot revert onto an alpha build', () => {
    const r = selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.7-alpha', channel: 'stable' });
    expect(r).toEqual({ ok: false, reason: 'channel_hidden' });
  });

  it('a beta user may revert to beta or stable but NOT alpha', () => {
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.6-beta', channel: 'beta' }).ok).toBe(true);
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.5', channel: 'beta' }).ok).toBe(true);
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.7-alpha', channel: 'beta' })).toEqual({
      ok: false,
      reason: 'channel_hidden',
    });
  });

  it('an alpha user may revert to any channel', () => {
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.7-alpha', channel: 'alpha' }).ok).toBe(true);
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.6-beta', channel: 'alpha' }).ok).toBe(true);
    expect(selectRollbackRelease(RELEASES, { tag: 'desktop-v0.0.5', channel: 'alpha' }).ok).toBe(true);
  });
});

// ── The static release host: the ONLY source that has post-2026-07-08 releases
// (WI-5008 — GitHub stops at 0.0.7, so a GitHub-only rollback could never
// resolve the releases the Update Center was offering Revert buttons for).
function staticRel(
  tag: string,
  version: string,
  channel: string,
  artifacts: Array<{ product: 'gui' | 'server' | string; platform: string; name: string }> = [],
): StaticHistoryRelease {
  return {
    tag,
    version,
    channel,
    notes: `notes for ${tag}`,
    pub_date: '2026-07-14T00:00:00Z',
    prerelease: channel !== 'stable',
    artifacts: artifacts.map((a, i) => ({
      product: a.product as 'gui' | 'server',
      platform: a.platform,
      name: a.name,
      url: `${tag}/${a.name}`,
      size: i + 1,
      sha256: `hash${i}`,
    })),
  };
}

const STATIC_RELEASES: StaticHistoryRelease[] = [
  staticRel('desktop-v0.0.10-alpha', '0.0.10', 'alpha', [
    { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp GUI_0.0.10_amd64.deb' },
    { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp_GUI_0.0.10_amd64.AppImage' },
    { product: 'server', platform: 'linux-x86_64', name: 'Papercusp Server_0.0.10_amd64.deb' },
  ]),
  // The REAL 0.0.9 shape: .deb/.dmg only — nothing the updater can swap.
  staticRel('desktop-v0.0.9-alpha', '0.0.9', 'alpha', [
    { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp GUI_0.0.9_amd64.deb' },
    { product: 'gui', platform: 'darwin-universal', name: 'Papercusp GUI_0.0.9_universal-apple-darwin.dmg' },
  ]),
  staticRel('desktop-v0.0.8-alpha', '0.0.8', 'alpha', [
    { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp_GUI_0.0.8_amd64.AppImage' },
  ]),
];

describe('rollback authorization transport', () => {
  afterEach(() => vi.restoreAllMocks());
  const envelope = () => ({
    payload: encodeTauriUpdateAuthorization({ schema: 'tauri-update-authorization-v1',
      artifactSha256: 'a'.repeat(64), policySha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64),
      sourceRevision: 'd'.repeat(40), version: '0.0.8', product: 'gui', platform: 'linux-x86_64',
      authorId: 'author', approverId: 'reviewer', approverEpoch: 1, signerId: 'signer', signerEpoch: 1,
      rootEpoch: 1, rollbackCounter: 5, issuedAt: 1000, expiresAt: 2000 }),
    signature: Buffer.from('untrusted comment: transport\nAA\ntrusted comment: transport\nAA\n').toString('base64'),
    approvalSignature: Buffer.from('untrusted comment: approval\nAA\ntrusted comment: approval\nAA\n').toString('base64'),
  });
  async function request(updateAuthorization: unknown) {
    const release = staticRel('desktop-v0.0.8-alpha', '0.0.8', 'alpha', [
      { product: 'gui', platform: 'linux-x86_64', name: 'Papercusp_GUI_0.0.8_amd64.AppImage' },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).endsWith('/history.json')
      ? Response.json({ releases: [{ ...release, artifacts: [{ ...release.artifacts[0], updateAuthorization }] }] })
      : new Response('artifact-signature'));
    return (route as unknown as { handler: (r: Request, c: unknown) => Promise<Response> }).handler(
      new Request('http://127.0.0.1/api/updates/rollback?tag=desktop-v0.0.8-alpha&channel=alpha'), {});
  }
  it('retains reviewed bytes in both flat and Tauri rollback manifests', async () => {
    const updateAuthorization = envelope();
    const response = await request(updateAuthorization);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.updateAuthorization).toEqual(updateAuthorization);
    expect(body.manifest.platforms['linux-x86_64'].updateAuthorization).toEqual(updateAuthorization);
  });
  it('reads the exact artifact companion instead of the newest release metadata', async () => {
    const updateAuthorization = envelope();
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ 'linux-x86_64': updateAuthorization }));
    expect(await fetchStaticUpdateAuthorization('https://release.test/desktop-v0.0.8/gui.AppImage', 'linux-x86_64'))
      .toEqual(updateAuthorization);
    expect(String(request.mock.calls[0][0])).toBe('https://release.test/desktop-v0.0.8/gui.AppImage.update-authorization.json');
  });
  it.each([null, {}, { 'windows-x86_64': {} }, { 'linux-x86_64': null }])(
    'refuses an invalid or wrong-platform companion: %j', async body => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
      await expect(fetchStaticUpdateAuthorization('https://release.test/gui.AppImage', 'linux-x86_64')).rejects.toThrow();
    });
  it('distinguishes legacy absence from a failed metadata read', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    expect(await fetchStaticUpdateAuthorization('https://release.test/gui.AppImage', 'linux-x86_64')).toBeUndefined();
    request.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(fetchStaticUpdateAuthorization('https://release.test/gui.AppImage', 'linux-x86_64')).rejects.toThrow();
  });
  it('refuses oversized metadata and cancels its body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    await expect(fetchStaticUpdateAuthorization('https://release.test/gui.AppImage', 'linux-x86_64')).rejects.toThrow('bound');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { payload: '{}', signature: 'unsigned', approvalSignature: 'unsigned' }])(
    'refuses malformed rollback authorization instead of removing it: %j', async bad => {
      const response = await request(bad);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, reason: 'invalid_update_authorization' });
    });
});

describe('selectStaticRollbackRelease — static-host rollback selection (pure)', () => {
  it('matches by full tag, normalized tag-version, and the feed version the app reports', () => {
    for (const tag of ['desktop-v0.0.8-alpha', '0.0.8-alpha', '0.0.8', 'DESKTOP-V0.0.8-ALPHA']) {
      const r = selectStaticRollbackRelease(STATIC_RELEASES, { tag, channel: 'alpha' });
      expect(r.ok, tag).toBe(true);
      expect(r.ok && r.release.tag).toBe('desktop-v0.0.8-alpha');
    }
  });

  it('reports unknown_tag for a tag not on the host', () => {
    expect(selectStaticRollbackRelease(STATIC_RELEASES, { tag: 'desktop-v9.9.9', channel: 'alpha' })).toEqual({
      ok: false,
      reason: 'unknown_tag',
    });
  });

  it('refuses a cross-channel rollback: a stable user cannot revert onto an alpha build', () => {
    expect(selectStaticRollbackRelease(STATIC_RELEASES, { tag: 'desktop-v0.0.8-alpha', channel: 'stable' })).toEqual({
      ok: false,
      reason: 'channel_hidden',
    });
  });
});

describe('pickStaticRollbackArtifact — what revert_to can actually swap (pure)', () => {
  it('picks the updater-installable artifact, never the .deb next to it', () => {
    const a = pickStaticRollbackArtifact(STATIC_RELEASES[0], 'linux-x86_64', 'gui');
    expect(a?.name).toBe('Papercusp_GUI_0.0.10_amd64.AppImage');
  });

  it('returns null for the .deb/.dmg-only 0.0.9 cut — resolvable but not swappable', () => {
    expect(pickStaticRollbackArtifact(STATIC_RELEASES[1], 'linux-x86_64', 'gui')).toBeNull();
    expect(pickStaticRollbackArtifact(STATIC_RELEASES[1], 'darwin-aarch64', 'gui')).toBeNull();
  });

  it('scopes by product — the Server never receives the GUI bundle', () => {
    expect(pickStaticRollbackArtifact(STATIC_RELEASES[2], 'linux-x86_64', 'server')).toBeNull();
  });
});
