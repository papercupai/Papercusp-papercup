import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preparePlaywrightTempDirectory } from '../../../../scripts/ensure-playwright-browsers.mjs';

const OPERATOR_DIR = resolve(__dirname, '../..');
const E2E_DIR = join(OPERATOR_DIR, 'e2e');
// Budget for each Playwright CLI child below. Each child transforms its spec graph through
// Playwright's Babel loader, whose cache (under os.tmpdir(), keyed by file path and content) is
// cold in the gate's isolated checkout. Measured 2026-10-13 (WI-6554700010009809) at load ~380
// on 128 cores: the native-collection graph run took 75.6s with a fresh cache and 13.5s warm, so
// the former 30s cap failed cold gate runs while passing on warm dev trees. 180s mirrors the
// gate's VITEST_UNIT_TIMEOUT_MS budget for cold heavy imports; a real hang still fails, later.
const PLAYWRIGHT_CHILD_TIMEOUT_MS = 180_000;

type WebServerConfig = {
  command?: string;
  url?: string;
  reuseExistingServer?: boolean;
  stdout?: string;
  stderr?: string;
  env?: Record<string, string | undefined>;
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Playwright temporary allocation admission (EI-25339618434256268)', () => {
  it('loads the combined browser and native collection graph as ESM with the production reporter', () => {
    const listing = execFileSync(process.execPath, [
      require.resolve('@playwright/test/cli'), 'test', '--config', 'playwright.config.mts', '--list',
      'e2e/ongoing-work-ui.spec.ts', 'e2e/ongoing-work-native-collection.spec.mts', '--reporter=list',
    ], { cwd: OPERATOR_DIR, encoding: 'utf8', timeout: PLAYWRIGHT_CHILD_TIMEOUT_MS });
    expect(listing).toContain('native collection fixture writer graph loads');
    expect(listing).toContain('native declared collections persist controls');
    expect(listing).toContain('declared plans collection preserves owner order');
    expect(listing).toContain('declared tea collection preserves owner order');
    const tsconfig = readFileSync(join(OPERATOR_DIR, 'tsconfig.json'), 'utf8');
    expect(tsconfig).toContain('"**/*.mts"');
    const reporterPackage = JSON.parse(readFileSync(join(OPERATOR_DIR, 'test/reporters/package.json'), 'utf8'));
    expect(reporterPackage.type).toBe('module');
    expect(JSON.parse(readFileSync(join(E2E_DIR, 'package.json'), 'utf8')).type).toBe('module');
    const run = execFileSync(process.execPath, [
      require.resolve('@playwright/test/cli'), 'test', '--config', 'playwright.config.mts',
      'e2e/ongoing-work-ui.spec.ts', 'e2e/ongoing-work-native-collection.spec.mts', '--workers=1',
      '--grep', 'native collection fixture writer graph loads',
    ], { cwd: OPERATOR_DIR, encoding: 'utf8', timeout: PLAYWRIGHT_CHILD_TIMEOUT_MS,
      env: { ...process.env, OPERATOR_E2E_REUSE_SERVER: '1', OPERATOR_E2E_SKIP_WARMUP: '1',
        PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '0' } });
    expect(run).toMatch(/1 passed/);
  }, 2 * PLAYWRIGHT_CHILD_TIMEOUT_MS + 10_000);

  const healthy = { type: 1, bsize: 4096, blocks: 1048576, bfree: 1048576, bavail: 1048576, files: 10000, ffree: 9000 };

  it('redirects parent profile and Chromium allocations from a full temp volume to a healthy cache', () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/full', XDG_CACHE_HOME: '/healthy' };
    const result = preparePlaywrightTempDirectory({
      env, mkdir: vi.fn(), access: vi.fn(),
      statfs: vi.fn(path => path === '/full' ? { ...healthy, bavail: 12 } : healthy) as unknown as typeof import('node:fs').statfsSync,
    });
    expect(result.path).toBe('/healthy/papercusp/playwright-tmp');
    expect(result.usedFallback).toBe(true);
    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([result.path, result.path, result.path]);
  });

  it('admits a healthy explicit directory without touching the fallback', () => {
    const mkdir = vi.fn();
    const result = preparePlaywrightTempDirectory({
      env: { TMPDIR: '/explicit' }, mkdir, access: vi.fn(),
      statfs: vi.fn(() => healthy) as unknown as typeof import('node:fs').statfsSync,
    });
    expect(result.path).toBe('/explicit');
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('refuses unmeasured, inode-exhausted and unwritable volumes before browser launch', () => {
    for (const failure of ['capacity', 'inodes', 'permission', 'measurement']) {
      const env = { TMPDIR: '/bad', XDG_CACHE_HOME: '/also-bad' };
      expect(() => preparePlaywrightTempDirectory({
        env, mkdir: vi.fn(),
        access: () => { if (failure === 'permission') throw new Error('EACCES'); },
        statfs: vi.fn(() => {
          if (failure === 'measurement') throw new Error('EIO');
          return { ...healthy, bavail: failure === 'capacity' ? 0 : healthy.bavail, ffree: failure === 'inodes' ? 0 : healthy.ffree };
        }) as unknown as typeof import('node:fs').statfsSync,
      })).toThrow(/No writable Playwright temporary directory/);
      expect(env).toEqual({ TMPDIR: '/bad', XDG_CACHE_HOME: '/also-bad' });
    }
  });
});

