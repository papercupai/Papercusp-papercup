import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBridge } from './bridge-client.js';
import { createVerifier } from './index.js';
import { findScreen, findScreenByRoute, SCREENS } from './screens.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Tauri verification surface', () => {
  it('falls back to /tmp for a PID token when the runtime temp directory differs', async () => {
    const pid = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const runtimeTempDir = await mkdtemp(join('/tmp', 'tauri-verify-runtime-'));
    const fallbackTokenPath = join('/tmp', `tauri-dev-bridge-${pid}.token`);

    try {
      await writeFile(
        fallbackTokenPath,
        JSON.stringify({ pid, port: 4444, token: 'fallback-token' }),
        { flag: 'wx' },
      );
      vi.stubEnv('TMPDIR', runtimeTempDir);
      expect(tmpdir()).toBe(runtimeTempDir);

      await expect(resolveBridge({ tauriPID: pid })).resolves.toEqual({
        ok: true,
        value: { pid, port: 4444, token: 'fallback-token' },
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(fallbackTokenPath, { force: true });
      await rm(runtimeTempDir, { recursive: true, force: true });
    }
  });

  it('never silently chooses among live desktops', async () => {
    const verifier = createVerifier();
    expect(verifier.config()).toEqual({ timeout: 10_000 });
    await expect(verifier.route('/adv')).resolves.toMatchObject({
      ok: false,
      code: 'target_required',
    });
  });

  it('uses an explicit authenticated bridge target and the webview origin for health', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          href: 'http://127.0.0.1:3170/adv?tab=learning',
          title: 'Papercusp',
          readyState: 'complete',
        }),
      }))
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          readyState: 'complete',
          rootMounted: true,
          href: 'http://127.0.0.1:3170/adv?tab=learning',
          pathname: '/adv',
          search: '?tab=learning',
          hash: '',
          origin: 'http://127.0.0.1:3170',
        }),
      }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await createVerifier({ bridgePort: 4444, bridgeToken: 'secret' }).appReady();
    expect(result).toMatchObject({
      ok: true,
      value: {
        bridgeConnected: true,
        webviewLoaded: true,
        apiHealthy: true,
        routerReady: true,
        route: { pathname: '/adv', search: '?tab=learning' },
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      new URL('http://127.0.0.1:3170/api/health'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const bridgeBody = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body));
    expect(bridgeBody).toMatchObject({ token: 'secret' });
    expect(bridgeBody.js).toContain('document.readyState');
  });

  it('fails app-ready when the target API is unhealthy instead of reporting a false green', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        result: JSON.stringify({ href: 'http://127.0.0.1:3170/adv', title: 'Papercusp', readyState: 'complete' }),
      }))
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          readyState: 'complete', rootMounted: true, href: 'http://127.0.0.1:3170/adv',
          pathname: '/adv', search: '', hash: '', origin: 'http://127.0.0.1:3170',
        }),
      }))
      .mockResolvedValueOnce(json({ error: 'down' }, 503));
    vi.stubGlobal('fetch', fetch);

    await expect(createVerifier({ bridgePort: 4444, bridgeToken: 'secret' }).appReady()).resolves.toMatchObject({
      ok: false,
      code: 'api_unhealthy',
    });
  });

  it('rejects a mounted route error boundary instead of reporting a false app-ready green', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          href: 'http://127.0.0.1:3170/adv', title: 'Papercusp', readyState: 'complete',
        }),
      }))
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          readyState: 'complete', rootMounted: true, href: 'http://127.0.0.1:3170/adv',
          pathname: '/adv', search: '', hash: '', origin: 'http://127.0.0.1:3170',
          routeError: 'This view hit an error',
        }),
      }));
    vi.stubGlobal('fetch', fetch);

    await expect(createVerifier({ bridgePort: 4444, bridgeToken: 'secret' }).appReady()).resolves.toMatchObject({
      ok: false,
      code: 'route_error_boundary',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('asserts a semantic screen using its route, query, and live selectors', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          href: 'http://127.0.0.1:3170/adv?tab=learning',
          pathname: '/adv', search: '?tab=learning', hash: '',
        }),
      }))
      .mockResolvedValueOnce(json({
        result: JSON.stringify([
          { selector: '.pc-advshell', present: true },
          { selector: '.pc-advshell__tab--learning[data-state="active"]', present: true },
        ]),
      }));
    vi.stubGlobal('fetch', fetch);

    await expect(createVerifier({ bridgePort: 4444, bridgeToken: 'secret' }).screen('learning')).resolves.toMatchObject({
      ok: true,
      value: { id: 'learning', href: '/adv?tab=learning' },
    });
  });

  describe('layout verification (EI-11084 — bridge, not xdotool screenshot)', () => {
    const layoutVerifier = () => createVerifier({ bridgePort: 4444, bridgeToken: 'secret' });

    it('passes a well-laid-out page: no horizontal page overflow, all elements within the viewport', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          json({
            result: JSON.stringify({
              viewportWidth: 1280,
              documentScrollWidth: 1280,
              measured: [{ selector: '.pc-advshell', found: true, left: 0, right: 1280, width: 1280, scrollWidth: 1280, clientWidth: 1280, overflowsInternally: false }],
            }),
          }),
        ),
      );
      await expect(layoutVerifier().layout({ selectors: ['.pc-advshell'] })).resolves.toMatchObject({
        ok: true,
        value: { viewportWidth: 1280, documentScrollWidth: 1280, horizontalOverflow: false },
      });
    });

    it('fails when the PAGE overflows horizontally — the layout regression a screenshot was meant to catch', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          json({ result: JSON.stringify({ viewportWidth: 1280, documentScrollWidth: 1440, measured: [] }) }),
        ),
      );
      await expect(layoutVerifier().layout()).resolves.toMatchObject({
        ok: false,
        code: 'horizontal_overflow',
      });
    });

    it('allows an overflow:auto container to scroll its own content while the page stays put (the eval fallback the author verified by hand)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          json({
            result: JSON.stringify({
              viewportWidth: 1280,
              documentScrollWidth: 1280,
              measured: [{ selector: '.pc-rubrics', found: true, left: 0, right: 1280, width: 1280, scrollWidth: 2400, clientWidth: 1280, overflowsInternally: true }],
            }),
          }),
        ),
      );
      const result = await layoutVerifier().layout({ scrollContainer: '.pc-rubrics' });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.value.scrollContainer).toMatchObject({ selector: '.pc-rubrics', overflowsInternally: true });
        expect(result.value.horizontalOverflow).toBe(false);
      }
    });

    it('fails when a target element extends past the viewport right edge', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          json({
            result: JSON.stringify({
              viewportWidth: 1280,
              documentScrollWidth: 1280,
              measured: [{ selector: '.pc-panel', found: true, left: 40, right: 1360, width: 1320, scrollWidth: 1320, clientWidth: 1320, overflowsInternally: false }],
            }),
          }),
        ),
      );
      await expect(layoutVerifier().layout({ selectors: ['.pc-panel'] })).resolves.toMatchObject({
        ok: false,
        code: 'element_overflow',
      });
    });

    it('fails clearly when a requested selector is not present', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          json({
            result: JSON.stringify({
              viewportWidth: 1280,
              documentScrollWidth: 1280,
              measured: [{ selector: '.pc-missing', found: false }],
            }),
          }),
        ),
      );
      await expect(layoutVerifier().layout({ selectors: ['.pc-missing'] })).resolves.toMatchObject({
        ok: false,
        code: 'layout_element_not_found',
      });
    });

    it('never silently drives an unspecified desktop', async () => {
      await expect(createVerifier().layout()).resolves.toMatchObject({ ok: false, code: 'target_required' });
    });
  });

  describe('semantic screen registry', () => {
    it('uses real shell selectors and concrete navigation destinations', () => {
      expect(SCREENS.ONBOARDING.requiredElements).toContain('.pc-onboarding-shell');
      expect(SCREENS.ADVANCED.requiredElements).toContain('.pc-advshell');
      expect(SCREENS.SETTINGS.requiredElements).toContain('.pc-settings-shell');
      expect(SCREENS.ADMIN.requiredElements).toContain('.pc-adminshell');
      expect(Object.values(SCREENS).every((screen) => screen.href.startsWith('/'))).toBe(true);
    });

    it('chooses a query-specific screen before the generic /adv surface', () => {
      expect(findScreenByRoute('/adv?tab=learning')?.id).toBe('learning');
      expect(findScreenByRoute('/adv?tab=harnesses')?.id).toBe('working');
      expect(findScreenByRoute('/adv')?.id).toBe('advanced');
    });

    it('finds screens by stable ID', () => {
      expect(findScreen('onboarding')?.name).toBe('Onboarding Console');
      expect(findScreen('unknown-screen')).toBeUndefined();
    });
  });
});
