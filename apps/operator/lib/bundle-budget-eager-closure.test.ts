/**
 * scripts/lib/bundle-budget.mjs — the operator-vite client bundle budget's pure evaluator
 * (perf audit 2026-10-12 P-010, WI-6554700010009310; EI-13213 for the original guard).
 *
 * The real guard (scripts/check-bundle-budget.mjs, `lint:bundle-budget`) runs `vite build`
 * and hands the emitted dist to this evaluator. These tests drive the evaluator with
 * in-memory fixture dists so each rule is proven to fire on exactly the shape it targets:
 * the static-import closure, the total eager budget, the per-chunk cap, and the named
 * must-stay-lazy chunks (including the "chunk no longer emitted" case, which keeps that
 * rule from passing vacuously after a rename).
 */
import { describe, it, expect } from 'vitest';
import {
  EAGER_BUDGET_BYTES,
  MAX_EAGER_CHUNK_BYTES,
  MUST_STAY_LAZY,
  eagerAssetSet,
  evaluateBundleBudget,
  indexHtmlSeeds,
} from '../../../scripts/lib/bundle-budget.mjs';

type Asset = { size: number; text?: string };

const KB = 1024;

function html(js: string[], css: string[] = []): string {
  const [entry, ...preloads] = js;
  return [
    '<!doctype html><html><head>',
    entry ? `<script type="module" crossorigin src="/assets/${entry}"></script>` : '',
    ...preloads.map((f) => `<link rel="modulepreload" crossorigin href="/assets/${f}">`),
    ...css.map((f) => `<link rel="stylesheet" crossorigin href="/assets/${f}">`),
    '</head><body><div id="root"></div></body></html>',
  ].join('\n');
}

/** A dist whose three must-stay-lazy chunks exist and are only dynamically imported. */
function baseAssets(): Record<string, Asset> {
  return {
    'index-aaaa1111.js': {
      size: 300 * KB,
      text:
        'import{a as b}from"./vendor-bbbb2222.js";import"./side-effect-cccc3333.js";' +
        'const w=()=>import("./porcupine-dddd4444.js");' +
        'const e=()=>__vitePreload(()=>import("./elk.bundled-eeee5555.js"),[]);' +
        'const m=()=>import("./UiwMdPane-ffff6666.js");',
    },
    'vendor-bbbb2222.js': { size: 400 * KB, text: 'export const a=1;' },
    'side-effect-cccc3333.js': { size: 10 * KB, text: 'console.log(1);' },
    'porcupine-dddd4444.js': { size: 3380 * KB, text: 'export default 1;' },
    'elk.bundled-eeee5555.js': { size: 1370 * KB, text: 'export default 1;' },
    'UiwMdPane-ffff6666.js': { size: 1000 * KB, text: 'export default 1;' },
    'index-1234abcd.css': { size: 200 * KB },
  };
}

function evaluate(
  assets: Record<string, Asset>,
  indexHtml: string,
  overrides: Partial<Parameters<typeof evaluateBundleBudget>[0]> = {},
) {
  return evaluateBundleBudget({
    indexHtml,
    assets: Object.keys(assets),
    sizeOf: (name: string) => assets[name]?.size ?? null,
    readAsset: (name: string) => (name in assets ? assets[name].text ?? '' : null),
    ...overrides,
  });
}

const BASE_HTML = html(['index-aaaa1111.js', 'vendor-bbbb2222.js'], ['index-1234abcd.css']);

describe('bundle-budget: eager set', () => {
  it('reads every /assets/ reference in index.html, de-duplicated', () => {
    const page = `${BASE_HTML}\n<link rel="modulepreload" href="/assets/vendor-bbbb2222.js">`;
    expect(indexHtmlSeeds(page).sort()).toEqual(
      ['index-1234abcd.css', 'index-aaaa1111.js', 'vendor-bbbb2222.js'].sort(),
    );
  });

  it('follows static imports that index.html does not preload, and never dynamic import()', () => {
    const assets = baseAssets();
    const eager = eagerAssetSet(BASE_HTML, (n: string) => (n in assets ? assets[n].text ?? '' : null));
    expect([...eager].sort()).toEqual(
      ['index-1234abcd.css', 'index-aaaa1111.js', 'side-effect-cccc3333.js', 'vendor-bbbb2222.js'].sort(),
    );
  });

  it('follows a static re-export (export{..}from) transitively', () => {
    const assets = baseAssets();
    assets['vendor-bbbb2222.js'].text = 'export{x}from"./deep-9999aaaa.js";';
    assets['deep-9999aaaa.js'] = { size: 5 * KB, text: '' };
    const r = evaluate(assets, BASE_HTML);
    expect(r.unlistedEager.sort()).toEqual(['deep-9999aaaa.js', 'side-effect-cccc3333.js']);
  });
});

