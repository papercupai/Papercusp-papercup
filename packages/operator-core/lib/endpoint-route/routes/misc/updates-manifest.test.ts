import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../managed-update-policy', async importOriginal => ({
  ...(await importOriginal<object>()), readManagedUpdateChannel: vi.fn(() => null),
}));

vi.mock('../../../operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => ({ update_channel: 'stable' })),
}));

// The manifest route resolves a GitHub token + fetches .sig asset content
// through updates-github; mock the module so tests never shell out to the
// gh CLI or hit the network for sig content.
vi.mock('./updates-github', () => ({
  GITHUB_DESKTOP_REPO: 'Papercusp/papercusp-desktop',
  resolveGithubToken: vi.fn(async () => 'test-token'),
  fetchAssetText: vi.fn(async () => 'SIG_CONTENT'),
  fetchAssetResponse: vi.fn(async () => null),
  githubApiHeaders: (token: string | null) => ({
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }),
  releaseHostBase: vi.fn(() => null),
}));

import route, {
  pickAssetUrl,
  normalizeTagVersion,
  resolveChannel,
  classifyChannel,
  visibleChannels,
  DEFAULT_CHANNEL,
} from './updates-manifest';
import { resolveGithubToken, fetchAssetText, releaseHostBase } from './updates-github';
import { readOperatorState } from '../../../operator-state-pg';
import { readManagedUpdateChannel } from '../../../managed-update-policy';
import { encodeTauriUpdateAuthorization } from '@papercusp/tauri-release-kit/signature';

beforeEach(() => { vi.mocked(readManagedUpdateChannel).mockReset().mockReturnValue(null); });

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

async function manifestResponse(qs: string): Promise<Response> {
  const req = new Request(`http://127.0.0.1:3070/api/updates/manifest${qs}`);
  return (await (route as unknown as {
    handler: (r: Request, c: unknown) => Promise<Response>;
  }).handler(req, {})) as Response;
}

async function manifestStatus(qs: string): Promise<number> {
  return (await manifestResponse(qs)).status;
}

function toAssets(names: string[]) {
  return names.map((name, i) => ({
    id: i + 1,
    name,
    browser_download_url: `https://gh.test/${name}`,
  }));
}

const release = {
  tag_name: 'desktop-v0.0.2-alpha',
  published_at: '2026-06-11T00:00:00Z',
  prerelease: true,
  draft: false,
  assets: toAssets([
    'Papercusp_universal.app.tar.gz',
    'Papercusp_universal.app.tar.gz.sig',
    'Papercusp_0.0.2_universal.dmg',
    'Papercusp_0.0.2_amd64.AppImage.tar.gz',
    'Papercusp_0.0.2_amd64.AppImage.tar.gz.sig',
    'Papercusp_0.0.2_x64_en-US.msi.zip',
    'latest.json',
  ]),
};

describe('normalizeTagVersion', () => {
  it('strips the desktop-v prefix into valid semver', () => {
    expect(normalizeTagVersion('desktop-v0.0.4-alpha')).toBe('0.0.4-alpha');
    expect(normalizeTagVersion('desktop-v0.0.2-alpha.4')).toBe('0.0.2-alpha.4');
    expect(normalizeTagVersion('desktop-v1.2.3')).toBe('1.2.3');
    expect(normalizeTagVersion('v0.0.9')).toBe('0.0.9');
    expect(normalizeTagVersion('0.0.9')).toBe('0.0.9');
  });
});

