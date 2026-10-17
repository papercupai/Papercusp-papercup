/**
 * Coverage for embedded-pg-discovery — the operator's wiring over the generic
 * resolvePgUrl: it relabels the generic 'fallback' source to the historical
 * 'native-fallback', passes other sources through, and caches the resolution
 * (one resolve until reset). The generic resolver is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const resolvePgUrl = vi.fn();
const canonicalOperatorEnv = vi.fn();
vi.mock('@papercusp/db-org/operator-db-env', () => ({
  readOperatorDbEnvLocal: (...a: unknown[]) => canonicalOperatorEnv(...a),
}));
vi.mock('@papercusp/embedded-pg-discovery', () => ({
  resolvePgUrl: (...a: unknown[]) => resolvePgUrl(...a),
}));

import {
  getHarnessAdminUrl,
  getHarnessAdminUrlWithSource,
  _resetHarnessAdminUrlCacheForTests,
} from './embedded-pg-discovery';

beforeEach(() => {
  _resetHarnessAdminUrlCacheForTests();
  resolvePgUrl.mockReset();
  canonicalOperatorEnv.mockReset().mockReturnValue({});
  for (const key of ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL', 'PAPERCUSP_HOME']) {
    vi.stubEnv(key, undefined as unknown as string);
  }
  vi.stubEnv('PAPERCUSP_PG_PORT', undefined as unknown as string);
  vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', undefined as unknown as string);
});

afterEach(() => vi.unstubAllEnvs());

describe('getHarnessAdminUrlWithSource', () => {
  it('imports the real script URL resolver in native Node without loading ORM/schema modules', () => {
    const moduleUrl = new URL('../../../scripts/lib/pg-url.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(moduleUrl)}); process.stdout.write('native-import-ok');`], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('native-import-ok');
  });

  it('uses the same operator env-file pin as getOrgPg before a foreign desktop discovery target', () => {
    canonicalOperatorEnv.mockReturnValue({ DATABASE_URL: 'postgres://operator-env/papercusp' });
    resolvePgUrl.mockReturnValue({ url: 'postgres://foreign-desktop:18058/papercusp', source: 'discovery' });
    expect(getHarnessAdminUrlWithSource()).toEqual({ url: 'postgres://operator-env/papercusp', source: 'operator-env-file' });
    expect(resolvePgUrl).not.toHaveBeenCalled();
  });

  it.each(['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL', 'PAPERCUSP_PG_PORT', 'PAPERCUSP_SKIP_PG_DISCOVERY', 'PAPERCUSP_HOME'])(
    'preserves the existing explicit/isolated resolver when %s is set', key => {
      vi.stubEnv(key, key === 'PAPERCUSP_SKIP_PG_DISCOVERY' ? '1' : 'custom');
      canonicalOperatorEnv.mockReturnValue({ DATABASE_URL: 'postgres://operator-env/papercusp' });
      resolvePgUrl.mockReturnValue({ url: 'postgres://isolated/papercusp', source: 'env' });
      expect(getHarnessAdminUrl()).toBe('postgres://isolated/papercusp');
      expect(canonicalOperatorEnv).not.toHaveBeenCalled();
    },
  );

  it('passes through a non-fallback source', () => {
    resolvePgUrl.mockReturnValue({ url: 'postgres://env/db', source: 'env' });
    expect(getHarnessAdminUrlWithSource()).toEqual({ url: 'postgres://env/db', source: 'env' });
    expect(getHarnessAdminUrl()).toBe('postgres://env/db');
  });

  it("relabels the generic 'fallback' to 'native-fallback'", () => {
    resolvePgUrl.mockReturnValue({ url: 'postgres://localhost:5432/papercusp', source: 'fallback' });
    expect(getHarnessAdminUrlWithSource().source).toBe('native-fallback');
  });

  it('uses PAPERCUSP_PG_PORT for an isolated native fallback', () => {
    vi.stubEnv('PAPERCUSP_PG_PORT', '19532');
    resolvePgUrl.mockImplementation((config: { fallbackUrl: string }) => ({
      url: config.fallbackUrl,
      source: 'fallback',
    }));

    expect(getHarnessAdminUrlWithSource()).toEqual({
      url: 'postgresql://harness_admin:harness_admin_pwd@localhost:19532/papercusp',
      source: 'native-fallback',
    });
  });

  it('skips discovery when PAPERCUSP_SKIP_PG_DISCOVERY=1', () => {
    vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', '1');
    resolvePgUrl.mockImplementation((config: { fallbackUrl: string }) => ({
      url: config.fallbackUrl,
      source: 'fallback',
    }));

    expect(getHarnessAdminUrlWithSource()).toEqual({
      url: 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp',
      source: 'native-fallback',
    });
    expect(resolvePgUrl).toHaveBeenCalledWith(
      expect.objectContaining({ discoveryFile: undefined }),
    );
  });

  it('re-resolves the isolated fallback when PAPERCUSP_PG_PORT changes', () => {
    resolvePgUrl.mockImplementation((config: { fallbackUrl: string }) => ({
      url: config.fallbackUrl,
      source: 'fallback',
    }));
    vi.stubEnv('PAPERCUSP_PG_PORT', '19532');
    expect(getHarnessAdminUrl()).toContain(':19532/');
    vi.stubEnv('PAPERCUSP_PG_PORT', '19533');
    expect(getHarnessAdminUrl()).toContain(':19533/');
    expect(resolvePgUrl).toHaveBeenCalledTimes(2);
  });

  it('caches the resolution (resolves once until reset)', () => {
    resolvePgUrl.mockReturnValue({ url: 'postgres://x', source: 'env' });
    getHarnessAdminUrl();
    getHarnessAdminUrl();
    expect(resolvePgUrl).toHaveBeenCalledTimes(1);
    _resetHarnessAdminUrlCacheForTests();
    getHarnessAdminUrl();
    expect(resolvePgUrl).toHaveBeenCalledTimes(2);
  });

  it('never PINS the fallback — an import-time resolve before serve injects the env URL heals on the next call (WI-1544 rig: invalidator wedged on dead :5432)', () => {
    // 1st call: nothing set yet (module-scope caller at import time) → fallback.
    resolvePgUrl.mockReturnValue({ url: 'postgres://localhost:5432/papercusp', source: 'fallback' });
    expect(getHarnessAdminUrlWithSource().source).toBe('native-fallback');
    // serve.ts has since booted embedded PG + injected HARNESS_ADMIN_DATABASE_URL.
    resolvePgUrl.mockReturnValue({ url: 'postgres://localhost:39532/papercusp', source: 'env' });
    expect(getHarnessAdminUrlWithSource()).toEqual({
      url: 'postgres://localhost:39532/papercusp',
      source: 'env',
    });
    // …and the non-fallback result IS pinned from here on.
    getHarnessAdminUrl();
    expect(resolvePgUrl).toHaveBeenCalledTimes(2);
  });

  it('never PINS a discovery resolve — a stale early discovery-file read heals when embedded-pg.json is rewritten with this launch’s fresh port (Windows sync-sse ECONNREFUSED-forever bug, 2026-07-02)', () => {
    // Early boot: a module-scope LISTEN consumer (sync-sse) resolves BEFORE serve
    // rewrites embedded-pg.json this launch → it reads the PRIOR launch's stale port
    // (the WSL distro persists embedded-pg.json across launches).
    resolvePgUrl.mockReturnValue({ url: 'postgres://localhost:21186/papercusp', source: 'discovery' });
    expect(getHarnessAdminUrlWithSource()).toEqual({
      url: 'postgres://localhost:21186/papercusp',
      source: 'discovery',
    });
    // serve.ts has since rewritten embedded-pg.json with THIS launch's actual PG port.
    resolvePgUrl.mockReturnValue({ url: 'postgres://localhost:21102/papercusp', source: 'discovery' });
    // The next call MUST re-resolve to the fresh port, not return the pinned stale one —
    // else the LISTEN client retries a dead port for the whole process lifetime.
    expect(getHarnessAdminUrl()).toBe('postgres://localhost:21102/papercusp');
    expect(resolvePgUrl).toHaveBeenCalledTimes(2);
  });

  it('forwards the env-var precedence list + discovery file config', () => {
    resolvePgUrl.mockReturnValue({ url: 'u', source: 'env' });
    getHarnessAdminUrl();
    expect(resolvePgUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'],
      }),
    );
  });
});
