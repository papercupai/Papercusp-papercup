/**
 * affected-tests-non-workspace-routes.test.ts — EI-19346163916263067 regression guard.
 *
 * `scripts/affected-tests.mjs` maps a changed path to a workspace by matching it
 * against each WORKSPACE DIRECTORY. Root `scripts/` is not an npm workspace and holds
 * no package.json, so every path under it matched NOTHING and contributed zero to the
 * affected set — while being the repo's own gate machinery (affected-tests.mjs itself,
 * lint-tsc*.mjs, gen-declarations.ts, next-migration.mjs, the 53 `check-*.mjs` guards).
 * The tooling that decides what gets tested was the one thing it could not select
 * tests for.
 *
 * MEASURED before the fix (last 600 commits of staging): 106 commits touched
 * `scripts/`; for 7 of them the computed affected set did not include operator-core,
 * so the ~56 suites that exercise those scripts never ran — and one (33edac17e5)
 * selected ZERO workspaces and reported `status=passed tasks=0` having run nothing.
 *
 * These assert BEHAVIOR through the real CLI (`--changed-paths … --print-affected`,
 * which exits before executing any suite), not source text.
 *
 * NOTE ON CONTROLS: the negative cases below are not decoration. `expect(...).toContain`
 * on a route target would pass just as happily if the route had become a catch-all that
 * selects every workspace for every path, and an "empty" assertion would pass if the
 * probe were simply broken and always printed nothing. Each direction is pinned by a
 * case that must come out the other way.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const ROUTED_DIR = 'scripts/';
const ROUTE_TARGET = '@papercusp/operator-core';

/** The affected workspace names the real CLI computes for an explicit path set. */
function affectedFor(paths: string[]): string[] {
  const r = spawnSync(
    'node',
    [AFFECTED_TESTS, '--changed-paths', paths.join(','), '--print-affected'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    },
  );
  expect(r.status, `affected-tests --print-affected failed:\n${r.stderr}`).toBe(0);
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('AFFECTED_WS\t'))
    .map((l) => l.slice('AFFECTED_WS\t'.length).trim());
}

describe('affected-tests: non-workspace path routes (EI-19346163916263067)', () => {
  it('routes a root scripts/ change to the workspace that owns its tests', () => {
    expect(
      affectedFor([`${ROUTED_DIR}lint-tsc.mjs`]),
      `A change to ${ROUTED_DIR}** no longer selects ${ROUTE_TARGET}, so none of the ~56 ` +
        `suites that exercise root scripts/ would run for it — including every check-*.mjs ` +
        `guard test. Check NON_WORKSPACE_PATH_ROUTES in scripts/affected-tests.mjs.`,
    ).toContain(ROUTE_TARGET);
  });

  it('CONTROL: an unrouted root file still selects nothing — the route is not a catch-all', () => {
    // Without this, the assertion above is satisfied by a rule that selects everything
    // for everything, which would be a far worse bug than the one being fixed.
    expect(
      affectedFor(['UNROUTED_CONTROL.txt']),
      'A root file with no owning workspace and no route now selects workspaces. The ' +
        'routing fallback has become a catch-all; every commit would run those suites.',
    ).toEqual([]);
  });

  it('CONTROL: a genuine workspace path still resolves through the workspace-dir rule', () => {
    // Pins the other direction: the probe really can return a non-empty set for a
    // normal path, so the empty result above is a fact about routing, not a broken probe.
    expect(affectedFor(['libs/flags/src/types.ts'])).toContain('@papercusp/flags');
  });

  it('routes the hosted PUI psu release wrapper to the workspace that owns its integration test', () => {
    const affected = affectedFor(['apps/tui/release/psu']);
    expect(
      affected,
      'A change to apps/tui/release/psu no longer selects @papercusp/web, so the ' +
        'integration test guarding the hosted wrapper re-exec loop would not run. ' +
        'Check NON_WORKSPACE_PATH_ROUTES in scripts/affected-tests.mjs.',
    ).toContain('@papercusp/web');
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/operator/lib/psu-release-wrapper.integration.test.ts')),
      'The apps/tui/release/psu route points at @papercusp/web because the wrapper integration test lives there; move the route with the test if it moves.',
    ).toBe(true);
  });

  it('defers to a real workspace that owns the path — routing is a fallback, not an override', () => {
    // `apps/operator/scripts/**` is inside the @papercusp/web workspace. It must resolve
    // there and NOT be dragged into the root-scripts route by a naive substring match.
    const affected = affectedFor(['apps/operator/scripts/some-tool.mjs']);
    expect(affected).toContain('@papercusp/web');
    expect(
      affected,
      'apps/operator/scripts/** is owned by @papercusp/web but is being routed as if it ' +
        'were root scripts/. The route must only apply when no workspace claims the path.',
    ).not.toContain(ROUTE_TARGET);
  });

  it("THE RATCHET: the route's premise holds — root scripts/ is still not an npm workspace", () => {
    // If `scripts` ever becomes a workspace, the workspace-dir rule claims it and this
    // route becomes dead code that silently stops being the thing under test.
    const patterns: string[] = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
    ).workspaces ?? [];
    const claimed = patterns.some((p) =>
      p.endsWith('/*') ? 'scripts'.startsWith(p.slice(0, -2) + '/') : p === 'scripts',
    );
    expect(
      claimed,
      'root `scripts` is now an npm workspace — remove its NON_WORKSPACE_PATH_ROUTES entry ' +
        'so the workspace-dir rule owns it, rather than leaving a dead route behind.',
    ).toBe(false);
  });

  it('THE RATCHET: the routed workspace still owns tests that exercise root scripts/', () => {
    // (see the templates/ block below for the second routed non-workspace dir)
    // The route is only correct while the suites it aims at live there. If they move,
    // the route keeps "working" while selecting a workspace that covers nothing.
    const r = spawnSync(
      'bash',
      [
        '-c',
        `grep -rl "scripts/" --include=*.test.ts --include=*.test.tsx packages/operator-core | wc -l`,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(
      Number(String(r.stdout).trim()),
      `${ROUTE_TARGET} no longer holds a meaningful number of tests referencing root scripts/. ` +
        'If those suites moved, move the route with them.',
    ).toBeGreaterThan(20);
  });
});

