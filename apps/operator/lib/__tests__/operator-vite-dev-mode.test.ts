import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDesktopHmrEnabled, isDevWatchDisabled, NO_VITE_CLIENT_BODY, shouldInterceptStaticAnchor, shouldInterceptStaticAnchorClick, shouldServeNoopViteClient, shouldSuppressJsReload } from '../../../operator-vite/dev-mode';

describe('operator-vite file watcher opt-out (WI-10006950)', () => {
  it('keeps watching by default and for any value other than an explicit "0"', () => {
    expect(isDevWatchDisabled({})).toBe(false);
    expect(isDevWatchDisabled({ PAPERCUSP_DEV_WATCH: '1' })).toBe(false);
    expect(isDevWatchDisabled({ PAPERCUSP_DEV_WATCH: '' })).toBe(false);
    expect(isDevWatchDisabled({ PAPERCUSP_DEV_WATCH: 'false' })).toBe(false);
  });

  it('disables watching only through the explicit "0" opt-out', () => {
    expect(isDevWatchDisabled({ PAPERCUSP_DEV_WATCH: '0' })).toBe(true);
  });

  it('is independent of HMR, so the e2e server can keep the real client and stop reloads', () => {
    const e2eEnv = { PAPERCUSP_ENABLE_HMR: '1', PAPERCUSP_DEV_WATCH: '0' };
    expect(isDesktopHmrEnabled(e2eEnv)).toBe(true);
    expect(isDevWatchDisabled(e2eEnv)).toBe(true);
  });

  it('vite.config.ts maps the opt-out to server.watch: null', () => {
    const source = readFileSync(resolve(__dirname, '../../../operator-vite/vite.config.ts'), 'utf8');
    expect(source).toMatch(/watch:\s*isDevWatchDisabled\(process\.env\)\s*\?\s*null\s*:/);
  });
});

