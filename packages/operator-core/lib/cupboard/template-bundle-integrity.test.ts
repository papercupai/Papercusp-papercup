/**
 * template-bundle-integrity — the guard for WI-37777 (plan
 * template-supply-chain-repair-2026-08-10, P-002).
 *
 * WHAT WENT WRONG, so the next reader knows what this is defending:
 * `templates/*​/checks/*.test.ts` are PORTABLE content — `overlayTemplateFiles`
 * copies a template's whole `<ref>/` dir into a user's newly materialized app,
 * where those checks are then meant to run. They are deliberately NOT owned by
 * any vitest config in this repo (`testing:run` answers TEST_FILE_ROUTE_ERROR
 * for them), so nothing here ever resolves their imports.
 *
 * `@papercusp/template-kit` was dropped from the tree in the papercup->papercusp
 * migration (it survives only on origin/legacy-papercup-main-2026-07-07) and was
 * never in the root `workspaces` list. The three app-root templates kept importing
 * it. For ~5 weeks every user who materialized a whole-app template got a
 * composition-integrity check that could not execute — and nothing was red,
 * because nothing was looking.
 *
 * This file looks. It runs in operator-core (which IS test-discovered) and makes
 * assertions ABOUT the templates tree, so it cannot be silenced by the same
 * exclusion that hid the original break.
 *
 * TWO INVARIANTS:
 *  1. Every non-node import in a template check resolves to something the RELEASE
 *     BUNDLE puts inside the user's app — i.e. an `@papercusp/*` import must have
 *     a vendored package dir inside that same template, since only `<ref>/` is
 *     overlaid. A copy at libs/generic/ does NOT satisfy this: it reaches the user
 *     only via source.tar.zst, and ONE of the two macOS build paths ships no such
 *     archive by default — `build-mac-cross.sh` defaults PAPERCUSP_STAGE_SOURCE to
 *     0, while `mac-vm-build.sh` and `stage-source-tree.sh` both default it to 1.
 *     (This sentence previously read "which macOS builds do not ship", a claim plan
 *     decision D-003 retracted and D-005 re-measured per-path. The vendoring
 *     conclusion is unchanged: the `<ref>/`-only overlay above is the load-bearing
 *     reason, and it holds on every platform.)
 *  2. Each vendored copy is byte-identical to its canonical libs/generic source,
 *     IN BOTH DIRECTIONS — a file present in canonical but missing from the vendored
 *     copy is drift too, and the one this guard used to be blind to (see
 *     findVendorDrift). Vendoring buys platform-independence at the cost of
 *     duplication; this is the price paid so the duplication cannot drift silently
 *     (plan D-001). The one derived exception is the root package.json: it must equal
 *     vendoredManifestOf(canonical), the canonical manifest minus devDependencies that
 *     serve only the dev harness a vendored copy omits (scripts/lib/vendored-manifest.mjs,
 *     shared with the writer scripts/sync-template-kit-vendored.mjs).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listLocalTemplates, readLocalGuide } from './template-store';
import { isVendorDevOnly, vendoredManifestOf } from '../../../../scripts/lib/vendored-manifest.mjs';

/** Repo root: walk up from this file until the root package.json (the one with `workspaces`). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return dir;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('template-bundle-integrity: could not locate the monorepo root');
}

const ROOT = repoRoot();
const TEMPLATES_DIR = join(ROOT, 'templates');

/**
 * Bare npm packages a portable check may import without vendoring: the app is
 * expected to declare these itself and they ARE on the public registry. Anything
 * else bare must be vendored (see invariant 1).
 */
const PUBLIC_DEVDEPS = new Set(['vitest', 'yaml']);

function listTemplateRefs(): string[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR)
    .filter((e) => statSync(join(TEMPLATES_DIR, e)).isDirectory())
    .sort();
}

