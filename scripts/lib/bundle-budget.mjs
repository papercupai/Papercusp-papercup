/**
 * Pure evaluation of a built operator-vite dist against the client bundle budget.
 * Used by scripts/check-bundle-budget.mjs (which runs the real `vite build`) and
 * unit-tested against fixture dists (apps/operator/lib/bundle-budget-eager-closure.test.ts).
 *
 * The EAGER set is what executes before first paint: every /assets/ file that
 * index.html references (the entry <script>, every modulepreload, the stylesheets)
 * PLUS the static-import closure of those JS files. Vite usually modulepreloads the
 * whole closure, but a static `import ... from "./x.js"` that is not preloaded still
 * runs before first paint, so the closure is followed rather than trusting the
 * preload list (measured 2026-10-13: one unlisted eager file in both the shipped
 * and the canonical dist).
 *
 * Three checks, each aimed at a different way a heavy module becomes eager:
 *   1. total eager bytes stay under EAGER_BUDGET_BYTES (EI-13213's leak class);
 *   2. no single eager JS file exceeds MAX_EAGER_CHUNK_BYTES, which catches one
 *      large chunk (for example the 1.74 MB shared chunk) turning eager while the
 *      total still fits under the budget;
 *   3. each MUST_STAY_LAZY chunk is EMITTED and NOT eager. Requiring it to exist
 *      keeps the check from passing vacuously when a chunk is renamed or merged.
 *
 * Lazy chunk size is deliberately not budgeted: a large lazy feature chunk costs
 * nothing until that feature is used (perf audit 2026-10-12 P-010,
 * WI-6554700010009310).
 */

/** Headroom over the measured eager set (3.17 MB incl. 0.93 MB CSS on 2026-10-13). */
export const EAGER_BUDGET_BYTES = 4.5 * 1024 * 1024;

/** Largest single eager JS file allowed. The largest measured on 2026-10-13 was 0.35 MB. */
export const MAX_EAGER_CHUNK_BYTES = 768 * 1024;

/**
 * Heavy chunks that must never load before first paint. `pattern` matches the
 * emitted file name in dist/assets. Sizes are the 2026-10-13 measurement.
 */
export const MUST_STAY_LAZY = Object.freeze([
  Object.freeze({ label: 'Porcupine wake-word engine (3.38 MB)', pattern: /^porcupine-[\w-]+\.js$/ }),
  Object.freeze({ label: 'elk graph layout (1.37 MB)', pattern: /^elk\.bundled-[\w-]+\.js$/ }),
  Object.freeze({ label: 'UiwMdPane markdown editor (1.00 MB)', pattern: /^UiwMdPane-[\w-]+\.js$/ }),
]);

const SEED_RE = /(?:src|href)="\/assets\/([^"?#]+)"/g;
// A static import or re-export of a sibling chunk: `import"./x.js"`, `from"./x.js"`.
// A dynamic `import("./x.js")` has a `(` before the quote, so it never matches.
const STATIC_IMPORT_RE = /(?:\bimport|\bfrom)\s*["'`]\.\/([^"'`]+?\.js)["'`]/g;

/** File names (relative to dist/assets) that index.html references directly. */
export function indexHtmlSeeds(indexHtml) {
  return [...new Set([...indexHtml.matchAll(SEED_RE)].map((m) => m[1]))];
}

/**
 * The eager set: index.html seeds plus the static-import closure of the JS among
 * them. `readAsset(name)` returns the file's text, or null when it does not exist.
 */
export function eagerAssetSet(indexHtml, readAsset) {
  const eager = new Set();
  const stack = [...indexHtmlSeeds(indexHtml)];
  while (stack.length > 0) {
    const name = stack.pop();
    if (eager.has(name)) continue;
    eager.add(name);
    if (!name.endsWith('.js')) continue;
    const text = readAsset(name);
    if (text == null) continue;
    for (const m of text.matchAll(STATIC_IMPORT_RE)) {
      if (!eager.has(m[1])) stack.push(m[1]);
    }
  }
  return eager;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

/**
 * Evaluate a dist. `assets` lists every file in dist/assets; `sizeOf(name)` and
 * `readAsset(name)` return null for a missing file. Returns the measurements plus
 * a `problems` array (empty when the dist is within budget).
 */
export function evaluateBundleBudget({
  indexHtml,
  assets,
  sizeOf,
  readAsset,
  eagerBudgetBytes = EAGER_BUDGET_BYTES,
  maxEagerChunkBytes = MAX_EAGER_CHUNK_BYTES,
  mustStayLazy = MUST_STAY_LAZY,
}) {
  const eager = eagerAssetSet(indexHtml, readAsset);
  const seeds = new Set(indexHtmlSeeds(indexHtml));
  const problems = [];
  const missing = [];
  let eagerBytes = 0;
  let largestEagerJs = null;
  for (const name of eager) {
    const size = sizeOf(name);
    if (size == null) {
      missing.push(name);
      continue;
    }
    eagerBytes += size;
    if (name.endsWith('.js') && (largestEagerJs == null || size > largestEagerJs.size)) {
      largestEagerJs = { name, size };
    }
  }

  if (eagerBytes > eagerBudgetBytes) {
    problems.push(
      `eager bundle is ${mb(eagerBytes)} MB (index.html seeds + their static-import closure, ` +
        `${eager.size} files) — over the ${mb(eagerBudgetBytes)} MB budget. A heavy or server-only ` +
        `module became reachable EAGERLY from the client entry. Diagnose with the sourcemap-` +
        `attribution method in the fcp-server-libs-leak-into-eager-client-bundle insight doc.`,
    );
  }

  const oversized = [...eager]
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, size: sizeOf(name) }))
    .filter((a) => a.size != null && a.size > maxEagerChunkBytes)
    .sort((a, b) => b.size - a.size);
  for (const a of oversized) {
    problems.push(
      `eager JS chunk ${a.name} is ${mb(a.size)} MB — over the ${mb(maxEagerChunkBytes)} MB ` +
        `per-chunk cap. A large chunk now loads before first paint; move its importer behind a ` +
        `dynamic import().`,
    );
  }

  const lazyStatus = [];
  for (const rule of mustStayLazy) {
    const hits = assets.filter((name) => rule.pattern.test(name));
    if (hits.length === 0) {
      problems.push(
        `MUST_STAY_LAZY chunk "${rule.label}" (${rule.pattern}) was not emitted. It was renamed, ` +
          `merged into another chunk (possibly an eager one) or removed; confirm where its module ` +
          `went, then update MUST_STAY_LAZY in scripts/lib/bundle-budget.mjs.`,
      );
      lazyStatus.push({ label: rule.label, files: [], eager: [] });
      continue;
    }
    const eagerHits = hits.filter((name) => eager.has(name));
    for (const name of eagerHits) {
      problems.push(
        `MUST_STAY_LAZY chunk "${rule.label}" (${name}) is EAGER — it now loads before first ` +
          `paint${seeds.has(name) ? ' (referenced by index.html)' : ' (static-import closure of the entry)'}.`,
      );
    }
    lazyStatus.push({ label: rule.label, files: hits, eager: eagerHits });
  }

  return {
    eagerFiles: eager.size,
    eagerBytes,
    unlistedEager: [...eager].filter((name) => !seeds.has(name)),
    largestEagerJs,
    missing,
    lazyStatus,
    problems,
  };
}