describe('operator-vite desktop no-HMR mode', () => {
  it('disables HMR by default', () => {
    expect(isDesktopHmrEnabled({})).toBe(false);
    expect(isDesktopHmrEnabled({ PAPERCUSP_ENABLE_HMR: '0', NEXT_PUBLIC_ENABLE_HMR: '0' })).toBe(false);
  });

  it('enables HMR only through explicit env opt-in', () => {
    expect(isDesktopHmrEnabled({ PAPERCUSP_ENABLE_HMR: '1' })).toBe(true);
    expect(isDesktopHmrEnabled({ NEXT_PUBLIC_ENABLE_HMR: '1' })).toBe(true);
  });

  it('serves a no-op Vite client only when HMR is disabled', () => {
    expect(shouldServeNoopViteClient('/@vite/client', false)).toBe(true);
    expect(shouldServeNoopViteClient('/src/main.tsx', false)).toBe(false);
    expect(shouldServeNoopViteClient('/@vite/client', true)).toBe(false);
    expect(NO_VITE_CLIENT_BODY).toContain('Vite HMR client disabled');
    // Load-bearing: route modules import { createHotContext } from /@vite/client
    // even with HMR off — an empty stub white-screens the webview.
    expect(NO_VITE_CLIENT_BODY).toContain('export function createHotContext');
  });
  it('uses the same static-host policy for reload suppression and same-origin navigation interception', () => {
    expect(shouldSuppressJsReload('http://localhost:3070')).toBe(true);
    expect(shouldSuppressJsReload('http://127.0.0.1:3070')).toBe(true);
    expect(shouldSuppressJsReload('http://localhost:4173')).toBe(true);
    expect(shouldSuppressJsReload('http://localhost:3055')).toBe(false);
  });
  it('intercepts same-origin anchor navigations only on static desktop hosts', () => {
    expect(shouldInterceptStaticAnchor('/support', 'http://localhost:3070/harness?ws=default')).toBe(true);
    expect(shouldInterceptStaticAnchor('/settings/operator', 'http://127.0.0.1:4173/harness')).toBe(true);
    expect(shouldInterceptStaticAnchor('https://example.com', 'http://localhost:3070/harness')).toBe(false);
    expect(shouldInterceptStaticAnchor('javascript:alert(1)', 'http://localhost:3070/harness')).toBe(false);
    expect(shouldInterceptStaticAnchor('/support', 'http://localhost:3055/harness')).toBe(false);
  });
  it('does not intercept modified, non-primary, download, or _blank anchor clicks', () => {
    const base = {
      targetHref: '/support',
      currentHref: 'http://localhost:3070/harness?ws=default',
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      download: false,
      targetBlank: false,
    };
    expect(shouldInterceptStaticAnchorClick(base)).toBe(true);
    expect(shouldInterceptStaticAnchorClick({ ...base, metaKey: true })).toBe(false);
    expect(shouldInterceptStaticAnchorClick({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldInterceptStaticAnchorClick({ ...base, shiftKey: true })).toBe(false);
    expect(shouldInterceptStaticAnchorClick({ ...base, altKey: true })).toBe(false);
    expect(shouldInterceptStaticAnchorClick({ ...base, button: 1 })).toBe(false);
    expect(shouldInterceptStaticAnchorClick({ ...base, download: true })).toBe(false);
    expect(shouldInterceptStaticAnchorClick({ ...base, targetBlank: true })).toBe(false);
    expect(shouldInterceptStaticAnchorClick({ ...base, defaultPrevented: true })).toBe(false);
  });

  it('keeps desktop dev defaulting to the no-HMR script', () => {
    const root = resolve(__dirname, '../../../..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['dev:operator']).toBe('npm --workspace @papercusp/operator-vite run dev:nohmr');
    expect(pkg.scripts?.['dev:operator:hmr']).toBe('npm --workspace @papercusp/operator-vite run dev');
    expect(pkg.scripts?.['dev:operator:nohmr']).toBe('npm --workspace @papercusp/operator-vite run dev:nohmr');

    // papercusp-desktop is an in-repo SUBMODULE now (desktop-submodule-of-papercup-2026-06-09):
    // read it at the in-repo path, and skip the desktop-side assertions in a checkout
    // that didn't init the submodule, so a non-recursive checkout can't wedge green-checkpoint.
    const desktopPkgPath = resolve(root, 'papercusp-desktop/package.json');
    if (existsSync(desktopPkgPath)) {
      const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      expect(desktopPkg.scripts?.dev).toBe('bin/desktop-dev-nohmr');
      expect(desktopPkg.scripts?.['dev:nohmr']).toBe('bin/desktop-dev-nohmr');
      expect(desktopPkg.scripts?.['dev:preview']).toBe('bin/desktop-preview-prod');
      // dev:hmr is the HMR opt-in: a tauri `dev` run pointed at the :3055 Vite
      // server, vs dev/dev:nohmr above which run the static no-HMR script.
      //
      // Match the SUBCOMMAND, not a spelling. This assertion used to read
      // toContain('tauri dev') and broke when dev:hmr was correctly rerouted
      // through the guarded `npm run tauri` chokepoint (bin/tauri-guarded,
      // EI-19369470572700441) — npm's `--` separator lands mid-phrase, so a
      // literal-substring check reds on a change that preserved every property
      // this test cares about. The chokepoint ROUTING invariant is owned by
      // papercusp-desktop/test/tauri-dev-slot-chokepoint.test.js (which checks
      // dev:hmr by name); duplicating it here with a worse failure message
      // would just send the next reader to the wrong red.
      expect(desktopPkg.scripts?.['dev:hmr']).toMatch(/\btauri\b(?:\s+--)?\s+dev\b/);
      // The devUrl override is what actually makes this the HMR variant.
      expect(desktopPkg.scripts?.['dev:hmr']).toContain('localhost:3055');
    }
  });
});
