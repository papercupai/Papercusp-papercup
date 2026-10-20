import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const GENERIC_ROOT = join(REPO_ROOT, 'libs/generic');
const VITEST_CONFIG_RE = /^vitest\.config\.[^/]+$/;
const LAYER_VALUE = String.raw`['"](?:unit|integration|e2e|llm|browser)['"]`;
// Two explicit forms record a layer: a hand-rolled `provide: { papercuspTestLayer: '<layer>' }`,
// or the shared helper `defineVitestConfig({ layer: '<layer>' })`, which provides it for you
// (WI-6554700010018003 moved 13 of these packages onto the helper).
const RECORDED_LAYER_RE = new RegExp(String.raw`\bpapercuspTestLayer\s*:\s*` + LAYER_VALUE);
const HELPER_LAYER_RE = new RegExp(
  String.raw`\bdefineVitestConfig\s*\(\s*\{[^]*?\blayer\s*:\s*` + LAYER_VALUE,
);
const HELPER_SOURCE = join(REPO_ROOT, 'libs/test-config/src/vitest-config.ts');
const HELPER_PROVIDES_LAYER_RE = /\bprovide\s*:\s*\{\s*papercuspTestLayer\s*:\s*layer\s*\}/;
const CLASS_FIX_PACKAGES = [
  'audio-dsp', 'bench-metrics', 'cache', 'control-mutation', 'debounce-coalesce',
  'dependency-order', 'desktop-ipc', 'embedded-pg-discovery', 'facets', 'image-blankness',
  'ipc-framing', 'memory', 'model-pricing', 'module-singleton', 'overlap-clusters',
  'p2p-voice', 'prospect-contract', 'rate-limit', 'rerank', 'result-encoding',
  'resumable-download', 'scheduled-registry', 'seed-bundle', 'sequence-patterns',
  'structured-concurrency',
];

function configlessVitestPackages(): string[] {
  return readdirSync(GENERIC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const packageDir = join(GENERIC_ROOT, name);
      const packageJsonPath = join(packageDir, 'package.json');
      if (!existsSync(packageJsonPath)) return false;
      let packageJson: { scripts?: { test?: unknown } };
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as typeof packageJson;
      } catch {
        return false;
      }
      const testScript = packageJson.scripts?.test;
      const hasVitestTestScript = typeof testScript === 'string' && /\bvitest\b/.test(testScript);
      const hasVitestConfig = readdirSync(packageDir).some((entry) => VITEST_CONFIG_RE.test(entry));
      return hasVitestTestScript && !hasVitestConfig;
    })
    .sort();
}

describe('config-less generic Vitest enrollment', () => {
  it('does not leave a package without a recorded test layer', () => {
    const missing = configlessVitestPackages().map((name) => 'libs/generic/' + name);
    expect(missing).toEqual([]);
  });

  it('keeps every generic package config explicit about its recorded layer', () => {
    const unenrolled = CLASS_FIX_PACKAGES.flatMap((name) => {
      const packageDir = join(GENERIC_ROOT, name);
      const configPath = join(packageDir, 'vitest.config.ts');
      if (!existsSync(configPath)) return ['libs/generic/' + name + '/vitest.config.ts (missing)'];
      const source = readFileSync(configPath, 'utf8');
      return RECORDED_LAYER_RE.test(source) || HELPER_LAYER_RE.test(source)
        ? []
        : ['libs/generic/' + name + '/vitest.config.ts'];
    });
    expect(unenrolled).toEqual([]);
  });

  it('accepts the helper form only while defineVitestConfig still provides the layer it is given', () => {
    // The helper form is explicit only because the helper forwards `layer` as the recorded
    // papercuspTestLayer; if that forwarding goes, the accepted configs stop recording a layer.
    expect(HELPER_PROVIDES_LAYER_RE.test(readFileSync(HELPER_SOURCE, 'utf8'))).toBe(true);
    expect(HELPER_LAYER_RE.test("defineVitestConfig({ include: ['x'], layer: 'unit' })")).toBe(true);
    expect(HELPER_LAYER_RE.test("defineVitestConfig({ layer: 'bogus' })")).toBe(false);
    expect(HELPER_LAYER_RE.test("defineConfig({ test: { layer: 'unit' } })")).toBe(false);
  });
});