describe('bundle-budget: evaluation', () => {
  it('passes a dist whose heavy chunks are lazy and whose eager set fits', () => {
    const r = evaluate(baseAssets(), BASE_HTML);
    expect(r.problems).toEqual([]);
    expect(r.eagerFiles).toBe(4);
    expect(r.eagerBytes).toBe((300 + 400 + 10 + 200) * KB);
    expect(r.largestEagerJs).toEqual({ name: 'vendor-bbbb2222.js', size: 400 * KB });
    expect(r.lazyStatus.map((s: { files: string[]; eager: string[] }) => [s.files.length, s.eager.length])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
  });

  it('fails when the total eager set exceeds the budget', () => {
    const assets = baseAssets();
    // Spread across chunks under the per-chunk cap so only the TOTAL rule fires.
    const many = Array.from({ length: 8 }, (_, i) => `part${i}-0000000${i}.js`);
    for (const name of many) assets[name] = { size: 700 * KB, text: '' };
    assets['index-aaaa1111.js'].text += many.map((n) => `import"./${n}";`).join('');
    const r = evaluate(assets, BASE_HTML);
    expect(r.eagerBytes).toBeGreaterThan(EAGER_BUDGET_BYTES);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/over the 4\.50 MB budget/);
  });

  it('fails on one oversized eager chunk even while the total fits', () => {
    const assets = baseAssets();
    assets['vendor-bbbb2222.js'].size = 1740 * KB; // the 1.74 MB shared chunk turning eager
    const r = evaluate(assets, BASE_HTML);
    expect(r.eagerBytes).toBeLessThan(EAGER_BUDGET_BYTES);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/eager JS chunk vendor-bbbb2222\.js is 1\.70 MB .*per-chunk cap/);
  });

  it('does not apply the per-chunk cap to stylesheets', () => {
    const assets = baseAssets();
    assets['index-1234abcd.css'].size = MAX_EAGER_CHUNK_BYTES * 2;
    expect(evaluate(assets, BASE_HTML).problems).toEqual([]);
  });

  it('fails when a must-stay-lazy chunk is pulled in by a static import', () => {
    const assets = baseAssets();
    // UiwMdPane (1.0 MB) is under the total budget's headroom: only the named rule sees it.
    assets['vendor-bbbb2222.js'].text = 'import"./UiwMdPane-ffff6666.js";';
    const r = evaluate(assets, BASE_HTML, { maxEagerChunkBytes: 2 * 1024 * KB });
    expect(r.eagerBytes).toBeLessThan(EAGER_BUDGET_BYTES);
    expect(r.problems).toEqual([
      expect.stringMatching(/UiwMdPane markdown editor .*UiwMdPane-ffff6666\.js\) is EAGER .*static-import closure/),
    ]);
  });

  it('fails when index.html modulepreloads a must-stay-lazy chunk', () => {
    const page = html(['index-aaaa1111.js', 'vendor-bbbb2222.js', 'elk.bundled-eeee5555.js']);
    const r = evaluate(baseAssets(), page, { maxEagerChunkBytes: 2 * 1024 * KB });
    expect(r.problems).toEqual([
      expect.stringMatching(/elk graph layout .*is EAGER .*referenced by index\.html/),
    ]);
  });

  it('fails, rather than passing vacuously, when a must-stay-lazy chunk is no longer emitted', () => {
    const assets = baseAssets();
    delete assets['porcupine-dddd4444.js'];
    const r = evaluate(assets, BASE_HTML);
    expect(r.problems).toEqual([expect.stringMatching(/Porcupine wake-word engine .*was not emitted/)]);
  });

  it('names exactly the three heavy chunks from the 2026-10-12 audit', () => {
    expect(MUST_STAY_LAZY.map((r: { pattern: RegExp }) => r.pattern.source)).toEqual([
      '^porcupine-[\\w-]+\\.js$',
      '^elk\\.bundled-[\\w-]+\\.js$',
      '^UiwMdPane-[\\w-]+\\.js$',
    ]);
    expect(MUST_STAY_LAZY.some((r: { pattern: RegExp }) => r.pattern.test('elk-layout-f28972ed.js'))).toBe(false);
  });
});