describe('pickAssetUrl', () => {
  it('serves a darwin universal bundle to BOTH mac arches', () => {
    expect(pickAssetUrl(release, 'darwin', 'x86_64')).toBe(
      'https://gh.test/Papercusp_universal.app.tar.gz',
    );
    expect(pickAssetUrl(release, 'darwin', 'aarch64')).toBe(
      'https://gh.test/Papercusp_universal.app.tar.gz',
    );
  });

  it('never serves the .dmg as an update payload (tar.gz/zip only)', () => {
    const dmgOnly = {
      ...release,
      assets: release.assets.filter((a) => a.name.endsWith('.dmg')),
    };
    expect(pickAssetUrl(dmgOnly, 'darwin', 'x86_64')).toBeNull();
  });

  it('keeps linux/windows arch matching unchanged', () => {
    expect(pickAssetUrl(release, 'linux', 'x86_64')).toBe(
      'https://gh.test/Papercusp_0.0.2_amd64.AppImage.tar.gz',
    );
    expect(pickAssetUrl(release, 'windows', 'x86_64')).toBe(
      'https://gh.test/Papercusp_0.0.2_x64_en-US.msi.zip',
    );
    expect(pickAssetUrl(release, 'linux', 'aarch64')).toBeNull();
  });

  it('does not leak the universal wildcard to non-darwin targets', () => {
    const weird = {
      ...release,
      assets: [{ id: 1, name: 'Papercusp_universal.tar.gz', browser_download_url: 'https://gh.test/u' }],
    };
    expect(pickAssetUrl(weird, 'linux', 'x86_64')).toBeNull();
  });

  it('picks the Tauri v2 NSIS -setup.exe for windows (the real published shape), never its .sig', () => {
    const v2 = {
      ...release,
      assets: toAssets([
        'Papercusp_universal.app.tar.gz',
        'Papercusp_universal.app.tar.gz.sig',
        'Papercusp_0.0.2_universal.dmg',
        'Papercusp_0.0.2_amd64.deb',
        'Papercusp_0.0.2_x64-setup.exe',
        'Papercusp_0.0.2_x64-setup.exe.sig',
        'papercusp-latest-desktop-v0.0.2-alpha.json',
      ]),
    };
    expect(pickAssetUrl(v2, 'windows', 'x86_64')).toBe(
      'https://gh.test/Papercusp_0.0.2_x64-setup.exe',
    );
    // the bare exe never leaks to other targets
    expect(pickAssetUrl(v2, 'linux', 'x86_64')).toBeNull();
    expect(pickAssetUrl(v2, 'darwin', 'x86_64')).toBe(
      'https://gh.test/Papercusp_universal.app.tar.gz',
    );
  });

  it('scopes assets by PRODUCT — the GUI never gets a Server installer (and vice versa)', () => {
    const split = {
      ...release,
      assets: toAssets([
        'Papercusp.GUI_0.0.3_x64-setup.exe',
        'Papercusp.GUI_0.0.3_x64-setup.exe.sig',
        'Papercusp.Server_0.0.3_x64-setup.exe',
        'Papercusp.Server_0.0.3_x64-setup.exe.sig',
        'Papercusp GUI.app.tar.gz',
        'Papercusp Server.app.tar.gz',
      ]),
    };
    expect(pickAssetUrl(split, 'windows', 'x86_64', 'gui')).toBe(
      'https://gh.test/Papercusp.GUI_0.0.3_x64-setup.exe',
    );
    expect(pickAssetUrl(split, 'windows', 'x86_64', 'server')).toBe(
      'https://gh.test/Papercusp.Server_0.0.3_x64-setup.exe',
    );
    // default = gui
    expect(pickAssetUrl(split, 'windows', 'x86_64')).toBe(
      'https://gh.test/Papercusp.GUI_0.0.3_x64-setup.exe',
    );
    // pre-split assets (no product token) still serve both products
    expect(pickAssetUrl(release, 'darwin', 'x86_64', 'server')).toBe(
      'https://gh.test/Papercusp_universal.app.tar.gz',
    );
  });
});