/**
 * WI-37840 — the same class, found again in `templates/`.
 *
 * `templates/` is SHIPPED CONTENT (the official app templates, overlaid wholesale
 * into a user's materialized app) with no package.json of its own, so it matched no
 * workspace. MEASURED before the route was added:
 *
 *   --changed-paths templates/papercusp-ui/template.yaml  -> (empty), exit 0
 *   --changed-paths packages/operator-core/lib/cupboard/templates.ts -> 5 workspaces
 *
 * and "nothing to gate" is GREEN at the green-checkpoint. So a templates-only commit
 * ran no tests at all — while THREE guards written specifically to police that
 * directory (template-bundle-integrity, template-docs-slugs, template-store-shadowing)
 * sat in operator-core, unreachable from the only change that can trip them.
 */
describe('affected-tests: the templates/ route (WI-37840)', () => {
  const TEMPLATE_GUARDS = [
    'packages/operator-core/lib/cupboard/template-bundle-integrity.test.ts',
    'packages/operator-core/lib/cupboard/template-docs-slugs.test.ts',
    'packages/operator-core/lib/cupboard/template-store-shadowing.test.ts',
  ];

  it('routes a templates/ manifest change to the workspace holding the template guards', () => {
    expect(
      affectedFor(['templates/papercusp-ui/template.yaml']),
      'A templates/** change no longer selects the workspace that owns the template ' +
        'guards, so adding a dangling docs: slug or an unvendored import would pass the ' +
        'gate green. Check NON_WORKSPACE_PATH_ROUTES in scripts/affected-tests.mjs.',
    ).toContain(ROUTE_TARGET);
  });

  it('routes a vendored package inside a template too', () => {
    // The vendored copies (template-kit, pot-app-seam) are the drift-prone surface
    // findVendorDrift polices; they live under templates/ and must route the same way.
    expect(affectedFor(['templates/papercusp-ops-pots/pot-app-seam/src/index.ts'])).toContain(
      ROUTE_TARGET,
    );
  });

  it("THE RATCHET: templates/ is still not an npm workspace", () => {
    const patterns: string[] = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
    ).workspaces ?? [];
    const claimed = patterns.some((p) =>
      p.endsWith('/*') ? 'templates'.startsWith(p.slice(0, -2) + '/') : p === 'templates',
    );
    expect(
      claimed,
      'templates/ is now an npm workspace — remove its NON_WORKSPACE_PATH_ROUTES entry so ' +
        'the workspace-dir rule owns it, rather than leaving a dead route behind.',
    ).toBe(false);
  });

  it('THE RATCHET: the template guards still live in the routed workspace', () => {
    // The route aims at operator-core because the guards are there. If a guard moves,
    // the route keeps "working" while pointing at a workspace that no longer covers it.
    for (const guard of TEMPLATE_GUARDS) {
      expect(
        existsSync(resolve(REPO_ROOT, guard)),
        `${guard} is gone or moved. The templates/ route points at ${ROUTE_TARGET} precisely ` +
          'because these guards live there — move the route with them, or this route silently ' +
          'stops protecting anything.',
      ).toBe(true);
    }
  });
});