function listExecutableCheckFiles(ref: string): string[] {
  const dir = join(TEMPLATES_DIR, ref, 'checks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(dir, f))
    .sort();
}

/**
 * Every non-relative, non-`node:` import specifier in a TS source.
 *
 * FOUR shapes, because a module can enter a file four ways and missing any one of
 * them fails in the SILENT direction — an unvendored import reported as clean:
 *
 *   1. `from "<spec>"`      — static named/default, INCLUDING the multiline form
 *      (`import {\n  A,\n  B,\n} from "pkg";`). That shape is exactly what hid the
 *      template-kit import from a hand grep during the audit that produced this
 *      file: a single-line `grep "^import .*@papercusp"` reported the checks as
 *      import-clean while three of them imported the kit.
 *   2. `import "<spec>"`    — SIDE-EFFECT import, which has no `from` at all and so
 *      was invisible to the original `from`-only matcher.
 *   3. `import("<spec>")`   — dynamic import with a literal specifier.
 *   4. `require("<spec>")`  — CJS.
 *
 * A dynamic import whose argument is an EXPRESSION rather than a string literal
 * (`await import(pathToFileURL(p).href)`, as in the ops-pots seam check) is
 * deliberately not matched: it resolves at runtime against a path inside the user's
 * app, so it is not a package dependency this guard can or should adjudicate.
 */
export function externalImportsOf(source: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
      out.add(spec);
    }
  }
  return [...out].sort();
}

/**
 * `@papercusp/template-kit` -> `template-kit` (the dir name a vendored copy uses).
 *
 * Takes the PACKAGE NAME only, so a subpath specifier resolves to the same vendored
 * dir as its root: `@papercusp/template-kit/catalog` -> `template-kit`, not
 * `template-kit/catalog` (which named no directory and so raised a false violation
 * against a package that WAS correctly vendored).
 */
function vendorDirName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? (parts[1] ?? spec) : parts[0];
}

/**
 * Every file under `dir`, as paths relative to `dir`.
 *
 * Skips `node_modules` and dot-dirs. This mattered the moment the drift check below
 * became two-directional: a VENDORED copy has no node_modules, so the one-way walk
 * never met one, but a CANONICAL libs/generic package usually does — walking it
 * would compare thousands of installed files and time the guard out.
 */
function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/**
 * Files that legitimately exist ONLY in the canonical package — the vendored copy
 * ships runtime code and its manifest, not the dev harness. Anything NOT matched
 * here must appear in both copies (see findVendorDrift's second direction).
 *
 * The ONE definition lives in scripts/lib/vendored-manifest.mjs, shared with the
 * writer (scripts/sync-template-kit-vendored.mjs) so the two cannot drift apart.
 * Re-exported here for callers of this file's pure functions.
 */
export { isVendorDevOnly };

/**
 * What a vendored file must contain given its canonical text: a byte copy, except
 * the root package.json, which must equal vendoredManifestOf(canonical), the
 * canonical manifest minus devDependencies that serve only the omitted dev harness.
 */
function expectedVendoredText(rel: string, canonicalText: string): string {
  return rel === 'package.json' ? vendoredManifestOf(canonicalText) : canonicalText;
}

/**
 * Invariant 1, as a pure function of a templates root so it can be exercised
 * against a FIXTURE tree. The falsifiability proof for this guard must never
 * mutate the shared checkout: git-sync commits the whole tree every few minutes,
 * so a probe that breaks a real file can be committed mid-run even when nothing
 * goes wrong (CLAUDE.md, "Proving a guard is falsifiable").
 */
export function findUnvendoredImports(templatesDir: string): string[] {
  const violations: string[] = [];
  if (!existsSync(templatesDir)) return violations;
  for (const ref of readdirSync(templatesDir).sort()) {
    if (!statSync(join(templatesDir, ref)).isDirectory()) continue;
    const checksDir = join(templatesDir, ref, 'checks');
    if (!existsSync(checksDir)) continue;
    for (const f of readdirSync(checksDir)
      .filter((x) => x.endsWith('.ts'))
      .sort()) {
      const file = join(checksDir, f);
      for (const spec of externalImportsOf(readFileSync(file, 'utf8'))) {
        if (PUBLIC_DEVDEPS.has(spec)) continue;
        const dir = vendorDirName(spec);
        if (existsSync(join(templatesDir, ref, dir, 'package.json'))) continue;
        violations.push(
          `templates/${ref}/checks/${f} imports "${spec}" but templates/${ref}/${dir}/package.json does not ` +
            `exist — only <ref>/ is overlaid into a materialized app, so this import cannot resolve for a user`,
        );
      }
    }
  }
  return violations;
}

