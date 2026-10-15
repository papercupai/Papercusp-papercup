/**
 * WI-10004079 — the dev flag seed must never run during `vite build`.
 *
 * Without `apply: 'serve'`, Vite runs transformIndexHtml on build too, so every
 * built index.html (including the desktop sidecar's shipped spa/index.html)
 * baked the BUILD HOST's :3070 flag snapshot. That baked script ran after the
 * installed app's own host-spa.ts seed and overwrote it. These tests ask Vite
 * ITSELF which plugins survive each command, rather than reading a field, so a
 * plugin that is dropped from a build by any other means passes, and one that
 * leaks into a build fails.
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';
import {
  FLAGS_BOOTSTRAP_URL,
  flagsBootstrapPlugin,
  injectFlagsSeed,
  seedIndexHtmlWithFlags,
  seedIndexHtmlWithWorkspace,
} from './flags-bootstrap';

const PLUGIN_NAME = 'papercusp-flags-bootstrap';

describe('dev workspace identity before React mounts', () => {
  const html = '<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>';
  it('seeds a bare load from the proxied API host, before the provider bundle', async () => {
    const urls: string[] = [];
    const result = await seedIndexHtmlWithWorkspace(html, '/harness', 'http://127.0.0.1:4321', async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ current: 'isolated-workspace' }) };
    });
    expect(urls).toEqual(['http://127.0.0.1:4321/api/workspaces']);
    expect(result.indexOf('window.__PAPERCUSP_WS__="isolated-workspace"')).toBeLessThan(result.indexOf('src="/src/main.tsx"'));
    expect(result).toContain('window.__PAPERCUSP_WS__="isolated-workspace"');
  });
  it('preserves an explicit window workspace without consulting the global registry', async () => {
    const result = await seedIndexHtmlWithWorkspace(html, '/adv?ws=other-window', 'http://localhost', async () => {
      throw new Error('must not fetch registry');
    });
    expect(result).toContain('window.__PAPERCUSP_WS__="other-window"');
  });
  it('escapes script terminators in a workspace id', async () => {
    const result = await seedIndexHtmlWithWorkspace(html, '/?ws=%3C%2Fscript%3E', 'http://localhost');
    expect(result).toContain('window.__PAPERCUSP_WS__="\\u003c/script\\u003e"');
    expect(result).not.toContain('="</script>"');
  });
  it('leaves an unavailable registry to the browser fallback', async () => {
    expect(await seedIndexHtmlWithWorkspace(html, '/', 'http://localhost', async () => {
      throw new Error('offline');
    })).toBe(html);
  });
});

async function pluginNamesFor(command: 'build' | 'serve'): Promise<string[]> {
  const config = await resolveConfig(
    { configFile: false, logLevel: 'silent', plugins: [flagsBootstrapPlugin] },
    command,
  );
  return config.plugins.map((p) => p.name);
}

describe('flagsBootstrapPlugin (WI-10004079)', () => {
  it('is dropped by Vite from a build, so no built index.html bakes a flag seed', async () => {
    expect(await pluginNamesFor('build')).not.toContain(PLUGIN_NAME);
  });

  it('still runs on the dev server, where it replaces the host seed', async () => {
    expect(await pluginNamesFor('serve')).toContain(PLUGIN_NAME);
  });

  it('calibration: Vite keeps an un-scoped copy of the plugin in a build (the old bug)', async () => {
    const { apply: _apply, ...unscoped } = flagsBootstrapPlugin;
    const config = await resolveConfig(
      { configFile: false, logLevel: 'silent', plugins: [unscoped] },
      'build',
    );
    expect(config.plugins.map((p) => p.name)).toContain(PLUGIN_NAME);
  });
});

describe('seedIndexHtmlWithFlags', () => {
  const payload = { flags: { 'some-flag': true }, evaluatedAt: 1, source: 'posthog' };
  const ok = (body: unknown) => async () => ({ ok: true, json: async () => body });

  it('fetches the host bootstrap endpoint and seeds right after <head>', async () => {
    const seen: string[] = [];
    const out = await seedIndexHtmlWithFlags('<html><head><title>x</title></head></html>', async (url) => {
      seen.push(url);
      return ok(payload)();
    });
    expect(seen).toEqual([FLAGS_BOOTSTRAP_URL]);
    expect(out).toBe(`<html><head><script>window.__PAPERCUSP_FLAGS__=${JSON.stringify(payload)};</script><title>x</title></head></html>`);
  });

  it('leaves the document untouched when the host answers non-OK or is down', async () => {
    const html = '<html><head></head></html>';
    expect(await seedIndexHtmlWithFlags(html, async () => ({ ok: false, json: async () => payload }))).toBe(html);
    expect(
      await seedIndexHtmlWithFlags(html, async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).toBe(html);
  });

  it('prepends when the document has no <head>', () => {
    expect(injectFlagsSeed('<p>x</p>', { a: 1 })).toBe('<script>window.__PAPERCUSP_FLAGS__={"a":1};</script><p>x</p>');
  });
});
