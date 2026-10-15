/**
 * SPA host shell tests — focuses on the pre-hydration globals injected into
 * `index.html` at serve time (`window.__PAPERCUSP_WS__`, `window.__PAPERCUSP_FLAGS__`).
 *
 * `host-spa.ts` resolves `SPA_DIST_ROOT` at import time from `PAPERCUSP_SPA_DIST`,
 * so the env var is set + the module dynamically imported inside `beforeAll`,
 * pointing at a tmp fixture `dist/` with a minimal `index.html`.
 *
 * Flags are forced via the `@papercusp/flags/test` override seam rather than a
 * live PostHog backend: with no backend configured (the test env has no
 * `~/.papercusp/posthog.json`), `getAllFlags()` consults `resolveTestOverrides()`
 * first, so a forced flag round-trips through the real serve path.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

// Stub the profile read so the pre-paint prefs injection has a deterministic
// value without a live PG connection.
vi.mock('@papercusp/operator-core/lib/session', () => ({
  readProfile: vi.fn(async () => ({ theme_id: 'black', visual_effects_mode: 'minimal' })),
}));

let spaRoutes: import('hono').Hono;
let createSpaRoutes: typeof import('./host-spa').createSpaRoutes;
let immutableCacheControl: typeof import('./host-spa').IMMUTABLE_CACHE_CONTROL;
let distDir: string;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'host-spa-dist-'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><head></head><body>app</body></html>');
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'assets', 'entry-AbCd1234.js'), 'export const entry = 1;');
  writeFileSync(join(distDir, 'assets', 'runtime.js'), 'export const runtime = 1;');
  writeFileSync(join(distDir, 'assets', 'SessionChatModal-fixture.css'), '.modal{}');
  mkdirSync(join(distDir, 'elevenlabs-runtime'));
  for (const name of ['rawAudioProcessor.js', 'audioConcatProcessor.js', 'libsamplerate.worklet.js']) {
    writeFileSync(join(distDir, 'elevenlabs-runtime', name), `// ${name}\nregisterProcessor("fixture", class {});`);
  }
  process.env.PAPERCUSP_SPA_DIST = distDir;
  ({ spaRoutes, createSpaRoutes, IMMUTABLE_CACHE_CONTROL: immutableCacheControl } = await import('./host-spa'));
});

afterEach(() => {
  setFlagOverridesForTest(null);
});

afterAll(() => {
  delete process.env.PAPERCUSP_SPA_DIST;
  rmSync(distDir, { recursive: true, force: true });
});

describe('SPA shell pre-hydration globals', () => {
  it.each(['rawAudioProcessor.js', 'audioConcatProcessor.js', 'libsamplerate.worklet.js'])('serves tutorial audio asset %s from the packaged SPA', async name => {
    const res = await spaRoutes.request(`/elevenlabs-runtime/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toBe(`// ${name}\nregisterProcessor("fixture", class {});`);
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('returns a real 404 for missing tutorial audio assets', async () => {
    const res = await spaRoutes.request('/elevenlabs-runtime/missing.js');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('injects the active workspace id global before the module bundle', async () => {
    const res = await spaRoutes.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store, max-age=0, no-transform');
    const body = await res.text();
    expect(body).toContain('window.__PAPERCUSP_WS__=');
    // Injected inside <head> so it runs before the deferred module entry.
    expect(body.indexOf('window.__PAPERCUSP_WS__=')).toBeLessThan(body.indexOf('</head>'));
  });

  it('injects the isolated-Tauri marker when the verifier launch env is set', async () => {
    process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED = '1';
    try {
      const res = await spaRoutes.request('/');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('window.__PAPERCUSP_TAURI_ISOLATED__=true;');
      expect(body.indexOf('window.__PAPERCUSP_TAURI_ISOLATED__=')).toBeLessThan(body.indexOf('</head>'));
    } finally {
      delete process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
    }
  });

  it('reloads a bare Inbox URL in the process-pinned workspace and honors an explicit window workspace', async () => {
    const previous = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = 'verify-tauri-isolated-fixture';
    try {
      const bare = await spaRoutes.request('/inbox?opci=all&opcis=coord-message%3Afixture');
      expect(await bare.text()).toContain('window.__PAPERCUSP_WS__="verify-tauri-isolated-fixture";');
      const scoped = await spaRoutes.request('/inbox?ws=another-window&opci=all');
      expect(await scoped.text()).toContain('window.__PAPERCUSP_WS__="another-window";');
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = previous;
    }
  });

  it('seeds resolved feature flags so gated UI does not flash defaults', async () => {
    setFlagOverridesForTest({ 'papercusp-testing': true });
    const res = await spaRoutes.request('/');
    const body = await res.text();
    // The payload is nested JSON, so slice from the assignment to the end of
    // THAT global and JSON.parse it rather than a brace-counting regex. The globals
    // are joined with '' inside one <script>, and the flags payload is not the last
    // one (EI-15848 appends window.__PAPERCUSP_BUILD_ID__ after it), so the slice
    // must stop at the next `;window.` assignment, not at `</script>`.
    const marker = 'window.__PAPERCUSP_FLAGS__=';
    const start = body.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const valueStart = start + marker.length;
    const nextGlobal = body.indexOf(';window.', valueStart);
    const scriptEnd = body.indexOf('</script>', valueStart);
    const end = nextGlobal === -1 ? scriptEnd : Math.min(nextGlobal, scriptEnd);
    const json = body.slice(valueStart, end).replace(/;$/, '');
    const payload = JSON.parse(json);
    expect(payload.flags['papercusp-testing']).toBe(true);
    expect(payload.source).toBe('override');
  });

  it('injects pre-paint presentation prefs (theme + visual-effects) before the bundle', async () => {
    const res = await spaRoutes.request('/');
    const body = await res.text();
    expect(body).toContain('window.__PAPERCUSP_PREFS__={"theme_id":"black","visual_effects_mode":"minimal"}');
    // Inside <head>, before the deferred module entry, so the boot scripts read it.
    expect(body.indexOf('window.__PAPERCUSP_PREFS__=')).toBeLessThan(body.indexOf('</head>'));
  });

  it('pins hosted hydration to the control-plane workspace and never exposes local state', async () => {
    process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED = '1';
    setFlagOverridesForTest({ 'papercusp-testing': true });
    try {
      const hostedRoutes = createSpaRoutes({
        kind: 'hosted',
        controlPlaneWorkspaceId: 'hosted-control-plane',
      });
      const res = await hostedRoutes.request('/?ws=other-tenant-workspace');
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store, max-age=0, no-transform');
      expect(body).toContain('window.__PAPERCUSP_WS__="hosted-control-plane";');
      const markerStart = body.indexOf("window.__PAPERCUSP_HOSTED_BROWSER__=");
      expect(markerStart).toBeGreaterThan(-1);
      const markerJson = body
        .slice(
          markerStart + "window.__PAPERCUSP_HOSTED_BROWSER__=".length,
          body.indexOf(";", markerStart),
        )
        .trim();
      expect(JSON.parse(markerJson)).toEqual({
        version: 1,
        controlPlaneWorkspaceId: "hosted-control-plane",
        restEndpoint: "/api/hosted/browser",
        sseEndpoint: "/api/hosted/browser/sse",
        workspaceHostEndpoints: {
          connection: "/api/hosted/browser/workspace-hosts/connection",
          provision: "/api/hosted/browser/workspace-hosts/provision",
          action: "/api/hosted/browser/workspace-hosts/action",
        },
      });
      expect(body).toContain(
        "window.__PAPERCUSP_HOSTED_BROWSER_API__=window.__PAPERCUSP_HOSTED_BROWSER__;",
      );
      expect(body).not.toContain('other-tenant-workspace');
      expect(body).not.toContain('window.__PAPERCUSP_PREFS__=');
      expect(body).not.toContain('window.__PAPERCUSP_FLAGS__=');
      expect(body).not.toContain('window.__PAPERCUSP_TAURI_ISOLATED__=');
    } finally {
      delete process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
    }
  });

  it('serves the shell for an unknown client route (200, not 404)', async () => {
    const res = await spaRoutes.request('/some/deep/client/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('window.__PAPERCUSP_WS__=');
  });

  it("script-escapes a hosted workspace marker before injecting it into HTML", async () => {
    const hostedRoutes = createSpaRoutes({
      kind: "hosted",
      controlPlaneWorkspaceId: "</script><script>window.compromised=1</script>",
    });
    const body = await (await hostedRoutes.request("/")).text();

    expect(body).not.toContain(
      "</script><script>window.compromised=1</script>",
    );
    expect(body).toContain("\\u003c/script\\u003e");
  });

  it('returns a real 404 for a missing extensioned asset (never shells a .js)', async () => {
    const res = await spaRoutes.request('/assets/does-not-exist.js');
    expect(res.status).toBe(404);
  });

  it('streams content-hashed assets with immutable caching while leaving mutable assets uncached', async () => {
    const hashed = await spaRoutes.request('/assets/entry-AbCd1234.js');
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get('cache-control')).toBe(immutableCacheControl);
    expect(hashed.headers.get('content-length')).toBe(String('export const entry = 1;'.length));
    expect(hashed.body).not.toBeNull();
    expect(await hashed.text()).toBe('export const entry = 1;');

    const mutable = await spaRoutes.request('/assets/runtime.js');
    expect(mutable.status).toBe(200);
    expect(mutable.headers.get('cache-control')).toBeNull();
    expect(await mutable.text()).toBe('export const runtime = 1;');
  });

  it('traces the first SessionChatModal CSS response once per Host when explicitly enabled', async () => {
    const previous = process.env.PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS;
    process.env.PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS = '1';
    const trace = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const routes = createSpaRoutes();
      const first = await routes.request(
        'http://localhost:33701/assets/SessionChatModal-fixture.css',
        { headers: { host: 'localhost:33701' } },
      );
      expect(first.status).toBe(200);
      expect(first.headers.get('content-length')).toBe(String('.modal{}'.length));
      expect(await first.text()).toBe('.modal{}');
      expect(trace).toHaveBeenCalledTimes(1);

      const logLine = String(trace.mock.calls[0]?.[0]);
      const record = JSON.parse(logLine.replace(/^\[spa-css-response\] /, ''));
      expect(record).toMatchObject({
        event: 'spa_css_response',
        host: 'localhost:33701',
        path: '/assets/SessionChatModal-fixture.css',
        status: 200,
        contentLength: String('.modal{}'.length),
        completion: 'complete',
      });
      expect(record.durationMs).toEqual(expect.any(Number));

      const second = await routes.request(
        'http://localhost:33701/assets/SessionChatModal-fixture.css',
        { headers: { host: 'localhost:33701' } },
      );
      await second.text();
      expect(trace).toHaveBeenCalledTimes(1);

      const loopbackAlias = await routes.request(
        'http://127.0.0.1:33701/assets/SessionChatModal-fixture.css',
        { headers: { host: '127.0.0.1:33701' } },
      );
      await loopbackAlias.text();
      expect(trace).toHaveBeenCalledTimes(2);

      const repeatedHost = await routes.request(
        'http://localhost:33701/assets/SessionChatModal-fixture.css',
        { headers: { host: 'localhost:33701' } },
      );
      await repeatedHost.text();
      expect(trace).toHaveBeenCalledTimes(2);

      const secondLogLine = String(trace.mock.calls[1]?.[0]);
      const secondRecord = JSON.parse(secondLogLine.replace(/^\[spa-css-response\] /, ''));
      expect(secondRecord).toMatchObject({
        event: 'spa_css_response',
        host: '127.0.0.1:33701',
        path: '/assets/SessionChatModal-fixture.css',
        status: 200,
        completion: 'complete',
      });
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS;
      else process.env.PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS = previous;
      trace.mockRestore();
    }
  });

  it('traces the first matching missing CSS asset as a completed 404 response', async () => {
    const previous = process.env.PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS;
    process.env.PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS = '1';
    const trace = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const routes = createSpaRoutes();
      const response = await routes.request(
        'http://127.0.0.1:33701/assets/SessionChatModal-missing.css',
        { headers: { host: '127.0.0.1:33701' } },
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
      expect(trace).toHaveBeenCalledTimes(1);
      const record = JSON.parse(
        String(trace.mock.calls[0]?.[0]).replace(/^\[spa-css-response\] /, ''),
      );
      expect(record).toMatchObject({
        host: '127.0.0.1:33701',
        path: '/assets/SessionChatModal-missing.css',
        status: 404,
        contentLength: null,
        completion: 'complete',
      });
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS;
      else process.env.PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS = previous;
      trace.mockRestore();
    }
  });
});