describe('resolveChannel — default channel while the app is in alpha (WI-4389)', () => {
  it('enforces administrator policy ahead of both URL and saved preference, and re-reads it', () => {
    vi.mocked(readManagedUpdateChannel).mockReturnValue('stable');
    expect(resolveChannel(new URLSearchParams('channel=alpha'), 'beta')).toBe('stable');
    vi.mocked(readManagedUpdateChannel).mockReturnValue('beta');
    expect(resolveChannel(new URLSearchParams('channel=alpha'), 'stable')).toBe('beta');
  });

  it('propagates invalid policy instead of silently falling back to a user-selected lane', () => {
    vi.mocked(readManagedUpdateChannel).mockImplementation(() => { throw new Error('invalid administrator policy'); });
    expect(() => resolveChannel(new URLSearchParams('channel=alpha'), 'beta')).toThrow('invalid administrator policy');
  });
  it('defaults to alpha when NO ?channel= and NO stored channel (the fresh-install path)', () => {
    // The bug: this used to return 'stable', and visibleChannels('stable')={stable}
    // excludes the alpha releases that are the ONLY ones that exist → the updater
    // was silently DOA for any install that skipped the onboarding channel step.
    expect(resolveChannel(new URLSearchParams(''), undefined)).toBe('alpha');
    expect(DEFAULT_CHANNEL).toBe('alpha');
  });

  it('an explicit ?channel= query still wins over the default', () => {
    expect(resolveChannel(new URLSearchParams('channel=stable'), undefined)).toBe('stable');
    expect(resolveChannel(new URLSearchParams('channel=beta'), 'stable')).toBe('beta');
  });

  it('a persisted channel (override) wins over the default when no query is given', () => {
    expect(resolveChannel(new URLSearchParams(''), 'stable')).toBe('stable');
    expect(resolveChannel(new URLSearchParams(''), 'beta')).toBe('beta');
  });

  it('ignores a garbage channel and falls back to the default', () => {
    expect(resolveChannel(new URLSearchParams(''), 'bogus')).toBe('alpha');
    expect(resolveChannel(new URLSearchParams('channel='), undefined)).toBe('alpha');
  });

  it('refuses `nightly` as a LANE even though it is a known channel', () => {
    // `nightly` is recognised by the classifier (so it can be excluded) but is
    // not an update lane of this app — it is a side-by-side install with its own
    // bundle id and data home. Honouring it here would update someone's working
    // desktop into a different application.
    expect(resolveChannel(new URLSearchParams('channel=nightly'), undefined)).toBe('alpha');
    expect(resolveChannel(new URLSearchParams(''), 'nightly')).toBe('alpha');
  });
});

describe('channel classification — a nightly build must never reach a release install', () => {
  const rel = (tag: string, prerelease = false) => ({
    tag_name: tag,
    published_at: '2026-01-01T00:00:00Z',
    prerelease,
    draft: false,
    assets: [],
  });

  it('classifies each channel off its tag suffix', () => {
    expect(classifyChannel(rel('desktop-v0.0.14-nightly'))).toBe('nightly');
    expect(classifyChannel(rel('desktop-v0.0.14-alpha'))).toBe('alpha');
    expect(classifyChannel(rel('desktop-v0.0.14-beta'))).toBe('beta');
    expect(classifyChannel(rel('desktop-v0.0.14-rc1'))).toBe('beta');
    expect(classifyChannel(rel('desktop-v0.0.14'))).toBe('stable');
  });

  it('classifies a nightly tag as nightly even when it is not marked prerelease', () => {
    // The regression this guards: with no `-nightly` arm, the tag fell through
    // BOTH remaining arms to `stable` — the most dangerous bucket — and every
    // stable install would have been offered a nightly build.
    expect(classifyChannel(rel('desktop-v0.0.14-nightly', false))).toBe('nightly');
    expect(classifyChannel(rel('desktop-v0.0.14-nightly', true))).toBe('nightly');
  });

  it('is case-insensitive about the suffix', () => {
    expect(classifyChannel(rel('Desktop-V0.0.14-NIGHTLY'))).toBe('nightly');
  });

  it('no update lane can see nightly releases', () => {
    for (const lane of ['alpha', 'beta', 'stable'] as const) {
      expect(visibleChannels(lane).has('nightly')).toBe(false);
    }
  });

  it('a nightly client sees ONLY nightly — the two apps never cross', () => {
    const visible = visibleChannels('nightly');
    expect([...visible]).toEqual(['nightly']);
    for (const other of ['alpha', 'beta', 'stable'] as const) {
      expect(visible.has(other)).toBe(false);
    }
  });

  it('the existing lane nesting is unchanged', () => {
    expect([...visibleChannels('alpha')].sort()).toEqual(['alpha', 'beta', 'stable']);
    expect([...visibleChannels('beta')].sort()).toEqual(['beta', 'stable']);
    expect([...visibleChannels('stable')]).toEqual(['stable']);
  });

  it('CONTROL: the pre-fix classifier would have mis-filed a nightly tag as stable', () => {
    // The exact code this replaced, kept as a falsifiability control: it passes
    // every assertion above except the one that matters.
    const preFix = (tag: string, prerelease: boolean) => {
      const t = tag.toLowerCase();
      if (t.includes('-alpha')) return 'alpha';
      if (t.includes('-beta') || t.includes('-rc')) return 'beta';
      if (prerelease) return 'beta';
      return 'stable';
    };
    expect(preFix('desktop-v0.0.14-nightly', false)).toBe('stable');
    expect(visibleChannels('stable').has('stable')).toBe(true); // …and stable users would get it
    expect(classifyChannel(rel('desktop-v0.0.14-nightly'))).not.toBe('stable');
  });
});

