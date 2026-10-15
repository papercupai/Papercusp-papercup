/**
 * Guards the e2e egress fixture (egress-monitor-origin-axis-2026-08-02 P-005).
 *
 * WHAT THIS PROTECTS. The fixture in `apps/operator/e2e/_egress.ts` only audits a
 * spec that imports `test` FROM IT. A spec importing `test` from
 * '@playwright/test' directly still compiles, still runs, still passes — and is
 * silently exempt from the egress audit. That is the single failure mode of the
 * whole P-005 design, and it is invisible: nothing goes red, the suite just
 * quietly stops covering one more file every time someone adds a spec by copying
 * an old one.
 *
 * So the wiring is asserted MECHANICALLY here rather than left to convention.
 * This is the enforcement tier the fixture's own docstring cannot supply: a
 * comment asking people to import from the right place is prose exhortation; this
 * is a gate.
 *
 * IT MUST ALSO REFUSE TO PASS VACUOUSLY. A guard that globs zero spec files
 * reports exactly what a fully-compliant tree reports — success. Since this one's
 * whole job is to notice an ABSENCE, that shape would make it permanently green
 * the moment the path drifted. It therefore asserts a non-trivial spec count
 * first, and the detector itself is negative-controlled against synthetic sources
 * so we know it can fail at all.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const E2E_DIR = join(REPO_ROOT, 'apps', 'operator', 'e2e');
const FIXTURE = join(E2E_DIR, '_egress.ts');

/**
 * Matches a named-import statement and captures its symbol list + module specifier.
 *
 * BOTH quote styles are accepted deliberately. A single-quote-only pattern reads a
 * correct `from "./_egress"` as "no `test` import at all", which breaks this file in
 * two opposite directions at once: the wiring test reports that spec as an offender
 * it is not, and `importedSymbols` silently drops every symbol it imports, so the
 * re-export test stops covering it. The second failure is invisible — it makes the
 * guard quieter, not louder — which is the exact vacuous-pass shape this file's
 * docstring exists to refuse. Keep the quote class here if you touch this.
 */
const namedImports = () => /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** The module a source file pulls its `test` binding from, or null if it has none. */
export function testImportSpecifier(src: string): string | null {
  for (const m of src.matchAll(namedImports())) {
    const names = m[1].split(',').map((s) => s.trim());
    if (names.some((n) => n === 'test' || n.startsWith('test as'))) return m[2];
  }
  return null;
}

/** Every symbol a source file imports from `specifier`. */
export function importedSymbols(src: string, specifier: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(namedImports())) {
    if (m[2] !== specifier) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}

function specFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort();
}

