// EI-13210: the operator build used to emit a spurious warning for every
// standards-based `::highlight(...)` selector (the CSS Custom Highlight API,
// used by find-in-page.css's Ctrl/⌘+F overlay and by the diff/code-highlight
// styles) during CSS minification:
//
//   [lightningcss minify] 'highlight' is not recognized as a valid
//   pseudo-element. Did you mean ':highlight' (pseudo-class) or is this a
//   typo?
//
// Root cause: `build.minify: 'esbuild'` in vite.config.ts governs JS
// minification only. Vite's CSS minifier is a SEPARATE setting
// (`build.cssMinify`) whose default is `cssMinify ?? !!build.minify` —
// `!!'esbuild'` collapses to the boolean `true`, which Vite resolves to
// **lightningcss**, not esbuild. lightningcss (current latest, 1.32.0) does
// not recognize `::highlight()` and warns on every occurrence (harmless —
// the selector still round-trips correctly — but pure noise that can drown
// real warnings). Fix: pin `build.cssMinify: 'esbuild'` explicitly, which
// handles `::highlight()` cleanly.
//
// This test pins BOTH halves so a regression is caught either way:
//   1. the config literally sets cssMinify: 'esbuild' (so a future edit that
//      drops/rewords the line trips immediately, before anyone has to
//      rediscover the `!!minify` default-coercion gotcha), and
//   2. esbuild's own CSS transform genuinely handles the app's real
//      `::highlight()` selectors (find-in-page.css) with zero warnings, so an
//      esbuild upgrade that regresses this is caught too.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';
import viteConfig from './vite.config';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('operator-vite CSS minification does not warn on ::highlight() pseudo-elements', () => {
  it('vite.config.ts pins build.cssMinify to esbuild (not the lightningcss default)', async () => {
    const resolved = await (typeof viteConfig === 'function' ? viteConfig({ command: 'build', mode: 'production' }) : viteConfig);
    expect(resolved.build?.cssMinify).toBe('esbuild');
  });

  it('keeps stale optimized-dependency requests from blanking long-open embeds', async () => {
    const resolved = await (typeof viteConfig === 'function' ? viteConfig({ command: 'serve', mode: 'development' }) : viteConfig);
    expect(resolved.optimizeDeps?.ignoreOutdatedRequests).toBe(true);
  });

  it('esbuild minifies the real find-in-page.css ::highlight() selectors with zero warnings', async () => {
    const css = readFileSync(resolve(__dirname, '../operator/app/find-in-page.css'), 'utf-8');
    const { code, warnings } = await transform(css, { loader: 'css', minify: true });
    expect(warnings).toEqual([]);
    expect(code).toContain('::highlight(papercup-find)');
    expect(code).toContain('::highlight(papercup-find-active)');
  });

  it('genuinely malformed CSS still warns (sanity: esbuild is not silently lax)', async () => {
    // Not asserting a specific warning shape here — only that esbuild doesn't
    // treat literally anything as clean, i.e. our zero-warnings result above
    // is because ::highlight() is genuinely fine, not because warnings are
    // swallowed somewhere in this test's plumbing.
    const { warnings } = await transform('.valid { color: red }; @totally-bogus-at-rule-xyz {}', { loader: 'css' });
    expect(warnings.length).toBeGreaterThan(0);
  });
});
