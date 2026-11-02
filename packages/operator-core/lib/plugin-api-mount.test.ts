/**
 * Unit tests for the apiRoutes dispatcher + lazy registry rebuild.
 *
 * Covers the routing rewrite that landed 2026-04-30: instead of static
 * `app.mount('/plugins/<name>', ...)` (which Hono.app.route silently
 * shadows), the host keys an in-memory registry by safe-name and
 * forwards via `dispatchPluginApiRoute(req)`. The Hono-sub-app
 * `installPluginApiDispatcher` wrapper was deleted in the endpoint-hono
 * -elimination 2026-05-21 A3 migration; dispatch is now driven directly
 * from `routes/plugins/catchall.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatchPluginApiRoute,
  mountPluginApiRoutes,
  pluginApiRegistryNames,
  enumerateMountedPluginHttpSurfaces,
  pluginApiRoutesStatus,
  _resetPluginApiRoutesForTests,
} from './plugin-api-mount';

beforeEach(() => {
  _resetPluginApiRoutesForTests();
});

describe('dispatchPluginApiRoute', () => {
  it('captures actual mounted prefixes and declared subroutes without dropping opaque handlers', async () => {
    expect(enumerateMountedPluginHttpSurfaces()).toMatchObject({ initialized: false,
      unresolved: ['plugin-http-registry-not-initialized'] });
    const fakePlugin = { routes: [{ method: 'get', path: '/health' }, { method: 'POST', path: '/write' }],
      async fetch() { return new Response('ok'); } };
    const tmp = await makeTempPlugin('census-http', fakePlugin);
    await mountPluginApiRoutes({ globalPluginsDir: tmp.dir, harnessSlugs: [] });
    const first = enumerateMountedPluginHttpSurfaces();
    expect(first.surfaces.map(s => s.surfaceId)).toEqual([
      'ANY /api/plugins/census-http/*', 'GET /api/plugins/census-http/health', 'POST /api/plugins/census-http/write',
    ]);
    expect(first.surfaces[0].attrs?.innerRouteCoverage).toBe('unknown');
    fakePlugin.routes.push({ method: 'DELETE', path: '/late' });
    expect(enumerateMountedPluginHttpSurfaces().surfaces.map(s => s.surfaceId)).toContain('DELETE /api/plugins/census-http/late');
    expect(first.surfaces).toHaveLength(3);
  });

  it('preserves an opaque fetch prefix and refuses to run a route-list getter', async () => {
    let inspected = false;
    const fakePlugin = { get routes() { inspected = true; throw new Error('must not execute'); },
      async fetch() { return new Response('ok'); } };
    const tmp = await makeTempPlugin('opaque-http', fakePlugin);
    await mountPluginApiRoutes({ globalPluginsDir: tmp.dir, harnessSlugs: [] });
    const census = enumerateMountedPluginHttpSurfaces();
    expect(census.surfaces.map(s => s.surfaceId)).toEqual(['ANY /api/plugins/opaque-http/*']);
    expect(census.unresolved).toContain('plugin-http-inner-routes-opaque:opaque-http');
    expect(inspected).toBe(false);
  });

  it('returns null when the requested plugin is not registered', async () => {
    // Empty registry — first dispatch triggers a lazy rebuild with no
    // discovery sources, so the registry stays empty.
    const r = await dispatchPluginApiRoute(
      new Request('http://x/api/plugins/_papercupai_nope/ping'),
    );
    expect(r).toBeNull();
  });

  it('returns null when the path does not match /plugins/<name>', async () => {
    // Defensive — catch-all is /plugins/*, but Hono's host basePath
    // strip may hand the dispatcher unexpected shapes. A non-matching
    // path yields null (no forwarding).
    const r = await dispatchPluginApiRoute(
      new Request('http://x/api/something-else/here'),
    );
    expect(r).toBeNull();
  });

  it('dispatches to a plugin registered after the catch-all is mounted', async () => {
    // Demonstrates the Hono.route-snapshot footgun is resolved: registry
    // mutations after route registration are visible to subsequent
    // requests, because dispatch is per-request through `__cache`.
    const fakePlugin = {
      async fetch(req: Request) {
        const u = new URL(req.url);
        return Response.json({ ok: true, path: u.pathname });
      },
    };
    const tmp = await makeTempPlugin('test-plugin', fakePlugin);
    await mountPluginApiRoutes({ globalPluginsDir: tmp.dir, harnessSlugs: [] });
    expect(pluginApiRegistryNames()).toContain('test-plugin');

    const r = await dispatchPluginApiRoute(
      new Request('http://x/api/plugins/test-plugin/some/deep/path?q=1'),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    const body = await r!.json();
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/some/deep/path');
  });

  it('handles a bare plugin path (no trailing segment)', async () => {
    const fakePlugin = {
      async fetch(req: Request) {
        return Response.json({ ok: true, url: new URL(req.url).pathname });
      },
    };
    const tmp = await makeTempPlugin('bare', fakePlugin);
    await mountPluginApiRoutes({ globalPluginsDir: tmp.dir, harnessSlugs: [] });
    const r = await dispatchPluginApiRoute(
      new Request('http://x/api/plugins/bare'),
    );
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect((await r!.json()).ok).toBe(true);
  });

  it('clears the registry on reset and re-populates on the next mount call', async () => {
    const fakePlugin = { async fetch() { return Response.json({ alive: true }); } };
    const tmp = await makeTempPlugin('reborn', fakePlugin);
    await mountPluginApiRoutes({ globalPluginsDir: tmp.dir, harnessSlugs: [] });
    expect(pluginApiRegistryNames()).toContain('reborn');

    _resetPluginApiRoutesForTests();
    expect(pluginApiRegistryNames()).toEqual([]);

    // Calling mount again with the same fixture rebuilds the registry —
    // this is the path that install-plugin / uninstall / status?reset=1
    // exercise after a reset.
    await mountPluginApiRoutes({ globalPluginsDir: tmp.dir, harnessSlugs: [] });
    expect(pluginApiRegistryNames()).toContain('reborn');
  });

  it('records mount counts via pluginApiRoutesStatus', async () => {
    const fakePlugin = { async fetch() { return new Response('ok'); } };
    const tmp = await makeTempPlugin('counted', fakePlugin);
    const r = await mountPluginApiRoutes({ globalPluginsDir: tmp.dir, harnessSlugs: [] });
    expect(r.mounted).toBe(1);
    expect(pluginApiRoutesStatus()).toEqual(r);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * Test helpers
 * ───────────────────────────────────────────────────────────────────── */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeTempPlugin(
  name: string,
  apiRoutes: { fetch: (req: Request) => Promise<Response> | Response },
): Promise<{ dir: string }> {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-mount-test-'));
  const pluginDir = join(root, name);
  mkdirSync(pluginDir, { recursive: true });
  const manifest = {
    kind: 'plugin',
    name,
    version: '0.1.0',
    papercusp: '^0.1.0',
    capabilities: [],
  };
  writeFileSync(join(pluginDir, 'papercusp.json'), JSON.stringify(manifest, null, 2));
  // Stash the apiRoutes object on a globalThis-keyed slot so the entry
  // file can hand it back. Avoids serializing functions through JSON.
  const slot = `__papercusp_test_api_${name}`;
  (globalThis as any)[slot] = apiRoutes;
  const entry = `
const plugin = {
  kind: 'plugin',
  name: ${JSON.stringify(name)},
  version: '0.1.0',
  papercusp: '^0.1.0',
  capabilities: [],
  async init() {},
};
plugin.apiRoutes = globalThis[${JSON.stringify(slot)}];
module.exports = { default: plugin };
module.exports.default = plugin;
`;
  writeFileSync(join(pluginDir, 'index.js'), entry);
  return { dir: root };
}