/**
 * EI-21112293570332409 — the templates/ route must reach EVERY workspace that tests
 * templates/, not just the first one anybody happened to route.
 *
 * The WI-37840 block above routes templates/ to operator-core because three guards live
 * there, and ratchets on that hand-written list. `libs/generic/template-kit` later grew
 * `templates-dir.test.ts`, which scans `templates/*​/checks/*` to enforce that a check
 * naming a sibling template routes the path through the tri-state resolver
 * `checks/closure-manifests.ts` — the recurrence guard for EI-21110451200329856, where
 * BOTH official mobile app roots shipped checks dereferencing `../../papercusp-<id>`
 * paths that exist only in this repo and so were RED in every materialized app.
 *
 * Nothing forced a route for that new workspace, so it had none. MEASURED 2026-08-22:
 *
 *   --changed-paths libs/generic/template-kit/src/templates-dir.test.ts
 *       -> AFFECTED_WS @papercusp/template-kit + 5 fallback   (control: selection works)
 *   --changed-paths templates/papercusp-android-app/checks/composition-integrity.test.ts
 *       -> 5 fallback workspaces, template-kit ABSENT         (the guard did NOT run)
 *
 * i.e. reintroducing the exact defect the guard exists to catch left scoped
 * `test:affected` green; it would have surfaced only at the green-checkpoint hours later.
 *
 * The first three cases pin that specific route. The fourth is the one that matters for
 * the CLASS: it DERIVES the set of workspaces that own a templates/-scanning test and
 * asserts each is reachable, so the next such test added in an unrouted workspace fails
 * here instead of silently not running. A hand-maintained list is what missed this.
 */
