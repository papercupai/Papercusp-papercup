/**
 * Recurrence guard over the REAL bundled plugins for advertised-but-uncallable tools
 * (WI-6554700010012944).
 *
 * THE DEFECT: firecrawl-bridge advertised `tools:firecrawl:crawl` (and "site-wide crawls" in its
 * description) while neither its manifest `tools[]` nor its runtime exported a crawl tool. The
 * loader's own validation could not see it: that checks manifest tools against handlers, and the
 * phantom tool was in neither — only in the advertised capability list agents and installers read.
 *
 * Three checks, each over every bundled plugin:
 *   1. lintToolCapabilityParity — every top-level `tools:*` capability is claimed by a tool.
 *   2. The plugin loads through the real loader (manifest tools ↔ runtime handlers).
 *   3. The typed `index.ts` exports the same tool set as the runtime artifact the loader runs
 *      (the gitnexus-bridge drift class: an edit to one file that never reaches the other).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lintToolCapabilityParity, type ManifestForLint } from './manifest-lint';
import { loadPluginFromDir } from './index';

const PLUGINS_DIR = process.env.PAPERCUSP_BUNDLED_PLUGINS_DIR
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/plugins');

interface BundledPlugin {
  dir: string;
  path: string;
  manifest: ManifestForLint & { tools?: Array<{ name: string; capabilities?: string[] }> };
}

const bundled: BundledPlugin[] = existsSync(PLUGINS_DIR)
  ? readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(PLUGINS_DIR, entry.name, 'papercusp.json')))
      .map((entry) => ({
        dir: entry.name,
        path: join(PLUGINS_DIR, entry.name),
        manifest: JSON.parse(readFileSync(join(PLUGINS_DIR, entry.name, 'papercusp.json'), 'utf8')),
      }))
  : [];

/** Plugins that declare static tools and ship a CommonJS runtime artifact. */
const staticToolPlugins = bundled.filter(
  (p) => (p.manifest.tools?.length ?? 0) > 0 && existsSync(join(p.path, 'index.cjs')),
);

function toolKeys(mod: unknown): string[] {
  const m = mod as { tools?: Record<string, unknown>; default?: { tools?: Record<string, unknown> } };
  return Object.keys(m?.tools ?? m?.default?.tools ?? {}).sort();
}

describe('bundled plugins: advertised tools are callable', () => {
  it('finds the bundled static-tool plugins, including firecrawl-bridge', () => {
    expect(bundled.length).toBeGreaterThan(10);
    expect(staticToolPlugins.map((p) => p.dir)).toEqual(
      expect.arrayContaining(['firecrawl-bridge', 'repomix', 'fetch-plus']),
    );
  });

  it.each(bundled.map((p) => [p.dir, p] as const))(
    '%s: every tools: capability is claimed by a declared tool',
    (_dir, p) => {
      expect(lintToolCapabilityParity(p.manifest)).toEqual([]);
    },
  );

  it.each(staticToolPlugins.map((p) => [p.dir, p] as const))(
    '%s: loads through the real loader with a handler for every manifest tool',
    async (_dir, p) => {
      const result = await loadPluginFromDir(p.path, 'global');
      expect('error' in result ? result.error : null).toBeNull();
      expect('skipped' in result ? result.skipped : null).toBeNull();
      const runtime = createRequire(import.meta.url)(join(p.path, 'index.cjs'));
      expect(toolKeys(runtime)).toEqual((p.manifest.tools ?? []).map((t) => t.name).sort());
    },
  );

  it.each(
    staticToolPlugins
      .filter((p) => existsSync(join(p.path, 'index.ts')))
      .map((p) => [p.dir, p] as const),
  )('%s: index.ts exports the same tool set as the index.cjs runtime', async (_dir, p) => {
    const source = await import(pathToFileURL(join(p.path, 'index.ts')).href);
    const runtime = createRequire(import.meta.url)(join(p.path, 'index.cjs'));
    expect(toolKeys(source)).toEqual(toolKeys(runtime));
  });
});
