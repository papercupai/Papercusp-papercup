/**
 * moduleRepoRoot — unit cases plus a census guard for the defect class it fixes (P-016,
 * EI-24788071071653463): a fixed `..` climb from import.meta.url to the repo root is wrong
 * inside the esbuild host bundle, where import.meta.url is the BUNDLE's URL.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { moduleRepoRoot } from './module-repo-root';
import { presentOnDisk } from '../../../scripts/lib/tracked-files.mjs';

const FAKE_ROOT = '/srv/checkout';
const atFakeRoot = (dir: string) => dir === FAKE_ROOT;
const url = (path: string) => pathToFileURL(path).href;

describe('moduleRepoRoot', () => {
  it('returns the nearest ancestor holding a .git entry', () => {
    expect(moduleRepoRoot(url(`${FAKE_ROOT}/packages/operator-core/lib/harness/routines/x.ts`), atFakeRoot)).toBe(
      FAKE_ROOT,
    );
  });

  it('gives the same answer from the source location and from inside the host bundle', () => {
    // The P-016 regression: a 5-level climb sized for lib/harness/routines/ started from
    // apps/operator/dist-host/ inside the bundle and landed two levels above the checkout.
    const fromSource = moduleRepoRoot(url(`${FAKE_ROOT}/packages/operator-core/lib/harness/routines/x.ts`), atFakeRoot);
    const fromBundle = moduleRepoRoot(url(`${FAKE_ROOT}/apps/operator/dist-host/hono-host.mjs`), atFakeRoot);
    expect(fromBundle).toBe(fromSource);
    const fixedClimb = resolve(`${FAKE_ROOT}/apps/operator/dist-host`, '../../../../..');
    expect(fixedClimb).not.toBe(FAKE_ROOT); // the old arithmetic really was wrong there
  });

  it('stops at the first .git, so a module inside a submodule resolves to the submodule', () => {
    const sub = `${FAKE_ROOT}/libs/papercusp`;
    const hasGit = (dir: string) => dir === FAKE_ROOT || dir === sub;
    expect(moduleRepoRoot(url(`${sub}/libs/db/scripts/x.mjs`), hasGit)).toBe(sub);
  });

  it("returns the module's own directory when no checkout is above it (never throws)", () => {
    expect(moduleRepoRoot(url('/opt/app/dist/bundle.mjs'), () => false)).toBe('/opt/app/dist');
  });

  describe('on a real filesystem', () => {
    let tmp: string | undefined;
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    it('accepts .git as a FILE (worktree / submodule) as well as a directory', () => {
      tmp = mkdtempSync(join(tmpdir(), 'module-repo-root-'));
      const repo = join(tmp, 'repo');
      mkdirSync(join(repo, 'a', 'b'), { recursive: true });
      writeFileSync(join(repo, '.git'), 'gitdir: /elsewhere\n');
      expect(moduleRepoRoot(url(join(repo, 'a', 'b', 'mod.ts')))).toBe(repo);
    });

    it('resolves THIS test file to the checkout git itself reports', () => {
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dirname(new URL(import.meta.url).pathname),
        encoding: 'utf8',
      }).trim();
      expect(moduleRepoRoot(import.meta.url)).toBe(top);
    });
  });
});

// ── census guard ───────────────────────────────────────────────────────────────────────

const REPO_ROOT = moduleRepoRoot(import.meta.url);
const SCOPE = ['packages/operator-core/lib', 'apps/operator/lib', 'apps/operator/bin'];
// Filter before subprocess capture: this tree also contains large non-source artifacts.
// Capturing the whole census and filtering afterward exceeded execFileSync's buffer.
const SOURCE_PATHSPECS = SCOPE.flatMap((dir) => ['ts', 'mts', 'tsx'].map((ext) => `:(glob)${dir}/**/*.${ext}`));

/**
 * Non-test modules allowed to climb to the repo root with a fixed `..` count. EMPTY since
 * 2026-10-01 (EI-24812768473266076 converted the last 17 sites to moduleRepoRoot). SHRINK-ONLY:
 * never add an entry. A listed module that later becomes bundled into
 * apps/operator/dist-host/hono-host.mjs breaks silently, which is why new sites are refused
 * outright rather than reviewed one by one.
 */
const ALLOWED_FIXED_CLIMBS: Readonly<Record<string, number>> = {};

const MODULE_DIR = String.raw`(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)`;

/**
 * Every expression in `src` that resolves a string-literal path, relative to the module's own
 * directory, to exactly `root`. Covers the direct form, the two-step form through a bound name
 * (`const here = dirname(fileURLToPath(import.meta.url))`, or `import.meta.dirname`), and
 * `new URL('../..', import.meta.url)`. URL climbs to assets below the root count too:
 * bundling changes their base in exactly the same way (WI-10007650).
 */
function fixedClimbsToRoot(src: string, fileAbs: string, root: string): string[] {
  if (!src.includes('import.meta')) return [];
  const here = dirname(fileAbs);
  const names = new Set<string>();
  for (const m of src.matchAll(new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:${MODULE_DIR}|import\.meta\.dirname\b)`, 'g'))) {
    names.add(m[1]!.replace(/\$/g, '\\$'));
  }
  const bases = [MODULE_DIR, String.raw`import\.meta\.dirname`, ...names];
  const call = new RegExp(
    String.raw`(?:path\.)?(?:resolve|join)\(\s*(?:${bases.join('|')})\s*((?:,\s*(['"])[^'"]*\2\s*)+)\)`,
    'g',
  );
  const hits: string[] = [];
  for (const m of src.matchAll(call)) {
    const segs = [...m[1]!.matchAll(/(['"])([^'"]*)\1/g)].map((s) => s[2]!);
    if (resolve(here, ...segs) === root) hits.push(m[0].replace(/\s+/g, ' '));
  }
  for (const m of src.matchAll(/new URL\(\s*(['"])([^'"]*)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    const climb = m[2]!.match(/^(?:\.\.\/)+/);
    if (resolve(here, m[2]!) === root || (climb && resolve(here, climb[0]) === root)) hits.push(m[0]);
  }
  return hits;
}

describe('census: no new fixed import.meta.url climbs to the repo root', () => {
  const lib = join(FAKE_ROOT, 'packages/operator-core/lib/harness/routines/x.ts');

  it('detector catches each shape it claims to (positive controls)', () => {
    const shapes = [
      "const R = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');",
      "const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');",
      "const here = dirname(fileURLToPath(import.meta.url));\nconst R = join(here, '../../../../..');",
      "const R = resolve(import.meta.dirname, '../../../../..');",
      "const R = new URL('../../../../../', import.meta.url);",
      "const R = new URL('../../../../../scripts/check-lockfile-census.mjs', import.meta.url);",
      "const R = new URL('../../../../../libs/generic/memory/src/local-embedder-worker.script.mjs', import.meta.url);",
    ];
    for (const src of shapes) expect(fixedClimbsToRoot(src, lib, FAKE_ROOT), src).toHaveLength(1);
  });

  it('detector ignores climbs that land somewhere other than the root (negative controls)', () => {
    const shapes = [
      "const S = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../scripts');",
      "const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake.mjs');",
      'const R = moduleRepoRoot(import.meta.url);',
      "const F = new URL('../fixtures/fake.mjs', import.meta.url);",
    ];
    for (const src of shapes) expect(fixedClimbsToRoot(src, lib, FAKE_ROOT), src).toEqual([]);
  });

  it('the scanned tree has no unlisted site, and every listed site still exists (shrink-only)', () => {
    const files = presentOnDisk(execFileSync('git', ['ls-files', '-z', '--', ...SOURCE_PATHSPECS], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => /\.(ts|mts|tsx)$/.test(f) && !/\.(test|spec)(?:-helper)?\.tsx?$/.test(f) && !f.includes('/__tests__/')), REPO_ROOT);
    expect(files.length).toBeGreaterThan(1000); // the census really read the tree

    const found: Record<string, number> = {};
    for (const f of files) {
      let src: string;
      try {
        src = readFileSync(join(REPO_ROOT, f), 'utf8');
      } catch {
        continue; // tracked but deleted in the working tree
      }
      const n = fixedClimbsToRoot(src, join(REPO_ROOT, f), REPO_ROOT).length;
      if (n > 0) found[f] = n;
    }
    // Positive control on the real tree: a climb sized for a real scanned file's actual depth is
    // detected against the real REPO_ROOT. With no offending site left, an empty `found` would
    // otherwise also be what a broken census looks like (wrong REPO_ROOT, wrong joined path).
    const probe = 'packages/operator-core/lib/module-repo-root.ts';
    expect(files).toContain(probe);
    const climb = relative(dirname(join(REPO_ROOT, probe)), REPO_ROOT);
    const synthetic = `const R = resolve(dirname(fileURLToPath(import.meta.url)), '${climb}');`;
    expect(fixedClimbsToRoot(synthetic, join(REPO_ROOT, probe), REPO_ROOT)).toHaveLength(1);

    const unlisted = Object.entries(found).filter(([f, n]) => n > (ALLOWED_FIXED_CLIMBS[f] ?? 0));
    expect(
      unlisted,
      'use moduleRepoRoot(import.meta.url) from packages/operator-core/lib/module-repo-root.ts instead of a fixed `..` climb',
    ).toEqual([]);
    const stale = Object.entries(ALLOWED_FIXED_CLIMBS).filter(([f, n]) => (found[f] ?? 0) < n);
    expect(stale, 'these sites were converted: lower or delete their ALLOWED_FIXED_CLIMBS entries').toEqual([]);
  });
});