describe('GET /api/updates/manifest — manifest contract with tauri-plugin-updater', () => {
  const guiRelease = {
    tag_name: 'desktop-v0.0.4-alpha',
    body: 'notes here',
    published_at: '2026-07-09T00:00:00Z',
    prerelease: true,
    draft: false,
    assets: toAssets([
      'Papercusp.GUI_0.0.4_x64-setup.exe',
      'Papercusp.GUI_0.0.4_x64-setup.exe.sig',
      'Papercusp_GUI_0.0.4_amd64.AppImage',
      'Papercusp_GUI_0.0.4_amd64.AppImage.sig',
      'papercusp-latest-desktop-v0.0.4-alpha.json',
    ]),
  };

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(resolveGithubToken).mockResolvedValue('test-token');
    vi.mocked(fetchAssetText).mockResolvedValue('SIG_CONTENT');
    vi.mocked(releaseHostBase).mockReturnValue(null);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify([guiRelease]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('serves semver version, INLINE sig content, and a proxied download URL', async () => {
    const res = await manifestResponse('?target=windows&arch=x86_64&current_version=0.0.3&channel=alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    // NOT "desktop-v0.0.4-alpha" — the plugin semver-parses this field.
    expect(body.version).toBe('0.0.4-alpha');
    const win = body.platforms['windows-x86_64'];
    // NOT a URL — the plugin base64-decodes this as minisign content.
    expect(win.signature).toBe('SIG_CONTENT');
    // Token-gated asset → served through the local operator proxy.
    expect(win.url).toContain('http://127.0.0.1:3070/api/updates/download?asset_id=1');
  });

  it('picks the bare .AppImage for linux and proxies it', async () => {
    const res = await manifestResponse('?target=linux&arch=x86_64&current_version=0.0.3&channel=alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Record<string, { url: string }> };
    expect(body.platforms['linux-x86_64'].url).toContain('/api/updates/download?asset_id=3');
  });

  // WI-2144851 / security-boundary-remediation-and-usability-2026-09-04 P-007,
  // Workstream C — "verify signed updates ... failure cases".
  //
  // WI-4364 already established the rule for the URL half of the manifest:
  // never offer an update that cannot be DOWNLOADED (it refuses a placeholder
  // url with cannot_check/manifest_unconfigured). The signature half had no
  // such rule: an absent or unfetchable .sig produced `signature: ''`, a
  // console.warn reading "install will fail verification", and a 200 serving
  // that manifest anyway. The updates/rollback sibling route — which shares this
  // route's asset/signature resolution — already fails closed here, refusing
  // with 409 no_signature ("surfaced, never served", updates-rollback.ts:44),
  // and the latest.json fallback further down THIS file also fails closed
  // (`entry?.signature && entry.url`). The GitHub-asset path was the one
  // fail-open corner of the three.
  //
  // The user-visible cost of serving it was a multi-GB download that Tauri then
  // rejects at verification — a failure the server had all the information to
  // predict before offering the update at all.
  describe('never offers an update that cannot be VERIFIED', () => {
    const noSigRelease = {
      ...guiRelease,
      assets: toAssets([
        'Papercusp.GUI_0.0.4_x64-setup.exe',
        // .sig deliberately absent — an unsigned cut, or a partial asset upload.
        'Papercusp_GUI_0.0.4_amd64.AppImage',
        'papercusp-latest-desktop-v0.0.4-alpha.json',
      ]),
    };

    const expectRefusal = async (res: Response) => {
      expect(res.status).toBe(204);
      expect(res.headers.get('X-Update-Check')).toBe('cannot_check');
      expect(res.headers.get('X-Update-Reason')).toBe('no_signature');
    };

    it('refuses when the release carries no .sig asset at all', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetch.mockResolvedValue(new Response(JSON.stringify([noSigRelease]), { status: 200 }));

      await expectRefusal(
        await manifestResponse('?target=windows&arch=x86_64&current_version=0.0.3&channel=alpha'),
      );
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('refuses when the .sig asset exists but its content cannot be fetched', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetchAssetText).mockResolvedValue(null); // 404 / token expired mid-flight

      await expectRefusal(
        await manifestResponse('?target=windows&arch=x86_64&current_version=0.0.3&channel=alpha'),
      );
      warnSpy.mockRestore();
    });

    it('refuses a whitespace-only signature — a truncated .sig is not a signature', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetchAssetText).mockResolvedValue('   \n');

      await expectRefusal(
        await manifestResponse('?target=windows&arch=x86_64&current_version=0.0.3&channel=alpha'),
      );
      warnSpy.mockRestore();
    });

    it('CONTROL: a real signature is still served, so the refusal is not blanket', async () => {
      // Without this, a route that refused EVERY update would pass all three
      // cases above and look correct.
      const res = await manifestResponse(
        '?target=windows&arch=x86_64&current_version=0.0.3&channel=alpha',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        platforms: Record<string, { signature: string }>;
      };
      expect(body.platforms['windows-x86_64'].signature).toBe('SIG_CONTENT');
    });
  });

  it('204s when current_version already matches the candidate (normalized)', async () => {
    const res = await manifestResponse(
      '?target=windows&arch=x86_64&current_version=0.0.4-alpha&channel=alpha',
    );
    expect(res.status).toBe(204);
    // WI-3697: the genuine up-to-date case is distinguishable from a
    // cannot-check 204 via this header (no X-Update-Reason alongside it).
    expect(res.headers.get('X-Update-Check')).toBe('up_to_date');
    expect(res.headers.get('X-Update-Reason')).toBeNull();
  });

  it('204s (with a server-side warn) when NO GitHub token is available — private repo', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(resolveGithubToken).mockResolvedValue(null);
    const res = await manifestResponse('?target=windows&arch=x86_64&current_version=0.0.3');
    expect(res.status).toBe(204);
    // WI-3697: distinguishable from a genuine up-to-date 204 — a preflight /
    // ops script (or a future UI affordance) reading only the status code
    // used to misread this as "up to date" (P-006/P-007 diagnostic detour).
    expect(res.headers.get('X-Update-Check')).toBe('cannot_check');
    expect(res.headers.get('X-Update-Reason')).toBe('no_token');
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('204s with X-Update-Reason=no_candidate when releases exist but none match the channel', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify([{ ...guiRelease, tag_name: 'desktop-v0.0.4-beta', prerelease: true }]),
        { status: 200 },
      ),
    );
    // channel=stable (default) excludes a beta-tagged release.
    const res = await manifestResponse('?target=windows&arch=x86_64&current_version=0.0.3');
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Check')).toBe('cannot_check');
    expect(res.headers.get('X-Update-Reason')).toBe('no_candidate');
  });

  it('falls back to latest.json + release host for artifacts too big for GitHub (Linux)', async () => {
    const noLinuxAssets = {
      ...guiRelease,
      assets: toAssets([
        'Papercusp.GUI_0.0.4_x64-setup.exe',
        'Papercusp.GUI_0.0.4_x64-setup.exe.sig',
        'papercusp-latest-desktop-v0.0.4-alpha.json',
      ]),
    };
    // HYBRID deployment (WI-4389): the release host serves the oversized BYTES
    // but publishes no `<host>/latest.json`, so discovery still falls through to
    // GitHub and the manifest comes from the release's latest.json ASSET. A
    // URL-aware mock is required — the route now probes the host first, and a
    // single mockResolvedValue Response can only have its body read once.
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/latest.json')) return new Response(null, { status: 404 });
      return new Response(JSON.stringify([noLinuxAssets]), { status: 200 });
    });
    vi.mocked(releaseHostBase).mockReturnValue('http://10.0.2.2:8043');
    vi.mocked(fetchAssetText).mockResolvedValue(
      JSON.stringify({
        version: '0.0.4-alpha',
        pub_date: '2026-07-09T00:00:00Z',
        platforms: {
          'linux-x86_64': {
            signature: 'INLINE_SIG_FROM_LATEST_JSON',
            url: '__RELEASE_HOST__/Papercusp_GUI_0.0.4_amd64.AppImage',
          },
        },
      }),
    );
    const res = await manifestResponse('?target=linux&arch=x86_64&current_version=0.0.3&channel=alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    expect(body.version).toBe('0.0.4-alpha');
    const linux = body.platforms['linux-x86_64'];
    expect(linux.signature).toBe('INLINE_SIG_FROM_LATEST_JSON');
    expect(linux.url).toContain('/api/updates/download?tag=desktop-v0.0.4-alpha');
    expect(linux.url).toContain('name=Papercusp_GUI_0.0.4_amd64.AppImage');
  });

  it('returns an expected no-update result when the selected release has no platform asset', async () => {
    vi.mocked(releaseHostBase).mockReturnValue(null);
    const res = await manifestResponse(
      '?target=linux&arch=aarch64&current_version=0.0.3&channel=alpha',
    );
    // A missing release artifact is not an invalid request. 204 keeps the
    // Tauri updater quiet; the reason header lets acceptance/ops fetch callers
    // distinguish this expected no-update from an endpoint failure.
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Check')).toBe('cannot_check');
    expect(res.headers.get('X-Update-Reason')).toBe('no_candidate');
  });
});