describe('Playwright isolated webServer contract', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('preflights browser temp headroom before the default and inherited hosted profiles load', () => {
    for (const name of ['playwright.config.mts', 'playwright.hosted-http1.config.ts']) {
      const source = readFileSync(join(OPERATOR_DIR, name), 'utf8');
      expect(source).toContain("from '../../scripts/lib/playwright-temp-directory.cjs'");
      expect(source.indexOf('preparePlaywrightTempDirectory();')).toBeGreaterThan(0);
      expect(source.indexOf('preparePlaywrightTempDirectory();')).toBeLessThan(source.indexOf('defineConfig({'));
    }
    expect(readFileSync(join(OPERATOR_DIR, 'playwright.hosted-workspace.config.ts'), 'utf8'))
      .toContain('...transportProfile');
  });

  it('loads the preflight through Playwright native config transformation before collecting specs', () => {
    const listing = execFileSync(process.execPath, [
      require.resolve('@playwright/test/cli'), 'test', '--config', 'playwright.config.mts', '--list', 'e2e/plan-audit.spec.ts', '--reporter=list',
    ], { cwd: OPERATOR_DIR, encoding: 'utf8', timeout: PLAYWRIGHT_CHILD_TIMEOUT_MS });
    expect(listing).toContain('sidebar audit opens report, navigates evidence, and reopens history');
    expect(listing).toMatch(/Total: 1 test in 1 file/);
  }, PLAYWRIGHT_CHILD_TIMEOUT_MS + 10_000);

  it('passes the selected port strictly and preserves Vite startup diagnostics', async () => {
    const previousPort = process.env.OPERATOR_E2E_PORT;
    const previousBaseUrl = process.env.OPERATOR_E2E_BASE_URL;
    const previousReuse = process.env.OPERATOR_E2E_REUSE_SERVER;

    process.env.OPERATOR_E2E_PORT = '43179';
    delete process.env.OPERATOR_E2E_BASE_URL;
    delete process.env.OPERATOR_E2E_REUSE_SERVER;
    vi.resetModules();

    try {
      const { default: config } = await import('../../playwright.config.mts');
      const webServer = config.webServer;
      expect(webServer).not.toBeUndefined();
      expect(Array.isArray(webServer)).toBe(false);

      const server = webServer as WebServerConfig;
      expect(server.command).toBe('npm run dev -- -- --port 43179 --strictPort');
      expect(server.url).toBe('http://localhost:43179');
      expect(server.reuseExistingServer).toBe(false);
      expect(server.stdout).toBe('pipe');
      expect(server.stderr).toBe('pipe');
      // HMR on (the SPA needs the real /@vite/client) but the file watcher OFF,
      // so a peer's edit to the shared tree cannot reload test pages mid-run
      // (WI-10006950).
      expect(server.env?.PAPERCUSP_ENABLE_HMR).toBe('1');
      expect(server.env?.PAPERCUSP_DEV_WATCH).toBe('0');
    } finally {
      restoreEnv('OPERATOR_E2E_PORT', previousPort);
      restoreEnv('OPERATOR_E2E_BASE_URL', previousBaseUrl);
      restoreEnv('OPERATOR_E2E_REUSE_SERVER', previousReuse);
    }
  });
});

