/**
 * Coverage for posthog-config resolution: env override → ~/.papercusp/posthog.json
 * discovery → unconfigured(null), plus the safety-relevant testingFeatures
 * opt-out default (discovered-but-not-opted-in still serves bundled defaults).
 * os.homedir is mocked to a temp home; the discovery file is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), 'phc-')) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => H.home };
});

import {
  getPosthogConfigWithSource,
  getPosthogConfig,
  isTestingFeaturesEnabled,
  resetPosthogConfigForTest,
} from './posthog-config';

const discoveryPath = () => join(H.home, '.papercusp', 'posthog.json');
function writeDiscovery(obj: unknown) {
  mkdirSync(join(H.home, '.papercusp'), { recursive: true });
  writeFileSync(discoveryPath(), JSON.stringify(obj));
}
const ENV = ['PAPERCUSP_POSTHOG_HOST', 'PAPERCUSP_POSTHOG_KEY', 'PAPERCUSP_POSTHOG_PERSONAL_KEY', 'PAPERCUSP_POSTHOG_TESTING_FEATURES'];

beforeEach(() => {
  resetPosthogConfigForTest();
  for (const k of ENV) vi.stubEnv(k, undefined as unknown as string);
  rmSync(discoveryPath(), { force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetPosthogConfigForTest();
});

describe('env override path', () => {
  it('uses env host+key with testingFeatures from the flag', () => {
    vi.stubEnv('PAPERCUSP_POSTHOG_HOST', 'https://ph.example');
    vi.stubEnv('PAPERCUSP_POSTHOG_KEY', 'proj-key');
    vi.stubEnv('PAPERCUSP_POSTHOG_TESTING_FEATURES', 'true');
    expect(getPosthogConfigWithSource()).toEqual({
      config: { host: 'https://ph.example', projectKey: 'proj-key', personalApiKey: 'proj-key' },
      source: 'env',
      testingFeatures: true,
    });
  });

  it('defaults personalApiKey to the project key and testingFeatures to false', () => {
    vi.stubEnv('PAPERCUSP_POSTHOG_HOST', 'https://ph');
    vi.stubEnv('PAPERCUSP_POSTHOG_KEY', 'k');
    const r = getPosthogConfigWithSource();
    expect(r.config?.personalApiKey).toBe('k');
    expect(r.testingFeatures).toBe(false);
  });
});

describe('discovery-file path', () => {
  it("source 'discovery-file' + testingFeatures true when opted in", () => {
    writeDiscovery({ host: 'h', projectKey: 'p', personalApiKey: 'pa', testingFeatures: true });
    const r = getPosthogConfigWithSource();
    expect(r.source).toBe('discovery-file');
    expect(r.testingFeatures).toBe(true);
    expect(r.config).toEqual({ host: 'h', projectKey: 'p', personalApiKey: 'pa' });
  });

  it("source 'discovery-file-opt-out' + testingFeatures false by default", () => {
    writeDiscovery({ host: 'h', projectKey: 'p', personalApiKey: 'pa' });
    const r = getPosthogConfigWithSource();
    expect(r.source).toBe('discovery-file-opt-out');
    expect(r.testingFeatures).toBe(false);
    expect(isTestingFeaturesEnabled()).toBe(false);
  });
});

describe('unconfigured', () => {
  it('returns null when there is no env and no discovery file', () => {
    const r = getPosthogConfigWithSource();
    expect(r).toEqual({ config: null, source: 'unconfigured', testingFeatures: false });
    expect(getPosthogConfig()).toBeNull();
  });

  it('returns null on a malformed discovery file', () => {
    mkdirSync(join(H.home, '.papercusp'), { recursive: true });
    writeFileSync(discoveryPath(), '{ not json');
    expect(getPosthogConfig()).toBeNull();
  });

  it('treats a discovery file missing required keys as unconfigured', () => {
    writeDiscovery({ host: 'h' }); // no projectKey / personalApiKey
    expect(getPosthogConfig()).toBeNull();
  });
});

describe('caching', () => {
  it('caches the resolution until reset', () => {
    writeDiscovery({ host: 'h', projectKey: 'p', personalApiKey: 'pa', testingFeatures: true });
    const first = getPosthogConfig();
    rmSync(discoveryPath(), { force: true }); // would resolve to null if re-read
    expect(getPosthogConfig()).toBe(first); // still cached
  });
});

it('reloads a changed discovery file without keeping its owning process alive', () => {
  const home = mkdtempSync(join(tmpdir(), 'posthog-watch-exit-'));
  const source = new URL('./posthog-config.ts', import.meta.url).href;
  const script = `
    import { watchPosthogConfig, setOnConfigChange } from ${JSON.stringify(source)};
    import { writeFileSync } from 'node:fs';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('discovery change was not observed')), 2000);
      setOnConfigChange(() => { clearTimeout(timeout); console.log('POSTHOG_WATCH_CHANGED'); resolve(); });
      watchPosthogConfig();
      writeFileSync(join(homedir(), '.papercusp', 'posthog.json'), '{"testingFeatures":true}');
    });
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: join(import.meta.dirname, '../../..'), env: { ...process.env, HOME: home },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.stdout, result.stderr).toContain('POSTHOG_WATCH_CHANGED');
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15_000);