describe('GET /api/updates/manifest — graceful degradation when GitHub is unreachable', () => {
  // The route intentionally warns server-side on a fetch failure (ops observability);
  // spy it so the repo's fail-on-console guard is satisfied AND assert it fired.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(resolveGithubToken).mockResolvedValue('test-token');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('returns 204 (NOT 502) when GitHub rate-limits the releases fetch (403)', async () => {
    mockFetch.mockResolvedValue(new Response('rate limited', { status: 403 }));
    const res = await manifestResponse('?target=linux&arch=x86_64&current_version=0.0.1');
    expect(res.status).toBe(204);
    // WI-3697: distinguishable cannot-check reason (not a genuine up-to-date).
    expect(res.headers.get('X-Update-Check')).toBe('cannot_check');
    expect(res.headers.get('X-Update-Reason')).toBe('fetch_failed');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns 204 when the releases fetch throws (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const res = await manifestResponse('?target=linux&arch=x86_64&current_version=0.0.1');
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Reason')).toBe('fetch_failed');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns 204 when GitHub 5xxs', async () => {
    mockFetch.mockResolvedValue(new Response('boom', { status: 503 }));
    const res = await manifestResponse('?target=linux&arch=x86_64&current_version=0.0.1');
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Reason')).toBe('fetch_failed');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns 204 with X-Update-Reason=fetch_failed when the releases listing 404s', async () => {
    mockFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    const res = await manifestResponse('?target=linux&arch=x86_64&current_version=0.0.1');
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Check')).toBe('cannot_check');
    expect(res.headers.get('X-Update-Reason')).toBe('fetch_failed');
  });
});

/**
 * WI-4389: LOCAL-only release discovery. Releases are no longer published to
 * GitHub [owner 2026-07-08], so the GitHub path finds no candidate and
 * returns a 204 the updater reads as "up to date" — auto-update dies silently.
 * When PAPERCUSP_RELEASE_HOST is set it is now the AUTHORITATIVE source and
 * GitHub must not be consulted at all.
 */
describe('GET /api/updates/manifest — static release host is authoritative (LOCAL-only rail)', () => {
  const HOST = 'https://dl.papercusp.test/desktop';

  const latestJson = (over: Record<string, unknown> = {}) => ({
    version: '0.0.9',
    channel: 'alpha',
    notes: 'notes here',
    pub_date: '2026-07-12T01:43:20Z',
    platforms: {
      'linux-x86_64': {
        signature: 'MINISIGN_INLINE',
        url: `${HOST}/desktop-v0.0.9-alpha/Papercusp_GUI_0.0.9_amd64.AppImage`,
      },
    },
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.mocked(releaseHostBase).mockReturnValue(HOST);
    vi.mocked(resolveGithubToken).mockResolvedValue('test-token');
    mockFetch.mockResolvedValue(new Response(JSON.stringify(latestJson()), { status: 200 }));
  });
  afterEach(() => vi.mocked(releaseHostBase).mockReturnValue(null));

  it('preserves exact per-platform approval bytes through the real static response', async () => {
    const updateAuthorization = {
      payload: encodeTauriUpdateAuthorization({ schema: 'tauri-update-authorization-v2',
        artifactSha256: 'a'.repeat(64), policySha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64),
        sourceRevision: 'd'.repeat(40), version: '0.0.9', product: 'gui', platform: 'linux-x86_64',
        authorIds: ['author', 'coauthor'], approverId: 'reviewer', approverEpoch: 1, signerId: 'signer', signerEpoch: 1,
        rootEpoch: 1, rollbackCounter: 5, issuedAt: 1000, expiresAt: 2000 }),
      // Structural transport fixture; authenticity is covered by the release-kit suite.
      signature: Buffer.from('untrusted comment: transport\nAA\ntrusted comment: transport\nAA\n').toString('base64'),
      approvalSignature: Buffer.from('untrusted comment: approval\nAA\ntrusted comment: approval\nAA\n').toString('base64'),
    };
    const latest = latestJson();
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ...latest, platforms: {
      'linux-x86_64': { ...latest.platforms['linux-x86_64'], updateAuthorization },
    } })));
    const response = await manifestResponse('?target=linux&arch=x86_64&channel=alpha');
    expect(response.status).toBe(200);
    expect((await response.json()).platforms['linux-x86_64'].updateAuthorization).toEqual(updateAuthorization);
  });

  it.each([null, {}, { payload: '{}', signature: 'unsigned', approvalSignature: 'unsigned' }])(
    'refuses malformed authorization without falling back to unsigned metadata: %j', async updateAuthorization => {
      const latest = latestJson();
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ ...latest, platforms: {
        'linux-x86_64': { ...latest.platforms['linux-x86_64'], updateAuthorization },
      } })));
      const response = await manifestResponse('?target=linux&arch=x86_64&channel=alpha');
      expect(response.status).toBe(204);
      expect(response.headers.get('X-Update-Reason')).toBe('invalid_update_authorization');
      expect(resolveGithubToken).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

  it('serves the manifest from <host>/latest.json and NEVER touches GitHub', async () => {
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.8&product=gui&channel=alpha',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    expect(body.version).toBe('0.0.9');
    // Inline minisign content + the absolute host URL, served as-is (the static
    // host is public — no token-gated /api/updates/download proxy rewrite).
    expect(body.platforms['linux-x86_64'].signature).toBe('MINISIGN_INLINE');
    expect(body.platforms['linux-x86_64'].url).toBe(
      `${HOST}/desktop-v0.0.9-alpha/Papercusp_GUI_0.0.9_amd64.AppImage`,
    );

    // The whole point: no GitHub API call, no token resolution.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]![0])).toBe(`${HOST}/latest.json`);
    expect(String(mockFetch.mock.calls[0]![0])).not.toContain('api.github.com');
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it('204 up_to_date when the host version equals the running version', async () => {
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.9&product=gui&channel=alpha',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Check')).toBe('up_to_date');
  });

  it('REFUSES a placeholder url — never offer an update that cannot be downloaded (WI-4364)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify(
          latestJson({
            platforms: {
              'linux-x86_64': {
                signature: 'MINISIGN_INLINE',
                url: 'papercusp-update-base-unset://SET-PAPERCUSP_UPDATE_BASE_URL/desktop-v0.0.9-alpha/x.AppImage',
              },
            },
          }),
        ),
        { status: 200 },
      ),
    );
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.8&product=gui&channel=alpha',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Check')).toBe('cannot_check');
    expect(res.headers.get('X-Update-Reason')).toBe('manifest_unconfigured');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('WI-10003699: a manifest with no build for this platform (platform-only release) reads as up to date', async () => {
    // A fresh Response per call: a body can be read only once.
    mockFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify(
            latestJson({
              version: '0.0.23',
              platforms: {
                'windows-x86_64': {
                  signature: 'MINISIGN_INLINE',
                  url: `${HOST}/desktop-v0.0.23-alpha/Papercusp_GUI_0.0.23_x64-setup.exe`,
                },
              },
            }),
          ),
          { status: 200 },
        ),
    );
    const linux = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.22&product=gui&channel=alpha',
    );
    expect(linux.status).toBe(204);
    expect(linux.headers.get('X-Update-Check')).toBe('up_to_date');
    expect(linux.headers.get('X-Update-Reason')).toBeNull();
    // The platform the release DOES carry is still offered the update.
    const windows = await manifestResponse(
      '?target=windows&arch=x86_64&current_version=0.0.22&product=gui&channel=alpha',
    );
    expect(windows.status).toBe(200);
    expect(((await windows.json()) as { version: string }).version).toBe('0.0.23');
  });

  it('honours the channel gate — a stable client is not offered an alpha build', async () => {
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.8&product=gui&channel=stable',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Reason')).toBe('no_candidate');
  });

  it('WI-4404: a Server poll fetches latest-server.json, NOT latest.json', async () => {
    // The blanket mock always answers with the GUI-flavored latestJson() (its
    // url has no "server" token) regardless of which file was requested — so a
    // product=server poll must be refused (defense-in-depth cross-check, not
    // the old hard `product !== 'gui'` gate) even though a 200 came back.
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.8&product=server&channel=alpha',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Reason')).toBe('no_candidate');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]![0])).toBe(`${HOST}/latest-server.json`);
  });

  it('WI-4404: serves a genuine latest-server.json to a Server poll', async () => {
    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${HOST}/latest-server.json`) {
        return new Response(
          JSON.stringify(
            latestJson({
              platforms: {
                'linux-x86_64': {
                  signature: 'SERVER_SIG',
                  url: `${HOST}/desktop-v0.0.9-alpha/Papercusp_Server_0.0.9_amd64.AppImage`,
                },
              },
            }),
          ),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(latestJson()), { status: 200 });
    });
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.8&product=server&channel=alpha',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    expect(body.platforms['linux-x86_64'].signature).toBe('SERVER_SIG');
    expect(body.platforms['linux-x86_64'].url).toBe(
      `${HOST}/desktop-v0.0.9-alpha/Papercusp_Server_0.0.9_amd64.AppImage`,
    );
  });

  it('WI-4404: a missing latest-server.json (404) falls through to GitHub, same as a GUI miss', async () => {
    // Mirrors the existing GUI-path contract ("host publishes no usable
    // manifest" -> not an error, fall through to the GitHub hybrid path) —
    // a 404 on latest-server.json is handled identically, not a special case.
    // With no matching GitHub release either, this settles on 204/no_candidate.
    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${HOST}/latest-server.json`) return new Response(null, { status: 404 });
      if (url.includes('api.github.com')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify(latestJson()), { status: 200 });
    });
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.8&product=server&channel=alpha',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Reason')).toBe('no_candidate');
  });

  it('WI-4404: never offers a GUI artifact to a Server poll even if latest-server.json is mis-served', async () => {
    // A hand-edited / stale latest-server.json that (wrongly) points at a GUI
    // artifact must still be refused — the cross-check is defense in depth,
    // not just a filename-routing convenience.
    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${HOST}/latest-server.json`) return new Response(JSON.stringify(latestJson()), { status: 200 });
      return new Response(JSON.stringify(latestJson()), { status: 200 });
    });
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.8&product=server&channel=alpha',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Reason')).toBe('no_candidate');
  });

  it('degrades to 204 (not 5xx) when the release host is unreachable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await manifestResponse(
      '?target=linux&arch=x86_64&current_version=0.0.8&product=gui&channel=alpha',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Update-Reason')).toBe('fetch_failed');
    warnSpy.mockRestore();
  });
});