describe('e2e egress fixture wiring (P-005)', () => {
  it('finds a non-trivial number of specs — a zero-file glob is a broken guard, not a pass', () => {
    // The suite had 46 specs when P-005 landed. If this ever reads 0 the path
    // drifted and every assertion below became a tautology.
    expect(specFiles().length).toBeGreaterThan(30);
  });

  it('EVERY spec takes `test` from the egress fixture, never from @playwright/test', () => {
    // Report the specifier each offender ACTUALLY binds `test` from. Naming a
    // presumed culprit ('@playwright/test') instead sends the reader grepping for
    // a string that need not be in the tree: the predicate is `!== './_egress'`,
    // which also catches an unparsed import and a third-party fixture. A message
    // that describes a different set than its predicate computes is a false lead
    // wearing a diagnosis's clothes.
    const offenders = specFiles()
      .map((file) => ({
        file,
        from: testImportSpecifier(readFileSync(join(E2E_DIR, file), 'utf8')),
      }))
      .filter((o) => o.from !== './_egress');

    expect(
      offenders.map((o) => o.file),
      offenders.length === 0
        ? ''
        : [
            `${offenders.length} e2e spec(s) do not take \`test\` from './_egress'.`,
            '',
            'Such a spec is SILENTLY EXEMPT from the network-egress audit — it runs,',
            'it passes, and it covers nothing. Change the import to:',
            '',
            "    import { test, expect, ... } from './_egress';",
            '',
            '(`_egress.ts` re-exports every symbol @playwright/test provides to the',
            'specs, so this is a pure module-specifier swap.)',
            '',
            ...offenders.map(
              (o) =>
                `  - ${o.file} — binds \`test\` from ${
                  o.from === null
                    ? 'NO parseable named import (check the import syntax itself, not just the module path)'
                    : `'${o.from}'`
                }`,
            ),
          ].join('\n'),
    ).toEqual([]);
  });

  it('re-exports every symbol the specs actually import from it', () => {
    // Derives the requirement from the real specs rather than restating a list
    // that can drift: adding `type Frame` to a spec import fails HERE, loudly,
    // instead of at whatever build runs next.
    const fixtureSrc = readFileSync(FIXTURE, 'utf8');
    const wanted = new Set<string>();
    for (const f of specFiles()) {
      for (const s of importedSymbols(readFileSync(join(E2E_DIR, f), 'utf8'), './_egress')) {
        wanted.add(s);
      }
    }
    expect(wanted.size).toBeGreaterThan(1);

    const missing = [...wanted].filter((name) => {
      const reExported = new RegExp(`\\b${name}\\b`).test(
        (fixtureSrc.match(/export\s*\{[^}]*\}\s*from\s*'@playwright\/test'/s) ?? [''])[0],
      );
      // `async` must be accepted: `export async function waitVisible…` is a
      // real export the specs compile against (WI-6554700010009816).
      const declared = new RegExp(
        `export\\s+(?:async\\s+)?(const|let|function|class|type|interface|enum)\\s+${name}\\b`,
      ).test(
        fixtureSrc,
      );
      return !reExported && !declared;
    });

    expect(
      missing,
      `_egress.ts must re-export these, or the specs importing them will not compile: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('asserts the foreignOrigin axis and treats `unknown` as a failure', () => {
    // The two rules that make the fixture worth having. `unknown` is what a dead
    // detector reports, so a fixture that let it pass would be the vacuous-pass
    // bug wearing a fixture's clothes.
    const src = readFileSync(FIXTURE, 'utf8');
    expect(src).toMatch(/foreignOrigin/);
    expect(src).toMatch(/not\.toBe\('unknown'\)/);
    // And it must NOT assert the ipc-escape axis: HTTP to /api/* is the
    // sanctioned transport in a browser, so asserting it fails every spec.
    expect(src).toMatch(/EGRESS_CONTROL_PARAM/);
  });

  describe('the detector itself can fail (negative control)', () => {
    it('flags a direct @playwright/test import', () => {
      expect(testImportSpecifier("import { test, expect } from '@playwright/test';")).toBe(
        '@playwright/test',
      );
    });

    it('accepts the fixture import in either symbol order', () => {
      expect(testImportSpecifier("import { expect, test } from './_egress';")).toBe('./_egress');
      expect(
        testImportSpecifier("import { test, expect, type Page } from './_egress';"),
      ).toBe('./_egress');
    });

    it('returns null for a file that binds no `test` (a helper, not a spec)', () => {
      expect(testImportSpecifier("import { expect, type Page } from '@playwright/test';")).toBeNull();
    });

    it('does not mistake a symbol merely CONTAINING "test" for the test binding', () => {
      expect(testImportSpecifier("import { testInfo, latest } from '@playwright/test';")).toBeNull();
    });

    it('parses imported symbols, stripping `type` and aliases', () => {
      const src = "import { test, expect, type Page, type Route as R } from './_egress';";
      expect(importedSymbols(src, './_egress').sort()).toEqual([
        'Page',
        'Route',
        'expect',
        'test',
      ]);
    });

    // Both parsers were single-quote-only, which made a correctly-wired
    // `from "./_egress"` spec read as un-wired. That broke the guard in two
    // directions at once, so both are pinned here (WI-1215845).
    it('reads a DOUBLE-quoted fixture import as wired, not as an offender', () => {
      const plain = 'import { test, expect } from "./_egress";';
      const withTypes = 'import { test, expect, assertMounted, type Page } from "./_egress";';
      expect(testImportSpecifier(plain)).toBe('./_egress');
      expect(testImportSpecifier(withTypes)).toBe('./_egress');
    });

    it('still flags a DOUBLE-quoted direct @playwright/test import', () => {
      const direct = 'import { test, expect } from "@playwright/test";';
      expect(testImportSpecifier(direct)).toBe('@playwright/test');
    });

    it('collects symbols from a DOUBLE-quoted fixture import', () => {
      // The invisible half: when this returned [], the re-export test stopped
      // covering the spec entirely instead of going red.
      const src = 'import { test, assertMounted, type Page } from "./_egress";';
      expect(importedSymbols(src, './_egress').sort()).toEqual(['Page', 'assertMounted', 'test']);
    });
  });
});
