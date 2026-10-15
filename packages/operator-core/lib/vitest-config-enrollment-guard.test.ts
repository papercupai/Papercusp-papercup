import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchForWorkspaceRoot } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  collectVitestConfigs,
  findNestedRootConfigsWithoutServerFragment,
  findStaleExemptions,
  findUnenrolledConfigs,
  isGateEnrolled,
  PLAIN_CONFIG_EXEMPTIONS,
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- guard script is plain .mjs and intentionally has no declaration file.
} from '../../../scripts/check-vitest-config-enrollment.mjs';
import { FOREIGN_HIVE_SUBMODULES } from '../../../scripts/lib/foreign-hive-submodules.mjs';

describe('Vitest config enrollment guard', () => {
  it('recognizes the shared base and the gate-participation fragment', () => {
    expect(
      isGateEnrolled(
        `import { defineVitestConfig } from '@papercusp/test-config/vitest-config';\nexport default defineVitestConfig({ layer: 'unit' });`,
      ),
    ).toBe(true);
    expect(
      isGateEnrolled(
        [
          "import { defineConfig } from 'vitest/config';",
          "import { gateParticipationConfig, sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';",
          'export default defineConfig({ test: { ...sharedHostWorkerCap(), ...gateParticipationConfig() } });',
        ].join('\n'),
      ),
    ).toBe(true);
  });

  // WI-10003716: twelve configs passed the old guard this way while recording zero pass proofs.
  it('does NOT accept a hand-wired admin reporter as gate participation', () => {
    expect(
      isGateEnrolled(
        `import { ADMIN_TEST_RUNS_REPORTER_PATH } from '@papercusp/test-config/vitest-config';\nexport default { test: { reporters: [ADMIN_TEST_RUNS_REPORTER_PATH] } };`,
      ),
    ).toBe(false);
  });

  it('requires the fragment to be called, not merely imported', () => {
    expect(
      isGateEnrolled(
        `import { gateParticipationConfig } from '@papercusp/test-config/vitest-config';\nexport default { test: {} };`,
      ),
    ).toBe(false);
  });

  it('ignores comments and flags a plain config outside the exact exemption set', () => {
    expect(
      findUnenrolledConfigs([
        {
          path: 'libs/generic/new-package/vitest.config.ts',
          content: '// defineVitestConfig is intentionally not called here\nexport default {};',
        },
        {
          path: 'libs/generic/card-stack/vitest.config.ts',
          content: 'export default {};',
        },
      ]),
    ).toEqual(['libs/generic/new-package/vitest.config.ts']);
    expect(PLAIN_CONFIG_EXEMPTIONS.has('libs/generic/new-package/vitest.config.ts')).toBe(false);
  });

  it('does not treat reporter tokens quoted in config data as live enrollment code', () => {
    expect(
      isGateEnrolled(
        [
          "import { defineVitestConfig } from '@papercusp/test-config/vitest-config';",
          "const explanation = 'defineVitestConfig(';",
          "const reporterName = 'ADMIN_TEST_RUNS_REPORTER_PATH';",
          'export default {};',
        ].join('\n'),
        'vitest.config.ts',
      ),
    ).toBe(false);
  });

  // WI-6554700010009161: the root declares `!apps/*-checkpoint`; npm does not treat an excluded
  // directory as a workspace, so the guard must not collect its config either.
  it('honours negated workspace patterns when collecting declared configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'vitest-enrollment-negation-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*', '!apps/*-checkpoint'] }));
      for (const app of ['drill', 'drill-checkpoint']) {
        const dir = join(root, 'apps', app);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), '{}');
        writeFileSync(join(dir, 'vitest.config.ts'), 'export default {};');
      }
      const paths = collectVitestConfigs(root).map((config: { path: string }) => config.path);
      expect(paths).toEqual(['apps/drill/vitest.config.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WI-6554700010009815: a registered foreign-hive submodule (scripts/lib/foreign-hive-submodules.mjs)
  // is another hive's code, judged by that hive's gate. The guard must not collect its config, neither
  // as a declared workspace nor nested under one, so it needs no PLAIN_CONFIG_EXEMPTIONS entry. A
  // sibling that merely shares the path prefix is still collected.
  it('skips registered foreign-hive submodules when collecting declared configs', () => {
    expect(FOREIGN_HIVE_SUBMODULES.length).toBeGreaterThan(0);
    for (const { path: hive } of FOREIGN_HIVE_SUBMODULES) {
      const parent = hive.split('/').slice(0, -1).join('/');
      expect(parent, `${hive} must sit under a parent directory`).not.toBe('');
      expect(PLAIN_CONFIG_EXEMPTIONS.has(`${hive}/vitest.config.ts`)).toBe(false);
      // As a workspace (`<parent>/*`), then nested under a workspace rooted at <parent>.
      for (const workspaces of [[`${parent}/*`], [parent]]) {
        const root = mkdtempSync(join(tmpdir(), 'vitest-enrollment-foreign-hive-'));
        try {
          writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces }));
          mkdirSync(join(root, parent), { recursive: true });
          writeFileSync(join(root, parent, 'package.json'), '{}');
          for (const app of [hive, `${hive}-sibling`]) {
            mkdirSync(join(root, app), { recursive: true });
            writeFileSync(join(root, app, 'package.json'), '{}');
            writeFileSync(join(root, app, 'vitest.config.ts'), 'export default {};');
          }
          const paths = collectVitestConfigs(root).map((config: { path: string }) => config.path);
          expect(paths, JSON.stringify(workspaces)).toEqual([`${hive}-sibling/vitest.config.ts`]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  it('keeps every declared workspace config enrolled at repository HEAD', () => {
    const findings = findUnenrolledConfigs(collectVitestConfigs());
    expect(findings, findings.join('\n')).toEqual([]);
  });
});

// WI-10003808: the exemption set may only shrink, and a hand-rolled enrolled config under a nested
// Vite workspace root needs the server fragment or its jsdom files cannot load the gate's setup file.
describe('Vitest config enrollment guard: stale exemptions and nested workspace roots', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const viteRootOf = (dir: string): string => searchForWorkspaceRoot(dir);
  const BLOOM_GRID = 'libs/generic/papergrid/bloom-grid/vitest.config.ts';

  const PLAIN = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });";
  const FRAGMENT_ONLY = [
    "import { defineConfig } from 'vitest/config';",
    "import { gateParticipationConfig } from '@papercusp/test-config/vitest-config';",
    'export default defineConfig({ test: { ...gateParticipationConfig() } });',
  ].join('\n');
  const WITH_SERVER = [
    "import { defineConfig } from 'vitest/config';",
    "import { gateParticipationConfig, gateParticipationServerConfig } from '@papercusp/test-config/vitest-config';",
    'export default defineConfig({ server: gateParticipationServerConfig(), test: { ...gateParticipationConfig() } });',
  ].join('\n');
  const SHARED_BASE =
    "import { defineVitestConfig } from '@papercusp/test-config/vitest-config';\nexport default defineVitestConfig({ layer: 'unit' });";

  it('reports an exemption whose config enrolled or disappeared, and keeps a still-plain one', () => {
    const exemptions = new Set(['libs/a/vitest.config.ts', 'libs/b/vitest.config.ts', 'libs/c/vitest.config.ts']);
    expect(
      findStaleExemptions(
        [
          { path: 'libs/a/vitest.config.ts', content: FRAGMENT_ONLY },
          { path: 'libs/b/vitest.config.ts', content: PLAIN },
        ],
        exemptions,
      ),
    ).toEqual([
      'libs/a/vitest.config.ts (enrolled: remove the exemption)',
      'libs/c/vitest.config.ts (missing: no such declared workspace config)',
    ]);
  });

  it('requires the server fragment only for a hand-rolled config under a nested workspace root', () => {
    const root = '/repo';
    const rootOf = (dir: string): string => (dir.startsWith('/repo/libs/nested') ? '/repo/libs/nested' : root);
    expect(
      findNestedRootConfigsWithoutServerFragment(
        [
          { path: 'libs/nested/missing/vitest.config.ts', content: FRAGMENT_ONLY },
          { path: 'libs/nested/fixed/vitest.config.ts', content: WITH_SERVER },
          { path: 'libs/nested/base/vitest.config.ts', content: SHARED_BASE },
          { path: 'libs/nested/plain/vitest.config.ts', content: PLAIN },
          { path: 'libs/flat/vitest.config.ts', content: FRAGMENT_ONLY },
        ],
        rootOf,
        root,
      ),
    ).toEqual(['libs/nested/missing/vitest.config.ts']);
  });

  it('does not accept a server fragment that is imported but only named in a comment', () => {
    const commented = WITH_SERVER.replace('server: gateParticipationServerConfig(), ', '/* server: gateParticipationServerConfig() */ ');
    expect(commented).not.toBe(WITH_SERVER);
    expect(
      findNestedRootConfigsWithoutServerFragment(
        [{ path: 'libs/nested/x/vitest.config.ts', content: commented }],
        () => '/repo/libs/nested',
        '/repo',
      ),
    ).toEqual(['libs/nested/x/vitest.config.ts']);
  });

  // Calibration: the rule is only as good as the resolver it is handed. Vite must see papergrid
  // (package.json with `workspaces`) as a nested root and a plain workspace as the repo root.
  it("derives nested roots from Vite's own resolver on the real tree", () => {
    expect(viteRootOf(join(REPO_ROOT, 'libs/generic/papergrid/bloom-grid'))).toBe(join(REPO_ROOT, 'libs/generic/papergrid'));
    expect(viteRootOf(join(REPO_ROOT, 'packages/operator-core'))).toBe(REPO_ROOT);
  });

  it('keeps PLAIN_CONFIG_EXEMPTIONS free of stale entries at repository HEAD', () => {
    const stale = findStaleExemptions(collectVitestConfigs());
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('gives every nested-root hand-rolled config at repository HEAD the server fragment', () => {
    const findings = findNestedRootConfigsWithoutServerFragment(collectVitestConfigs(), viteRootOf);
    expect(findings, findings.join('\n')).toEqual([]);
  });

  // Falsifiability control, in memory only: the real bloom-grid config with its server line
  // removed must be caught, so the HEAD check above cannot pass vacuously.
  it('would flag the real bloom-grid config if its server fragment were dropped', () => {
    const all: Array<{ path: string; content: string }> = collectVitestConfigs();
    const real = all.filter(({ path }) => path === BLOOM_GRID);
    expect(real).toHaveLength(1);
    const mutated = real.map((c) => ({ ...c, content: c.content.replace('server: gateParticipationServerConfig(),', '') }));
    expect(mutated[0].content).not.toBe(real[0].content);
    expect(findNestedRootConfigsWithoutServerFragment(mutated, viteRootOf)).toEqual([BLOOM_GRID]);
  });
});

// WI-6554700010009145: under the committed-source loader, scripts/test-files.mjs makes Vite load
// every config with configLoader 'native', i.e. a plain Node `import()` of the .ts file as ES. A
// config that reads CommonJS globals (`__dirname`, `require`) then throws and the whole group
// collects 0 tests. This imports each config the way Vite's nativeImportConfigFile does, in a
// separate Node process (inside Vitest the import would go through Vite's transform instead).
describe('Vitest config native loading', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const IMPORT_EACH = [
    "import { pathToFileURL } from 'node:url';",
    'const failures = [];',
    'for (const file of JSON.parse(process.argv[1])) {',
    '  try {',
    "    const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());",
    "    if (typeof mod.default !== 'object' && typeof mod.default !== 'function') failures.push(file + ': default export is ' + typeof mod.default);",
    '  } catch (error) {',
    "    failures.push(file + ': ' + String(error?.message ?? error).split('\\n')[0]);",
    '  }',
    '}',
    'process.stdout.write(JSON.stringify(failures));',
  ].join('\n');
  const nativeImportFailures = (files: string[]): string[] =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', IMPORT_EACH, JSON.stringify(files)], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 120_000,
      }),
    ) as string[];

  it('loads the root config and every declared workspace config as native ES', () => {
    const files = [
      join(REPO_ROOT, 'vitest.config.ts'),
      ...collectVitestConfigs().map(({ path }: { path: string }) => join(REPO_ROOT, path)),
    ];
    expect(files.length).toBeGreaterThan(1);
    const failures = nativeImportFailures(files);
    expect(failures, failures.join('\n')).toEqual([]);
  }, 150_000);

  // Falsifiability control: a config that reads `__dirname` must be reported by the same import.
  it('reports a config that reads the CommonJS __dirname', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-config-'));
    try {
      const bad = join(dir, 'vitest.config.ts');
      writeFileSync(bad, "import { resolve } from 'node:path';\nexport default { root: resolve(__dirname) };\n");
      const failures = nativeImportFailures([bad]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('__dirname is not defined');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