/** Invariant 2, likewise pure so a fixture can prove it fires. */
export function findVendorDrift(templatesDir: string, libsGenericDir: string): string[] {
  const drift: string[] = [];
  if (!existsSync(templatesDir)) return drift;
  for (const ref of readdirSync(templatesDir).sort()) {
    const templateDir = join(templatesDir, ref);
    if (!statSync(templateDir).isDirectory()) continue;
    for (const entry of readdirSync(templateDir).sort()) {
      const vendored = join(templateDir, entry);
      if (!statSync(vendored).isDirectory()) continue;
      if (!existsSync(join(vendored, 'package.json'))) continue;
      const canonical = join(libsGenericDir, entry);
      if (!existsSync(canonical)) {
        drift.push(`templates/${ref}/${entry} is vendored but has no canonical source at libs/generic/${entry}`);
        continue;
      }
      // Direction 1: everything IN the vendored copy matches canonical.
      for (const rel of filesUnder(vendored)) {
        const b = join(canonical, rel);
        if (!existsSync(b)) {
          drift.push(`templates/${ref}/${entry}/${rel} has no counterpart in libs/generic/${entry}`);
          continue;
        }
        if (readFileSync(join(vendored, rel), 'utf8') !== expectedVendoredText(rel, readFileSync(b, 'utf8'))) {
          drift.push(
            `templates/${ref}/${entry}/${rel} differs from libs/generic/${entry}/${rel}` +
              (rel === 'package.json'
                ? ' (a vendored manifest must equal vendoredManifestOf(canonical), scripts/lib/vendored-manifest.mjs)'
                : ''),
          );
        }
      }
      // Direction 2: everything canonical ships (bar the dev harness) is PRESENT in
      // the vendored copy. Without this the guard is blind to the one drift that
      // actually breaks a user: canonical gains src/new-helper.ts, index.ts is
      // correctly re-copied so direction 1 stays silent, and the helper it imports
      // was never vendored — so the materialized app fails to resolve while this
      // guard reports green.
      for (const rel of filesUnder(canonical)) {
        if (isVendorDevOnly(rel)) continue;
        if (!existsSync(join(vendored, rel))) {
          drift.push(
            `libs/generic/${entry}/${rel} is missing from the vendored copy at templates/${ref}/${entry}/ — ` +
              `only <ref>/ is overlaid into a materialized app, so a user cannot resolve it`,
          );
        }
      }
    }
  }
  return drift;
}