describe('ongoing-work artifact acceptance profile', () => {
  it('requires an explicit supported artifact and never starts an unrelated Vite server', async () => {
    const previousBaseURL = process.env.OPERATOR_E2E_BASE_URL;
    const previousSha = process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA;

    try {
      process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA = '0123456789';
      delete process.env.OPERATOR_E2E_BASE_URL;
      vi.resetModules();
      await expect(import('../../playwright.ongoing-work.config')).rejects.toThrow(/OPERATOR_E2E_BASE_URL/);

      process.env.OPERATOR_E2E_BASE_URL = 'http://127.0.0.1:3170';
      delete process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA;
      vi.resetModules();
      await expect(import('../../playwright.ongoing-work.config')).rejects.toThrow(/PAPERCUSP_ONGOING_ACCEPTANCE_SHA/);

      process.env.OPERATOR_E2E_BASE_URL = 'http://localhost:3424';
      process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA = '0123456789';
      vi.resetModules();
      await expect(import('../../playwright.ongoing-work.config')).rejects.toThrow(/:3170.*:3070/);

      process.env.OPERATOR_E2E_BASE_URL = 'http://127.0.0.1:3170';
      vi.resetModules();
      const { default: config } = await import('../../playwright.ongoing-work.config');
      expect(config.use?.baseURL).toBe('http://127.0.0.1:3170');
      expect(config.webServer).toBeUndefined();
    } finally {
      restoreEnv('OPERATOR_E2E_BASE_URL', previousBaseURL);
      restoreEnv('PAPERCUSP_ONGOING_ACCEPTANCE_SHA', previousSha);
      vi.resetModules();
    }
  });
});

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * Profile configs are read as SOURCE, never imported: a profile config may
 * validate its credentials at load (playwright.hosted-http1.config.ts throws
 * without PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE), which is the very failure
 * this guard keeps out of the default run.
 */
function profileTestMatches(): Array<{ config: string; testMatch: RegExp }> {
  return readdirSync(OPERATOR_DIR)
    .filter((name) => /^playwright\.[a-z0-9-]+\.config\.ts$/.test(name))
    .flatMap((config) => {
      const source = readFileSync(join(OPERATOR_DIR, config), 'utf8');
      const match = /testMatch:\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)/.exec(source);
      return match ? [{ config, testMatch: new RegExp(match[1], match[2]) }] : [];
    });
}

