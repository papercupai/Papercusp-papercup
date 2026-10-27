/**
 * Fixture-driven Playwright specs and the source files they actually exercise (WI-10006650).
 *
 * A fixture-driven spec (e.g. apps/operator/e2e/desktop-render-matrix.spec.ts) boots its OWN
 * Vite server on an `apps/operator/e2e/__fixtures__/*` entry. It renders real product
 * components with only the network/framebuffer seams substituted, and needs no operator
 * server. Playwright owns these files, so the unit-vitest related selection drops them
 * (RELATED_SELECTION_FOREIGN_RUNNER). Nothing else runs `test:e2e`. So a component edit never
 * ran the specs that render that component, and they rotted unnoticed. Measured case:
 * kasmvnc-rfb.ts started refusing an RFB class without `_sendMouse` on 2026-09-23.
 * desktop-render-matrix.spec.ts stayed red until 2026-10-06, and only a new spec hitting the
 * same fixture surfaced it.
 *
 * The fixture entry is named to Vite as a STRING LITERAL, so it is not an import edge. Walking
 * the spec alone never reaches the component. This module treats each `__fixtures__` literal
 * as an extra graph root. It also covers Vite `alias` targets: those are fixture files named
 * by the same kind of literal (e.g. `@novnc/novnc` → `__fixtures__/desktop-render-rfb.ts`).
 *
 * Known limit, by design: bare workspace-package imports (`@papercusp/ui`) are not followed.
 * `staticImportClosure` represents packages by lockfile, not by graph edge. An edit inside
 * a package therefore does not select these specs. The closure IS reported (`unresolved`),
 * so an alias edge it could not follow is visible, never a silent gap.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { staticImportClosure, tsconfigPathEntriesFor } from "./related-tests.mjs";

export const E2E_DIR = "apps/operator/e2e";
export const E2E_WORKSPACE_DIR = "apps/operator";
const SPEC_RE = /\.spec\.(?:ts|mts)$/;
/** A quoted repo-relative `__fixtures__` path, the form every fixture spec passes to Vite. */
const FIXTURE_LITERAL_RE = /['"`](apps\/operator\/e2e\/__fixtures__\/[^'"`\s]+)['"`]/g;

const defaultIo = {
  list: (dir) => readdirSync(dir),
  read: (file) => readFileSync(file, "utf8"),
};

/**
 * Every spec under `e2eDir` whose source names at least one `__fixtures__` file.
 *
 * @param {{ rootDir: string, e2eDir?: string, io?: { list(dir: string): string[], read(file: string): string } }} o
 * @returns {{ spec: string, fixtures: string[] }[]} repo-relative POSIX paths, sorted by spec
 */
export function discoverFixtureSpecs({ rootDir, e2eDir = E2E_DIR, io = defaultIo }) {
  const out = [];
  let names;
  try {
    names = io.list(path.join(rootDir, e2eDir));
  } catch {
    return out;
  }
  for (const name of names.filter((n) => SPEC_RE.test(n)).sort()) {
    const spec = `${e2eDir}/${name}`;
    let source;
    try {
      source = io.read(path.join(rootDir, spec));
    } catch {
      continue;
    }
    const fixtures = [...new Set([...source.matchAll(FIXTURE_LITERAL_RE)].map((m) => m[1]))].sort();
    if (fixtures.length > 0) out.push({ spec, fixtures });
  }
  return out;
}

/**
 * The repo-relative files each fixture spec reaches: spec + fixtures + their static imports
 * (relative and tsconfig-alias edges).
 *
 * @param {{ rootDir: string, specs?: { spec: string, fixtures: string[] }[], aliases?: Array<{ prefix: string, target: string, wildcard: boolean }>, fs?: object }} o
 * @returns {{ spec: string, fixtures: string[], files: Set<string>, ok: boolean, unresolved: string[] }[]}
 */
export function fixtureSpecClosures({ rootDir, specs, aliases, fs }) {
  const root = path.resolve(rootDir);
  const found = specs ?? discoverFixtureSpecs({ rootDir: root });
  const resolvedAliases = aliases ?? tsconfigPathEntriesFor(path.join(root, E2E_WORKSPACE_DIR));
  return found.map(({ spec, fixtures }) => {
    const closure = staticImportClosure({
      rootDir: root,
      entryFiles: [spec, ...fixtures].map((f) => path.join(root, f)),
      aliases: resolvedAliases,
      ...(fs ? { fs } : {}),
    });
    const toRel = (abs) => path.relative(root, abs).split(path.sep).join("/");
    return {
      spec,
      fixtures,
      files: new Set(closure.files.map(toRel)),
      ok: closure.ok,
      unresolved: closure.unresolved.map((u) => (path.isAbsolute(u) ? toRel(u) : u)),
    };
  });
}

/**
 * The fixture specs a change set must run, each with the changed paths that selected it.
 *
 * @param {{ closures: ReturnType<typeof fixtureSpecClosures>, changedPaths: string[] }} o
 * @returns {{ selected: string[], reasons: Record<string, string[]> }}
 */
export function selectFixtureSpecs({ closures, changedPaths }) {
  const changed = changedPaths.map((p) => p.split(path.sep).join("/").replace(/^\.\//, ""));
  const reasons = {};
  for (const c of closures) {
    const hits = changed.filter((p) => c.files.has(p));
    if (hits.length > 0) reasons[c.spec] = hits;
  }
  return { selected: Object.keys(reasons).sort(), reasons };
}

/**
 * The union of every fixture spec's closure: the `appliesTo` set for the affected-tests guard.
 * Memoized per root: the guard asks once per changed path.
 *
 * @param {string} rootDir absolute repository root
 * @returns {Set<string>} repo-relative POSIX paths
 */
const unionCache = new Map();
export function fixtureSpecClosureUnion(rootDir) {
  const root = path.resolve(rootDir);
  if (!unionCache.has(root)) {
    const union = new Set();
    for (const c of fixtureSpecClosures({ rootDir: root })) for (const f of c.files) union.add(f);
    unionCache.set(root, union);
  }
  return unionCache.get(root);
}