describe('template bundle integrity — a materialized app can run the checks it ships with', () => {
  it('the templates dir is present (otherwise every assertion below is vacuous)', () => {
    expect(existsSync(TEMPLATES_DIR), `no templates dir at ${TEMPLATES_DIR}`).toBe(true);
    expect(listTemplateRefs().length).toBeGreaterThan(0);
  });

  it('the source store exposes all five official mobile templates with complete metadata and guides', () => {
    const byRef = new Map(
      listLocalTemplates([{ dir: TEMPLATES_DIR, layer: 'bundled' }]).map((template) => [
        template.ref,
        template,
      ]),
    );
    const expected = [
      ['papercusp-mobile-base', 'Papercusp Official: Mobile Base', 'aspect', 'shell'],
      ['papercusp-android-shell', 'Papercusp Official: Android Shell', 'aspect', 'shell'],
      ['papercusp-android-app', 'Papercusp Official: Android App', 'app', 'app'],
      ['papercusp-iphone-shell', 'Papercusp Official: iPhone Shell', 'aspect', 'shell'],
      ['papercusp-iphone-app', 'Papercusp Official: iPhone App', 'app', 'app'],
    ] as const;

    for (const [ref, title, scope, category] of expected) {
      const template = byRef.get(ref);
      expect(template, `${ref} should be returned by the templates:list data layer`).toMatchObject({
        ref,
        id: ref,
        title,
        scope,
        category,
        version: '0.1.0',
        source: 'first-party',
      });

      const guide = readLocalGuide(template!);
      expect('error' in guide, `${ref} should be returned by the templates:get-guide data layer`).toBe(false);
      if (!('error' in guide)) {
        expect(guide.branch).toBe('local');
        expect(guide.guide).toContain(`# ${ref} — composition GUIDE`);
        expect(guide.manifest).toContain(`id: ${ref}`);
        expect(guide.fetchedFiles).toEqual(expect.arrayContaining(['GUIDE.md', 'template.yaml']));
      }
    }
  });

  it('every executable check has at least one external import (proves the extractor is not silently matching nothing)', () => {
    // Falsifier for the extractor itself. `template.yaml` runs `*.test.ts` files;
    // sibling `checks/*.ts` files may be pure support modules whose only imports
    // are deliberately ignored `node:*` built-ins. The real invariant below still
    // scans every TypeScript file, so an unvendored import in a support module is
    // not hidden by this executable-check inventory.
    const checks = listTemplateRefs().flatMap(listExecutableCheckFiles);
    expect(checks.length, 'no template check files found at all').toBeGreaterThan(0);
    const withImports = checks.filter((f) => externalImportsOf(readFileSync(f, 'utf8')).length > 0);
    expect(withImports.length).toBe(checks.length);
  });

  it('extracts a MULTILINE named import (the shape that hid the original break)', () => {
    const src = 'import {\n  COMPONENT_CATALOG,\n  composeTemplates,\n} from "@papercusp/template-kit";\n';
    expect(externalImportsOf(src)).toEqual(['@papercusp/template-kit']);
  });

  it('extracts the three non-`from` entry shapes (side-effect, dynamic, require)', () => {
    // Each of these used to be invisible to the `from`-only matcher, and each fails
    // in the silent direction: an unvendored package reported as clean.
    expect(externalImportsOf('import "@papercusp/side-effect";\n')).toEqual(['@papercusp/side-effect']);
    expect(externalImportsOf('const m = await import("@papercusp/dynamic");\n')).toEqual(['@papercusp/dynamic']);
    expect(externalImportsOf('const m = require("@papercusp/cjs");\n')).toEqual(['@papercusp/cjs']);
  });

  it('ignores a dynamic import whose specifier is an expression, not a literal', () => {
    // templates/papercusp-ops-pots/checks/seam-round-trip.test.ts does exactly this:
    // the target is a path inside the user's app, not a package dependency.
    expect(externalImportsOf('await import(pathToFileURL(inApp(p)).href);\n')).toEqual([]);
  });

  it('maps a scoped SUBPATH specifier to the package dir, not a phantom nested dir', () => {
    // `@papercusp/template-kit/catalog` must look for templates/<ref>/template-kit/,
    // never templates/<ref>/template-kit/catalog/ — which named no directory and so
    // raised a violation against a package that WAS correctly vendored.
    const violations = findUnvendoredImports(TEMPLATES_DIR);
    expect(violations.filter((v) => v.includes('/catalog/'))).toEqual([]);
  });

  it('every non-node import in a template check is vendored INSIDE that template or is a public devDep', () => {
    const violations = findUnvendoredImports(TEMPLATES_DIR);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every vendored package is byte-identical to its canonical libs/generic source', () => {
    const drift = findVendorDrift(TEMPLATES_DIR, join(ROOT, 'libs', 'generic'));
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('a vendored package ships its runtime entrypoint, not just a manifest', () => {
    const bad: string[] = [];
    for (const ref of listTemplateRefs()) {
      const templateDir = join(TEMPLATES_DIR, ref);
      for (const entry of readdirSync(templateDir)) {
        const vendored = join(templateDir, entry);
        if (!statSync(vendored).isDirectory()) continue;
        const manifestPath = join(vendored, 'package.json');
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: string };
        const main = manifest.main ?? 'index.js';
        if (!existsSync(resolve(vendored, main))) {
          bad.push(`templates/${ref}/${entry}: package.json main "${main}" does not exist in the vendored copy`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

/**
 * Falsifiability. Both invariants above assert an EMPTY array, so a bug that made
 * them scan nothing would look identical to a healthy tree. These run the same two
 * functions against a deliberately-broken FIXTURE and require them to complain.
 *
 * The fixture lives in os.tmpdir(), never in the checkout: mutating a real file to
 * prove a guard fires races git-sync's whole-tree sweep, which will happily commit
 * the mutant even when nothing errors (CLAUDE.md, "Proving a guard is falsifiable").
 */
describe('template bundle integrity — the guard itself fails when it should', () => {
  let fixture: string;
  let templates: string;
  let libsGeneric: string;

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'tmpl-bundle-guard-'));
    templates = join(fixture, 'templates');
    libsGeneric = join(fixture, 'libs', 'generic');

    // A HEALTHY template: imports a kit that IS vendored, byte-identical to canonical.
    mkdirSync(join(templates, 'good', 'checks'), { recursive: true });
    mkdirSync(join(templates, 'good', 'demo-kit', 'src'), { recursive: true });
    mkdirSync(join(libsGeneric, 'demo-kit', 'src'), { recursive: true });
    writeFileSync(
      join(templates, 'good', 'checks', 'a.test.ts'),
      'import {\n  thing,\n} from "@papercusp/demo-kit";\nimport { it } from "vitest";\n',
    );
    for (const base of [join(templates, 'good', 'demo-kit'), join(libsGeneric, 'demo-kit')]) {
      writeFileSync(join(base, 'package.json'), '{"name":"@papercusp/demo-kit","main":"./src/index.ts"}');
      writeFileSync(join(base, 'src', 'index.ts'), 'export const thing = 1;\n');
    }

    // BROKEN A: imports a kit that is NOT vendored (the original WI-37777 shape).
    mkdirSync(join(templates, 'unvendored', 'checks'), { recursive: true });
    writeFileSync(
      join(templates, 'unvendored', 'checks', 'b.test.ts'),
      'import {\n  gone,\n} from "@papercusp/absent-kit";\n',
    );

    // BROKEN B: vendored copy has drifted from canonical.
    mkdirSync(join(templates, 'drifted', 'checks'), { recursive: true });
    mkdirSync(join(templates, 'drifted', 'demo-kit', 'src'), { recursive: true });
    writeFileSync(join(templates, 'drifted', 'checks', 'c.test.ts'), 'import { it } from "vitest";\n');
    writeFileSync(
      join(templates, 'drifted', 'demo-kit', 'package.json'),
      '{"name":"@papercusp/demo-kit","main":"./src/index.ts"}',
    );
    writeFileSync(join(templates, 'drifted', 'demo-kit', 'src', 'index.ts'), 'export const thing = 999; // DRIFT\n');

    // BROKEN C: every file the vendored copy HAS matches canonical byte-for-byte —
    // so direction 1 is silent — but canonical ships a runtime file the vendored
    // copy never received. This is the shape that reaches a user as an unresolvable
    // import, and the shape the one-directional check could not see.
    mkdirSync(join(templates, 'incomplete', 'checks'), { recursive: true });
    mkdirSync(join(templates, 'incomplete', 'partial-kit', 'src'), { recursive: true });
    mkdirSync(join(libsGeneric, 'partial-kit', 'src'), { recursive: true });
    writeFileSync(join(templates, 'incomplete', 'checks', 'd.test.ts'), 'import { it } from "vitest";\n');
    for (const base of [join(templates, 'incomplete', 'partial-kit'), join(libsGeneric, 'partial-kit')]) {
      writeFileSync(join(base, 'package.json'), '{"name":"@papercusp/partial-kit","main":"./src/index.ts"}');
      writeFileSync(join(base, 'src', 'index.ts'), 'export { helper } from "./helper";\n');
    }
    // canonical-only: the helper index.ts imports, plus dev-harness files that are
    // legitimately vendored-out and must NOT be reported.
    writeFileSync(join(libsGeneric, 'partial-kit', 'src', 'helper.ts'), 'export const helper = 1;\n');
    writeFileSync(join(libsGeneric, 'partial-kit', 'src', 'index.test.ts'), 'import { it } from "vitest";\n');
    writeFileSync(join(libsGeneric, 'partial-kit', 'README.md'), '# partial-kit\n');

    // MANIFEST DERIVATION (WI-6554700010009816): canonical declares its dev harness's
    // private devDependency. 'derived-manifest' vendors the derived manifest without
    // it (healthy); 'raw-manifest' vendors the byte copy the old writer produced,
    // which hands a materialized app a devDependency it cannot resolve.
    const canonicalManifest =
      JSON.stringify(
        {
          name: '@papercusp/harness-kit',
          main: './src/index.ts',
          devDependencies: { '@papercusp/test-config': '*', vitest: '^4.1.4' },
        },
        null,
        2,
      ) + '\n';
    mkdirSync(join(libsGeneric, 'harness-kit', 'src'), { recursive: true });
    writeFileSync(join(libsGeneric, 'harness-kit', 'package.json'), canonicalManifest);
    writeFileSync(join(libsGeneric, 'harness-kit', 'src', 'index.ts'), 'export const kit = 1;\n');
    writeFileSync(join(libsGeneric, 'harness-kit', 'vitest.config.ts'), 'export default {};\n');
    for (const [ref, manifest] of [
      ['derived-manifest', vendoredManifestOf(canonicalManifest)],
      ['raw-manifest', canonicalManifest],
    ] as const) {
      mkdirSync(join(templates, ref, 'checks'), { recursive: true });
      mkdirSync(join(templates, ref, 'harness-kit', 'src'), { recursive: true });
      writeFileSync(join(templates, ref, 'checks', 'e.test.ts'), 'import { it } from "vitest";\n');
      writeFileSync(join(templates, ref, 'harness-kit', 'package.json'), manifest);
      writeFileSync(join(templates, ref, 'harness-kit', 'src', 'index.ts'), 'export const kit = 1;\n');
    }
  });

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it('passes the healthy template (so a failure below is the fixture, not a false positive)', () => {
    const only = (rows: string[], ref: string) => rows.filter((r) => r.includes(`templates/${ref}/`));
    expect(only(findUnvendoredImports(templates), 'good')).toEqual([]);
    expect(only(findVendorDrift(templates, libsGeneric), 'good')).toEqual([]);
  });

  it('FIRES on an import with no vendored package (the WI-37777 break)', () => {
    const rows = findUnvendoredImports(templates);
    expect(rows.some((r) => r.includes('unvendored') && r.includes('@papercusp/absent-kit'))).toBe(true);
  });

  it('FIRES on a vendored copy that has drifted from canonical', () => {
    const rows = findVendorDrift(templates, libsGeneric);
    expect(rows.some((r) => r.includes('drifted/demo-kit/src/index.ts') && r.includes('differs'))).toBe(true);
  });

  it('does NOT treat `vitest`/`yaml` as needing vendoring', () => {
    expect(findUnvendoredImports(templates).some((r) => r.includes('"vitest"'))).toBe(false);
  });

  it('FIRES on a canonical runtime file missing from the vendored copy (direction 2)', () => {
    const rows = findVendorDrift(templates, libsGeneric);
    expect(
      rows.some((r) => r.includes('partial-kit/src/helper.ts') && r.includes('missing from the vendored copy')),
      `direction-2 drift not reported. rows:\n${rows.join('\n')}`,
    ).toBe(true);
  });

  it('does NOT report the dev harness (tests, vitest config, README) as missing', () => {
    // The exclusion list is a hole in the symmetry check, so prove it is exactly the
    // intended size: these three are absent from `incomplete`'s vendored copy on
    // purpose and must stay silent, or every vendored package reports permanent drift.
    const rows = findVendorDrift(templates, libsGeneric).filter((r) => r.includes('partial-kit'));
    expect(rows.some((r) => r.includes('index.test.ts'))).toBe(false);
    expect(rows.some((r) => r.includes('README.md'))).toBe(false);
  });

  it('accepts a vendored manifest derived without the dev harness devDependency', () => {
    const rows = findVendorDrift(templates, libsGeneric).filter((r) => r.includes('derived-manifest'));
    expect(rows, rows.join('\n')).toEqual([]);
  });

  it('FIRES on a vendored manifest that byte-copies a dev-harness-only devDependency', () => {
    const rows = findVendorDrift(templates, libsGeneric);
    expect(
      rows.some((r) => r.includes('raw-manifest/harness-kit/package.json') && r.includes('differs')),
      `raw canonical manifest not reported. rows:\n${rows.join('\n')}`,
    ).toBe(true);
  });

  it('vendoredManifestOf drops only dev-harness devDependencies and byte-copies everything else', () => {
    const plain = '{"name":"@papercusp/demo-kit","main":"./src/index.ts"}';
    expect(vendoredManifestOf(plain)).toBe(plain);
    const derived = JSON.parse(
      vendoredManifestOf('{"name":"x","devDependencies":{"@papercusp/test-config":"*","vitest":"^4.1.4"}}'),
    ) as { devDependencies?: Record<string, string> };
    expect(derived.devDependencies).toEqual({ vitest: '^4.1.4' });
    expect(JSON.parse(vendoredManifestOf('{"name":"x","devDependencies":{"@papercusp/test-config":"*"}}'))).toEqual({
      name: 'x',
    });
  });
});
