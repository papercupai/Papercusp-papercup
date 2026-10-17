import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const GENERIC_ROOT = join(REPO_ROOT, 'libs/generic');
const VITEST_CONFIG_RE = /^vitest\.config\.[^/]+$/;
const RECORDED_LAYER_RE =
  /\bpapercuspTestLayer\s*:\s*['"](?:unit|integration|e2e|llm|browser)['"]/;
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
      return RECORDED_LAYER_RE.test(readFileSync(configPath, 'utf8'))
        ? []
        : ['libs/generic/' + name + '/vitest.config.ts'];
    });
    expect(unenrolled).toEqual([]);
  });
});
