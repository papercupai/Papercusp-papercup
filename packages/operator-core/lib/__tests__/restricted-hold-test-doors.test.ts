// Restricted-hold test doors (WI-10005765; plan personal-data-reader-set-labels-2026-10-01 D-012).
//
// testing:run, the raw router and the @papercusp/test-config vitest root run the restricted-hold
// census before any test executes. Two runner shapes bypass all three and run live-tree code:
//   - direct `npx vitest` in the standalone packages that cannot import @papercusp/test-config
//     (scripts/check-vitest-config-enrollment.mjs PLAIN_CONFIG_EXEMPTIONS);
//   - `node --test` suites (papercusp-desktop, libs/papercusp cli + orchestrator).
// Each gets the census through a walk-up to a monorepo convention module. These tests pin that
// every such door is wired, so a new standalone config or node:test script cannot silently skip it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- guard script is plain .mjs and intentionally has no declaration file.
import { PLAIN_CONFIG_EXEMPTIONS } from '../../../../scripts/check-vitest-config-enrollment.mjs';
import { listTrackedFiles } from '../../../../scripts/lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const VITEST_DOOR = 'scripts/lib/vitest-host-preflight.mjs';
const NODE_TEST_DOOR = 'scripts/lib/node-test-host-preflight.mjs';

/** Standalone configs that run no tests at all, so they have nothing to fence. */
const VITEST_CONFIGS_RUNNING_NOTHING: Record<string, string> = {
  'libs/papercusp/packages/cli/vitest.config.ts':
    'include: [] -- the package tests with node:test, whose script is pinned below',
};

/** package.json files whose node:test scripts are not run against the live tree. */
const NODE_TEST_PACKAGES_EXCLUDED: Record<string, string> = {
  'packages/operator-core/lib/pot-eval/fixtures/seed-app/package.json':
    'fixture data: a seed app copied into a scratch workspace by pot-eval, never run in this checkout',
};

const NODE_TEST_SCRIPT = /\bnode\s+(?:--\S+\s+)*--test(?:\s|$)/;

/**
 * Every `node --test` script in `scripts` that lacks a --test-global-setup naming a module that
 * walks up to the node:test door. `readSetup` returns the setup module's source, or null if absent.
 */
function nodeTestScriptsMissingDoor(
  scripts: Record<string, string>,
  readSetup: (relativeToPackage: string) => string | null,
): string[] {
  const missing: string[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    // `&&` chains run several commands: judge each one on its own.
    for (const part of command.split(/&&|\|\||;/)) {
      if (!NODE_TEST_SCRIPT.test(part)) continue;
      const setup = /--test-global-setup=(\S+)/.exec(part)?.[1];
      const source = setup ? readSetup(setup) : null;
      if (!source || !source.includes(NODE_TEST_DOOR) || !/export\s+async\s+function\s+globalSetup\b/.test(source)) {
        missing.push(name);
        break;
      }
    }
  }
  return missing;
}

/** True when a standalone vitest config lists the walk-up to the vitest door as its globalSetup. */
function vitestConfigWiresDoor(source: string): boolean {
  return source.includes(VITEST_DOOR) && /globalSetup:\s*monorepoHostPreflight\(\)/.test(source);
}

const SHIM = [
  "import { existsSync } from 'node:fs';",
  'export async function globalSetup() {',
  `  const candidate = join(dir, '${NODE_TEST_DOOR}');`,
  '}',
].join('\n');

describe('restricted-hold test doors', () => {
  it('detects a node:test script without the global setup, and accepts one with it', () => {
    const read = (path: string) => (path === 'shim.mjs' ? SHIM : null);
    expect(
      nodeTestScriptsMissingDoor(
        {
          bare: 'node --test test/a.test.js',
          withImport: 'node --test --import tsx src/**/*.test.ts',
          chained: 'npm run build && node --test test/b.test.js',
          missingFile: 'node --test --test-global-setup=gone.mjs test/a.test.js',
          wired: 'node --test --test-global-setup=shim.mjs test/a.test.js',
          wiredImport: 'node --test --test-global-setup=shim.mjs --import tsx src/**/*.test.ts',
          notATest: 'node scripts/run.mjs --testing',
          vitest: 'vitest run',
        },
        read,
      ),
    ).toEqual(['bare', 'withImport', 'chained', 'missingFile']);
    // A setup module that does not reach the door is not a door.
    expect(
      nodeTestScriptsMissingDoor({ wrong: 'node --test --test-global-setup=other.mjs t.js' }, (p) =>
        p === 'other.mjs' ? 'export async function globalSetup() {}' : null,
      ),
    ).toEqual(['wrong']);
  });

  it('detects a standalone vitest config without the walk-up', () => {
    expect(vitestConfigWiresDoor("export default defineConfig({ test: { environment: 'jsdom' } });")).toBe(false);
    expect(
      vitestConfigWiresDoor(
        `const c = join(dir, '${VITEST_DOOR}');\nexport default defineConfig({ test: { globalSetup: monorepoHostPreflight() } });`,
      ),
    ).toBe(true);
  });

  it('wires every standalone exempt vitest config that runs tests to the vitest door', () => {
    expect(existsSync(join(ROOT, VITEST_DOOR))).toBe(true);
    const exemptions = [...(PLAIN_CONFIG_EXEMPTIONS as Set<string>)];
    expect(exemptions.length).toBeGreaterThanOrEqual(7);
    const unwired = exemptions.filter(
      (config) =>
        !(config in VITEST_CONFIGS_RUNNING_NOTHING) && !vitestConfigWiresDoor(readFileSync(join(ROOT, config), 'utf8')),
    );
    expect(unwired).toEqual([]);
    for (const config of Object.keys(VITEST_CONFIGS_RUNNING_NOTHING)) {
      expect(readFileSync(join(ROOT, config), 'utf8')).toMatch(/include:\s*\[\s*\]/);
    }
  });

  it('wires every tracked node:test script to the node:test door', () => {
    expect(existsSync(join(ROOT, NODE_TEST_DOOR))).toBe(true);
    const manifests = listTrackedFiles(ROOT).files.filter(
      (file: string) => file.endsWith('package.json') && !file.split('/').includes('node_modules'),
    );
    const withNodeTest = manifests.filter((file: string) =>
      Object.values((JSON.parse(readFileSync(join(ROOT, file), 'utf8')).scripts ?? {}) as Record<string, string>).some(
        (command) => NODE_TEST_SCRIPT.test(command),
      ),
    );
    // Positive control: the census reaches into submodules, so it cannot pass by seeing nothing.
    expect(withNodeTest).toEqual(expect.arrayContaining(['papercusp-desktop/package.json', 'libs/papercusp/packages/cli/package.json']));
    const findings: string[] = [];
    for (const file of withNodeTest) {
      if (file in NODE_TEST_PACKAGES_EXCLUDED) continue;
      const pkgDir = dirname(join(ROOT, file));
      const scripts = JSON.parse(readFileSync(join(ROOT, file), 'utf8')).scripts as Record<string, string>;
      const missing = nodeTestScriptsMissingDoor(scripts, (setup) => {
        const path = join(pkgDir, setup);
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      });
      findings.push(...missing.map((name) => `${file}#${name}`));
    }
    expect(findings).toEqual([]);
    for (const excluded of Object.keys(NODE_TEST_PACKAGES_EXCLUDED)) expect(withNodeTest).toContain(excluded);
  });
});