describe('affected-tests: templates/ reaches every workspace that tests it (EI-21112293570332409)', () => {
  const TEMPLATE_KIT = '@papercusp/template-kit';
  const KIT_GUARD = 'libs/generic/template-kit/src/templates-dir.test.ts';
  /** A templates/ path used as the probe subject; any path under templates/ routes alike. */
  const TEMPLATES_PROBE = 'templates/papercusp-ui/template.yaml';

  it('routes a templates/ check change to the workspace holding the sibling-path guard', () => {
    expect(
      affectedFor(['templates/papercusp-android-app/checks/composition-integrity.test.ts']),
      'A templates/** change no longer selects @papercusp/template-kit, so re-introducing ' +
        'an unresolved `../../papercusp-<id>` sibling path in a shipped check would pass ' +
        'scoped test:affected green. Check NON_WORKSPACE_PATH_ROUTES in ' +
        'scripts/affected-tests.mjs.',
    ).toContain(TEMPLATE_KIT);
  });

  it('CONTROL: the route is not a catch-all — an unrelated path does not select it', () => {
    // Without this, the case above would pass just as happily if the route had become a
    // catch-all selecting every workspace for every path.
    expect(affectedFor(['apps/operator/lib/release/deploy-cli.ts'])).not.toContain(TEMPLATE_KIT);
  });

  it('THE RATCHET: the sibling-path recurrence guard still lives in the routed workspace', () => {
    expect(
      existsSync(resolve(REPO_ROOT, KIT_GUARD)),
      `${KIT_GUARD} is gone or moved. The templates/ -> ${TEMPLATE_KIT} route exists ` +
        'precisely because that guard lives there — move the route with it, or the route ' +
        'silently stops protecting anything.',
    ).toBe(true);
  });

  it('THE DERIVED RATCHET: every workspace owning a templates/-scanning test is selected', () => {
    const ls = spawnSync('git', ['ls-files', '*.test.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    expect(ls.status, `git ls-files failed:\n${ls.stderr}`).toBe(0);

    const candidates = (ls.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      // Tests INSIDE templates/ are shipped content run in the materialized app, not here.
      .filter((l) => l.endsWith('.test.ts') && !l.startsWith('templates/'))
      // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
      .filter((l) => existsSync(resolve(REPO_ROOT, l)));

    // Two-part signature: names the templates dir as a path segment AND reads the
    // filesystem. Both idioms in the tree are covered — a relative climb
    // (`../../../../templates`) and a join off a repo root (`join(ROOT, 'templates')`).
    const NAMES_TEMPLATES_DIR = /['"]templates['"]|(?:\.\.\/)+templates|\/templates['"]/;
    const READS_FS = /readdirSync|existsSync|readFileSync/;

    const owners = new Set<string>();
    for (const rel of candidates) {
      const abs = resolve(REPO_ROOT, rel);
      if (!existsSync(abs)) continue;
      const src = readFileSync(abs, 'utf8');
      if (!NAMES_TEMPLATES_DIR.test(src) || !READS_FS.test(src)) continue;

      // Owning workspace = nearest package.json at or above the file.
      let dir = dirname(abs);
      let owner: string | null = null;
      while (dir.startsWith(REPO_ROOT) && dir.length >= REPO_ROOT.length) {
        const pkg = resolve(dir, 'package.json');
        if (existsSync(pkg)) {
          const name = JSON.parse(readFileSync(pkg, 'utf8')).name;
          // The repo root package is not a workspace; keep climbing past nothing above it.
          if (typeof name === 'string' && dir !== REPO_ROOT) owner = name;
          break;
        }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      if (owner) owners.add(owner);
    }

    // CALIBRATION: if the scan silently stops matching, every assertion below passes
    // vacuously. Both known owners must be found, or the detector — not the routes — broke.
    expect(
      [...owners].sort(),
      'The templates/-scanning-test scan found neither known owner, so it is no longer ' +
        'detecting anything and the assertion below would pass vacuously. Fix the ' +
        'signature (NAMES_TEMPLATES_DIR / READS_FS), do not delete this case.',
    ).toEqual(expect.arrayContaining([ROUTE_TARGET, TEMPLATE_KIT]));

    const selected = affectedFor([TEMPLATES_PROBE]);
    for (const owner of [...owners].sort()) {
      expect(
        selected,
        `${owner} owns a test that scans templates/, but a templates/ change does not ` +
          `select it — that test cannot catch a defect introduced by a templates-only ` +
          `edit. Add { prefix: "templates/", workspace: "${owner}" } to ` +
          'NON_WORKSPACE_PATH_ROUTES in scripts/affected-tests.mjs (the loop applies every ' +
          'matching route, so routes for one prefix compose).',
      ).toContain(owner);
    }
  });
});

/**
 * WI-6554700010008507 — the same class in `libs/papercusp/plugins/`, the bundled first-party
 * plugins. A manifest-only edit (an Asana setup.credentials key the schema refuses, which makes
 * the loader drop the whole package) selected ZERO workspaces, so the guard written for exactly
 * that defect — plugin-loader's "every bundled first-party plugin manifest validates" — never ran
 * under scoped verification.
 */
describe('affected-tests: the libs/papercusp/plugins/ route (WI-6554700010008507)', () => {
  const MANIFEST = 'libs/papercusp/plugins/asana/papercusp.json';
  const MANIFEST_GUARD = 'packages/plugin-loader/src/manifest-validate.test.ts';

  it('routes a bundled plugin manifest change to the manifest guard and the provider-package tests', () => {
    const selected = affectedFor([MANIFEST]);
    expect(
      selected,
      'A bundled plugin manifest change no longer selects @papercusp/plugin-loader, so a manifest ' +
        'the schema refuses passes scoped verification. Check NON_WORKSPACE_PATH_ROUTES.',
    ).toContain('@papercusp/plugin-loader');
    expect(selected).toContain('@papercusp/operator-core');
  });

  it('CONTROL: a sibling path outside plugins/ in the same submodule does not pick up the route', () => {
    // libs/papercusp/plugins-<x> is not the plugins dir; the prefix keeps its trailing slash.
    expect(affectedFor(['libs/papercusp/plugins-notes.md'])).not.toContain('@papercusp/plugin-loader');
  });

  it('THE RATCHET: the routed workspace still holds the every-bundled-manifest guard', () => {
    expect(existsSync(resolve(REPO_ROOT, MANIFEST_GUARD))).toBe(true);
    expect(readFileSync(resolve(REPO_ROOT, MANIFEST_GUARD), 'utf8')).toContain(
      'every bundled first-party plugin manifest validates',
    );
  });
});
