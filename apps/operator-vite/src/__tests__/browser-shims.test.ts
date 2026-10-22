// Every browser shim must export every VALUE its importers import — or the SPA
// build dies at LINK time, and a link failure is the DESTRUCTIVE kind (EI-10539):
// rolldown reports MISSING_EXPORT only after vite's `prepareOutDir` (renderStart,
// order:'pre') has already emptied outDir, so the build does not merely fail — it
// takes the bundle that was serving with it, leaving a dead desktop behind a 503.
//
// Measured on vite 8.0.16 (previous bundle in dist/, one-shot build):
//   unresolvable import  → dist SURVIVES (dies before the empty)
//   syntax error         → dist SURVIVES (dies before the empty)
//   MISSING NAMED EXPORT → dist DESTROYED (dies after the empty)   ← this class
//
// It has now happened twice on the same day (2026-07-12): `agent-tools/coordination/
// log.ts` started importing `PgCoordLog` from the aliased event-log specifier, the
// shim exported only `DEFAULT_COORD_WORKSPACE`, and the next build ate dist/. The
// unit suite stayed green throughout, because a shim is only ever LINKED by a real
// `vite build` — nothing type-checks an alias. This test is that missing detector,
// generalized to EVERY shim: it reads what the importers actually ask for, and
// fails here in milliseconds instead of in a build that destroys the bundle.
//
// (bin/vite-build-singleflight now stages builds so a red one can no longer eat
// dist/ — but "the failure is survivable" is not "the failure is caught".)
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
// The parse/match helpers live in a plain module (browser-shim-aliases.ts) rather
// than being exported from this test file: a `.test.ts` imported by another test
// collects twice and can register 0 tests under a shared-fork lane (gate red
// 761d0a85ac, WI-212675) — guarded tree-wide by no-test-file-imports.test.ts.
import { aliasMatches, parseShimAliases, valueImports } from './browser-shim-aliases';
import nodeModule, { builtinModules, createRequire, isBuiltin } from '../shims/node-module-browser';

const REPO_ROOT = resolve(__dirname, '../../../..');
const VITE_CONFIG = resolve(__dirname, '../../vite.config.ts');
const SHIMS_DIR = resolve(__dirname, '../shims');

/** Source trees the SPA bundle can reach (operator-core is aliased straight in). */
const SEARCH_ROOTS = [
  join(REPO_ROOT, 'packages/operator-core/lib'),
  join(REPO_ROOT, 'apps/operator'),
  join(REPO_ROOT, 'apps/operator-vite/src'),
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist.next', '.vite', '__tests__', 'e2e', '_retired']);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // tree absent in this checkout — nothing to scan
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(abs);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield abs;
    }
  }
}

describe('browser shims export what the SPA links against (EI-10539)', () => {
  const aliases = parseShimAliases(readFileSync(VITE_CONFIG, 'utf8'));

  it('finds the shim aliases in vite.config — a rename must not silently disarm this guard', () => {
    expect(aliases.length).toBeGreaterThanOrEqual(6);
    const shims = new Set(aliases.map((a) => a.shim));
    expect(shims.has('coordination-event-log-browser.ts')).toBe(true);
    // Every shim file on disk should be reachable through some alias — an orphan
    // shim means an alias was dropped and the real (server) module is being bundled.
    for (const file of readdirSync(SHIMS_DIR).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      expect(shims, `shim ${file} is not aliased by vite.config`).toContain(file);
    }
  });

  it.each(
    // Pre-scan so each shim gets its own named test case.
    (() => {
      const src = readFileSync(VITE_CONFIG, 'utf8');
      const parsed = parseShimAliases(src);
      const files = [...SEARCH_ROOTS].flatMap((r) => [...walk(r)]);
      return parsed.map((a) => {
        const wanted = new Map<string, string>(); // binding → importing file
        for (const file of files) {
          const source = readFileSync(file, 'utf8');
          for (const name of valueImports(source, (s) => aliasMatches(a.find, s))) {
            if (!wanted.has(name)) wanted.set(name, file.slice(REPO_ROOT.length + 1));
          }
        }
        return { shim: a.shim, wanted };
      });
    })(),
  )('$shim exports every value its importers import', async ({ shim, wanted }) => {
    if (wanted.size === 0) return; // nothing imports named bindings through this alias
    const mod = (await import(/* @vite-ignore */ join(SHIMS_DIR, shim))) as Record<string, unknown>;
    const missing = [...wanted.entries()]
      .filter(([name]) => !(name in mod))
      .map(([name, file]) => `${name}  ← imported by ${file}`);
    expect(
      missing,
      `src/shims/${shim} is missing exports the SPA bundle links against — a real ` +
        `\`vite build\` would fail with MISSING_EXPORT *after* emptying dist/, destroying ` +
        `the running bundle (EI-10539):\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

// Literal imports also expose this dependency to related-test selection; the
// dynamic scan above protects every shim's exports but cannot supply that edge.
describe('node:module browser API', () => {
  it('provides an immutable iterable for module-scope builtin lookups', () => {
    expect(new Set(builtinModules)).toEqual(new Set());
    expect(Object.isFrozen(builtinModules)).toBe(true);
    expect(nodeModule.builtinModules).toBe(builtinModules);
  });

  it('allows require construction and cache inspection but rejects server-only calls', () => {
    const require = createRequire(import.meta.url);
    expect(Object.keys(require.cache)).toEqual([]);
    expect(Object.keys(require.extensions)).toEqual([]);
    expect(require.main).toBeUndefined();
    expect(() => require('node:fs')).toThrow('unavailable in the browser bundle');
    expect(() => require.resolve('node:fs')).toThrow('unavailable in the browser bundle');
    expect(() => isBuiltin('node:fs')).toThrow('unavailable in the browser bundle');
    expect(nodeModule.createRequire).toBe(createRequire);
    expect(nodeModule.isBuiltin).toBe(isBuiltin);
  });
});

describe('alias matching + import parsing', () => {
  it('matches string aliases by prefix and regex aliases by test', () => {
    expect(aliasMatches("'@papercusp/coordination/event-log'", '@papercusp/coordination/event-log')).toBe(true);
    expect(aliasMatches("'@papercusp/coordination/event-log'", '@papercusp/coordination/other')).toBe(false);
    expect(aliasMatches('/^posthog-node(?:\\/.*)?$/', 'posthog-node')).toBe(true);
    expect(aliasMatches('/^posthog-node(?:\\/.*)?$/', 'posthog-node/lib/x')).toBe(true);
    expect(aliasMatches('/^posthog-node(?:\\/.*)?$/', 'posthog-js')).toBe(false);
  });

  it('collects value imports and ignores type-only ones', () => {
    const src = [
      `import { PgCoordLog, DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';`,
      `import type { CoordEventLog } from '@papercusp/coordination/event-log';`,
      `import { type OnlyAType, RealValue as Aliased } from '@papercusp/coordination/event-log';`,
    ].join('\n');
    expect(valueImports(src, (s) => s === '@papercusp/coordination/event-log')).toEqual([
      'PgCoordLog',
      'DEFAULT_COORD_WORKSPACE',
      'RealValue',
    ]);
  });

  it('parses the shim aliases out of the real vite.config', () => {
    const aliases = parseShimAliases(readFileSync(VITE_CONFIG, 'utf8'));
    const found = aliases.find((a) => a.shim === 'coordination-event-log-browser.ts');
    expect(found?.find).toBe(`'@papercusp/coordination/event-log'`);
  });
});