describe('default Playwright run never collects a profile-owned spec (WI-10006736)', () => {
  it('ignores every e2e file a playwright.<profile>.config.ts selects', async () => {
    const { default: config } = await import('../../playwright.config.mts');
    const testMatch = config.testMatch as RegExp;
    const testIgnore = (config.testIgnore ?? []) as RegExp[];
    const collectedByDefault = (file: string) =>
      testMatch.test(file) && !testIgnore.some((pattern) => pattern.test(file));

    const profiles = profileTestMatches();
    // Positive control: the extractor must find the profile that motivated this
    // guard, or every assertion below passes vacuously.
    expect(profiles.map((p) => p.config)).toContain('playwright.hosted-http1.config.ts');

    const files = listFiles(E2E_DIR);
    const owned = files.filter((file) => profiles.some((p) => p.testMatch.test(file)));
    expect(owned.map((file) => file.slice(E2E_DIR.length + 1))).toContain(
      'hosted-http1-acceptance.spec.ts',
    );

    // Control: testMatch ALONE does collect a profile-owned spec, so the
    // testIgnore below is load-bearing and removing it turns this guard red.
    expect(owned.filter((file) => testMatch.test(file))).not.toEqual([]);

    const leaked = owned.filter(collectedByDefault).map((file) => file.slice(E2E_DIR.length + 1));
    expect(leaked).toEqual([]);
  });

  it('every spec that fetches from inside the page first puts the page on the app origin', () => {
    // The fixture page starts on about:blank (an opaque origin) and the API sends
    // no CORS headers, so an in-page fetch without a prior navigation fails with
    // "TypeError: Failed to fetch" and the spec measures nothing (WI-10006736).
    const fetchesInPage = (source: string) => /page\.evaluate\(/.test(source) && /\bfetch\(/.test(source);
    const navigatesFirst = (source: string) => /\bonAppOrigin\(|\.goto\(/.test(source);

    // Control: the predicate flags the exact shape that was broken.
    const brokenShape = "const r = await page.evaluate(async (u) => { await fetch(u); }, url);";
    expect(fetchesInPage(brokenShape) && !navigatesFirst(brokenShape)).toBe(true);

    const specs = listFiles(E2E_DIR).filter((file) => file.endsWith('.spec.ts'));
    const inPageFetchers = specs.filter((file) => fetchesInPage(readFileSync(file, 'utf8')));
    const names = (list: string[]) => list.map((file) => file.slice(E2E_DIR.length + 1)).sort();
    // Positive control: the detector still sees the specs it was written for.
    expect(names(inPageFetchers)).toEqual(
      expect.arrayContaining(['sse-last-event-id.spec.ts', 'state-snapshot-sse.spec.ts']),
    );

    const unnavigated = inPageFetchers.filter((file) => !navigatesFirst(readFileSync(file, 'utf8')));
    expect(names(unnavigated)).toEqual([]);
  });

  it('every spec that reads the superuser token resolves PAPERCUSP_HOME first', async () => {
    // An isolated operator (VERIFY_TAURI_ISOLATED_DB=1) has its own PAPERCUSP_HOME,
    // so a spec that hard-codes ~/.papercusp sends a foreign bearer and the
    // verified-only routes answer 403 (WI-10006736, admin-routes.spec.ts).
    const readsSuToken = (source: string) => /['"]superuser-token['"]/.test(source);
    const { readPlanAuditReleaseConfig } = await import('../../e2e/_plan-audit-release-config');
    const release = readPlanAuditReleaseConfig({
      PAPERCUSP_PLAN_AUDIT_RELEASE_SHA: 'a'.repeat(40),
      PAPERCUSP_PLAN_AUDIT_RELEASE_RECEIPT: 'fixture-receipt',
      PAPERCUSP_WORKSPACE: 'fixture-workspace', PAPERCUSP_SID: 'fixture-client',
      PAPERCUSP_HOME: '/fixture/isolated-home',
    });
    // Verify the maintained helper's behavior before accepting a reader that
    // delegates to it. Merely importing it cannot excuse a hard-coded path.
    expect(release.home).toBe('/fixture/isolated-home');
    const { readEngineeringJourneyConfig } = await import('../../e2e/_engineering-evidence-journey-config');
    const fixtureDir = mkdtempSync(join(tmpdir(), 'playwright-home-config-'));
    try {
      const inputsPath = join(fixtureDir, 'journey.json');
      writeFileSync(inputsPath, JSON.stringify({
        workspaceId: 'fixture-workspace', clientId: 'fixture-client', buildSha: 'a'.repeat(40),
        plan: 'fixture-plan', item: 'P-001', harness: 'papercusp',
        symbol: { path: 'src/feature.ts', name: 'feature' }, spec: { id: 'EE-1', revision: 1 }, decisionId: 'D-001',
        runId: 1, caseKey: 'fixture-case', occurrence: 1,
        observation: { invocationId: 'fixture-invocation', traceId: 'b'.repeat(32), spanId: 'c'.repeat(16),
          sourceFingerprint: 'd'.repeat(64), artifactFingerprint: 'e'.repeat(64), environmentFingerprint: 'f'.repeat(64) },
        sourcePins: [{ path: 'src/feature.ts', sha256: 'd'.repeat(64) }],
        stale: { plan: 'fixture-plan', item: 'P-002' }, unobserved: { plan: 'fixture-plan', item: 'P-003' },
      }));
      expect(readEngineeringJourneyConfig({
        PAPERCUSP_ENGINEERING_PLANE: 'current-build', PAPERCUSP_ENGINEERING_JOURNEY_INPUTS: inputsPath,
        PAPERCUSP_HOME: '/fixture/isolated-home',
      }).home).toBe('/fixture/isolated-home');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
    const delegatedReaders = [
      { name: 'readPlanAuditReleaseConfig', module: '_plan-audit-release-config' },
      { name: 'readEngineeringJourneyConfig', module: '_engineering-evidence-journey-config' },
    ];
    const resolvesHome = (source: string) => {
      if (/process\.env\.PAPERCUSP_HOME/.test(source)) return true;
      return delegatedReaders.some((reader) => {
        const imported = new RegExp('import\\s*\\{[^}]*\\b' + reader.name + '\\b[^}]*\\}\\s*from\\s*[\'\"]\\./' + reader.module + '[\'\"]').test(source);
        const binding = new RegExp('const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*' + reader.name + '\\(\\)').exec(source);
        return !!(imported && binding && new RegExp(`join\\(\\s*${binding[1].replace(/\$/g, '\\$')}\\.home\\s*,\\s*['"]superuser-token['"]`).test(source));
      });
    };

    // Control: the predicate flags the exact shape that was broken.
    const brokenShape = "readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8')";
    expect(readsSuToken(brokenShape) && !resolvesHome(brokenShape)).toBe(true);
    const delegatedShape = "import { readPlanAuditReleaseConfig } from './_plan-audit-release-config'; const release = readPlanAuditReleaseConfig(); readFileSync(join(release.home, 'superuser-token'), 'utf8');";
    expect(readsSuToken(delegatedShape) && resolvesHome(delegatedShape)).toBe(true);
    expect(resolvesHome(delegatedShape.replace('join(release.home,', "join('/hard-coded',"))).toBe(false);
    const engineeringShape = "import { readEngineeringJourneyConfig } from './_engineering-evidence-journey-config'; const config = readEngineeringJourneyConfig(); readFileSync(join(config.home, 'superuser-token'), 'utf8');";
    expect(readsSuToken(engineeringShape) && resolvesHome(engineeringShape)).toBe(true);
    expect(resolvesHome(engineeringShape.replace('join(config.home,', "join('/hard-coded',"))).toBe(false);
    expect(resolvesHome(engineeringShape.replace('./_engineering-evidence-journey-config', './unverified-config'))).toBe(false);

    const specs = listFiles(E2E_DIR).filter((file) => file.endsWith('.ts'));
    const names = (list: string[]) => list.map((file) => file.slice(E2E_DIR.length + 1)).sort();
    const tokenReaders = specs.filter((file) => readsSuToken(readFileSync(file, 'utf8')));
    // Positive control: the detector still sees the spec it was written for.
    expect(names(tokenReaders)).toContain('admin-routes.spec.ts');

    const hardCoded = tokenReaders.filter((file) => !resolvesHome(readFileSync(file, 'utf8')));
    expect(names(hardCoded)).toEqual([]);
  });

  it('warms the dev server in globalSetup, and the warm-up is never collected as a spec (WI-10006792)', async () => {
    const { default: config } = await import('../../playwright.config.mts');
    const setup = config.globalSetup;
    expect(typeof setup).toBe('string');
    const setupPath = resolve(OPERATOR_DIR, setup as string);
    expect(setupPath).toBe(join(E2E_DIR, '_warm-dev-server.ts'));
    const mod = await import(setupPath);
    expect(typeof mod.default).toBe('function');
    expect(mod.WARMUP_PATHS).toContain('/adv');
    const testMatch = config.testMatch as RegExp;
    expect(testMatch.test(setupPath)).toBe(false);
  });

  it('still collects ordinary specs (the ignore list is not over-broad)', async () => {
    const { default: config } = await import('../../playwright.config.mts');
    const testMatch = config.testMatch as RegExp;
    const testIgnore = (config.testIgnore ?? []) as RegExp[];
    const ordinary = join(E2E_DIR, 'desktop-grid.spec.ts');
    expect(testMatch.test(ordinary)).toBe(true);
    expect(testIgnore.some((pattern) => pattern.test(ordinary))).toBe(false);
  });
});
