/**
 * build-info (WI-265) — the running checkout's sha + version for deploy-skew
 * diagnosability on /api/health. Tests the pure resolver via injected seams.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, it, expect } from 'vitest';
import { resolveBuildInfo } from './build-info';

describe('resolveBuildInfo', () => {
  it('prefers PAPERCUSP_BUILD_SHA and never shells out when it is set', () => {
    let gitCalled = false;
    const r = resolveBuildInfo({
      env: { PAPERCUSP_BUILD_SHA: 'abc1234', npm_package_version: '1.2.3' } as NodeJS.ProcessEnv,
      gitSha: () => { gitCalled = true; return 'should-not-be-used'; },
    });
    expect(r).toEqual({ sha: 'abc1234', version: '1.2.3' });
    expect(gitCalled).toBe(false);
  });

  it('falls back to git rev-parse when no env sha', () => {
    const r = resolveBuildInfo({ env: { npm_package_version: '1.2.3' } as NodeJS.ProcessEnv, gitSha: () => 'deadbee' });
    expect(r).toEqual({ sha: 'deadbee', version: '1.2.3' });
  });

  it('null sha (best-effort) when git resolution throws — never breaks /api/health', () => {
    const r = resolveBuildInfo({ env: {} as NodeJS.ProcessEnv, gitSha: () => { throw new Error('not a git repo'); } });
    expect(r.sha).toBeNull();
    expect(r.version).toBe('0.0.0'); // default when npm_package_version unset
  });

  it('null sha when git returns empty', () => {
    expect(resolveBuildInfo({ env: {} as NodeJS.ProcessEnv, gitSha: () => '' }).sha).toBeNull();
  });

  it('trims a whitespace env sha', () => {
    expect(resolveBuildInfo({ env: { PAPERCUSP_BUILD_SHA: '  feed123  ' } as NodeJS.ProcessEnv }).sha).toBe('feed123');
  });

  // WI-2644: packaged desktop sidecar has no npm_package_version in its env
  // (serve.mjs isn't invoked by npm) — PAPERCUSP_BUILD_VERSION is the fix.
  describe('PAPERCUSP_BUILD_VERSION (WI-2644 — desktop version stamping)', () => {
    it('prefers PAPERCUSP_BUILD_VERSION over npm_package_version when both are set', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_VERSION: '0.0.2', npm_package_version: '0.0.1' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
      });
      expect(r.version).toBe('0.0.2');
    });

    it('falls back to npm_package_version when PAPERCUSP_BUILD_VERSION is unset', () => {
      const r = resolveBuildInfo({
        env: { npm_package_version: '1.2.3' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
      });
      expect(r.version).toBe('1.2.3');
    });

    it('falls back to 0.0.0 when neither is set (packaged sidecar, no override)', () => {
      const r = resolveBuildInfo({ env: {} as NodeJS.ProcessEnv, gitSha: () => 'deadbee' });
      expect(r.version).toBe('0.0.0');
    });

    it('trims a whitespace env version', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_VERSION: '  0.0.2  ' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
      });
      expect(r.version).toBe('0.0.2');
    });

    it('ignores an empty-string PAPERCUSP_BUILD_VERSION and falls back', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_VERSION: '   ', npm_package_version: '1.2.3' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
      });
      expect(r.version).toBe('1.2.3');
    });
  });

  // EI-18751304112302229: the WI-2644 bake used --define:process.env.npm_package_version,
  // which esbuild can only match as a literal member expression — this file never
  // writes that expression verbatim (it reads through the `opts.env ?? process.env`
  // seam alias), so the define had nothing to rewrite and the bake was silently a
  // no-op on every packaged build not launched via main.rs's PAPERCUSP_BUILD_VERSION
  // forward. Fixed by baking a dedicated `__PAPERCUSP_SIDECAR_VERSION__` global
  // (matching the __PAPERCUSP_BUNDLED_SIDECAR__ idiom) and reading it directly —
  // exercised here via the `bakedVersion` test seam (the real global is injected by
  // esbuild --define and is `undefined` under vitest).
  describe('bakedVersion / __PAPERCUSP_SIDECAR_VERSION__ (EI-18751304112302229)', () => {
    it('falls back to bakedVersion when neither env var is set', () => {
      const r = resolveBuildInfo({
        env: {} as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
        bakedVersion: '0.0.13',
      });
      expect(r.version).toBe('0.0.13');
    });

    it('prefers PAPERCUSP_BUILD_VERSION over bakedVersion when both are set', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_VERSION: '0.0.14' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
        bakedVersion: '0.0.13',
      });
      expect(r.version).toBe('0.0.14');
    });

    it('prefers bakedVersion over npm_package_version', () => {
      const r = resolveBuildInfo({
        env: { npm_package_version: '0.0.1' } as NodeJS.ProcessEnv,
        gitSha: () => 'deadbee',
        bakedVersion: '0.0.13',
      });
      expect(r.version).toBe('0.0.13');
    });

    it('falls back to 0.0.0 when bakedVersion, PAPERCUSP_BUILD_VERSION, and npm_package_version are all unset', () => {
      const r = resolveBuildInfo({ env: {} as NodeJS.ProcessEnv, gitSha: () => 'deadbee' });
      expect(r.version).toBe('0.0.0');
    });
  });

  describe('bakedSha / __PAPERCUSP_BUNDLED_SOURCE_SHA__ (EI-21647996938145436)', () => {
    it('prefers the bundle-time source SHA when no deploy env SHA is present', () => {
      const r = resolveBuildInfo({
        env: { npm_package_version: '1.2.3' } as NodeJS.ProcessEnv,
        gitSha: () => 'checkout-head',
        bakedSha: 'bundle-sha',
        bundled: true,
      });
      expect(r).toEqual({ sha: 'bundle-sha', version: '1.2.3' });
    });

    it('prefers the baked source SHA over a stale PAPERCUSP_BUILD_SHA', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_SHA: 'stale-env-sha' } as NodeJS.ProcessEnv,
        gitSha: () => 'checkout-head',
        bakedSha: 'bundle-sha',
        bundled: true,
      });
      expect(r.sha).toBe('bundle-sha');
    });

    it('falls back to PAPERCUSP_BUILD_SHA when a bundled artifact has no baked SHA', () => {
      const r = resolveBuildInfo({
        env: { PAPERCUSP_BUILD_SHA: 'env-sha' } as NodeJS.ProcessEnv,
        gitSha: () => 'checkout-head',
        bundled: true,
      });
      expect(r.sha).toBe('env-sha');
    });

    it('does not borrow the current checkout SHA for an identity-less bundle', () => {
      const r = resolveBuildInfo({
        env: {} as NodeJS.ProcessEnv,
        gitSha: () => 'current-checkout-head',
        bundled: true,
      });
      expect(r.sha).toBeNull();
    });
  });
});

describe('bundled /api/health build identity', () => {
  it('serves the artifact SHA when the process environment contains an older SHA', async () => {
    const root = resolve(__dirname, '../../..');
    const healthRoute = resolve(root, 'packages/operator-core/lib/endpoint-route/routes/misc/health.ts');
    const dir = mkdtempSync(join(tmpdir(), 'build-info-health-bundle-'));
    const outfile = join(dir, 'health-host.mjs');
    const bundleSha = 'bundle-sha-7f31c2';
    try {
      await build({
        stdin: {
          contents: [
            "import { Hono } from 'hono';",
            `import health from ${JSON.stringify(healthRoute)};`,
            'const api = new Hono();',
            'api.on(health.method, health.path, (c) => health.handler(c));',
            'const root = new Hono();',
            "root.route('/api', api);",
            "const response = await root.request('/api/health');",
            'console.log(JSON.stringify(await response.json()));',
          ].join('\n'),
          resolveDir: root,
          sourcefile: 'bundled-health-identity.integration.ts',
          loader: 'ts',
        },
        absWorkingDir: root,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        // defineTool only wraps route metadata; endpoint dispatch is outside
        // this regression's scope. Keep the real health module and handler,
        // while avoiding the unrelated full route-stack dependency graph.
        plugins: [{
          name: 'health-test-define-tool-shim',
          setup(build) {
            build.onResolve({ filter: /^@papercusp\/agent-mcp$/ }, (args) => ({
              path: args.path,
              namespace: 'health-test',
            }));
            build.onLoad({ filter: /.*/, namespace: 'health-test' }, () => ({
              contents: 'export const defineTool = (definition) => definition;',
              loader: 'js',
            }));
          },
        }],
        outfile,
        define: {
          __PAPERCUSP_BUNDLED_SIDECAR__: 'true',
          __PAPERCUSP_BUNDLED_SOURCE_SHA__: JSON.stringify(bundleSha),
        },
      });

      const child = spawnSync(process.execPath, [outfile], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PAPERCUSP_BUILD_SHA: 'stale-env-sha' },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const output = child.stdout.trim().split('\n').at(-1) ?? '';
      const health = JSON.parse(output) as { ok?: boolean; sha?: string };
      expect(health.ok).toBe(true);
      expect(health.sha).toBe(bundleSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * WI-2141731 — THE BOOT-WARM INVARIANT.
 *
 * `git-pipeline-position`'s serving verdict now treats the sha `/api/health`
 * reports as DIRECT EVIDENCE of the code the process is executing. On :3070 that
 * sha comes from the `git rev-parse HEAD` fallback, which is NOT by itself a
 * loaded-code identity — a live checkout read would report whatever the tree has
 * advanced to, which on this git-sync-swept repo is a sha the process is NOT
 * running.
 *
 * What makes it sound is exclusively WHEN it is read: once, at process boot,
 * cached for the process's life. Both halves of that were load-bearing and
 * neither was guarded, so a later "just resolve it lazily" refactor would have
 * silently downgraded the evidence while every test stayed green — and the
 * failure direction is the bad one (a confident false "it is live").
 */
describe('WI-6554700010018173: the one-time git fallback retries a transient timeout', () => {
  const timeoutError = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });

  it('retries a timed-out rev-parse once instead of caching null for the process lifetime', async () => {
    const { resolveGitShortSha } = await import('./build-info');
    const calls: Array<{ args: string[]; timeout: number }> = [];
    const sha = resolveGitShortSha('/repo', (args, opts) => {
      calls.push({ args, timeout: opts.timeout });
      if (calls.length === 1) throw timeoutError();
      return 'be6d6f91c2\n';
    });
    expect(sha).toBe('be6d6f91c2');
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['rev-parse', '--short', 'HEAD']);
  });

  it('gives up (null) after the bounded attempts all time out', async () => {
    const { resolveGitShortSha } = await import('./build-info');
    let n = 0;
    const sha = resolveGitShortSha('/repo', () => {
      n++;
      throw timeoutError();
    });
    expect(sha).toBeNull();
    expect(n).toBe(2);
  });

  it('does not retry a definitive failure (not a checkout, no git binary)', async () => {
    const { resolveGitShortSha } = await import('./build-info');
    let n = 0;
    const sha = resolveGitShortSha('/not-a-repo', () => {
      n++;
      throw Object.assign(new Error('fatal: not a git repository'), { status: 128 });
    });
    expect(sha).toBeNull();
    expect(n).toBe(1);
  });

  it('budgets each attempt well above the 2s that timed out under fleet load', async () => {
    const { resolveGitShortSha, GIT_SHA_ATTEMPT_TIMEOUT_MS } = await import('./build-info');
    let seen = 0;
    resolveGitShortSha('/repo', (_args, opts) => {
      seen = opts.timeout;
      return 'abc1234\n';
    });
    expect(seen).toBe(GIT_SHA_ATTEMPT_TIMEOUT_MS);
    expect(GIT_SHA_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('WI-2141731: the boot-warm invariant that makes health.sha a loaded-code identity', () => {
  it('resolves the sha ONCE and caches it — never re-reads the checkout per request', async () => {
    const { getBuildInfo, _resetBuildInfoForTest } = await import('./build-info');
    _resetBuildInfoForTest();
    const first = getBuildInfo();
    const second = getBuildInfo();
    // Same object identity: the second call did no work, so the value cannot
    // drift to a newer checkout state between two reads of /api/health.
    expect(second).toBe(first);
    _resetBuildInfoForTest();
  });

  it('the operator entrypoint warms the cache at MODULE LOAD, not inside a handler', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const servePath = fileURLToPath(new URL('../../../apps/operator/bin/serve.ts', import.meta.url));
    const src = await readFile(servePath, 'utf8');
    // A top-level `const X = getBuildInfo()...` — column 0, so it is module
    // scope. Indented (inside a function/handler) would be the lazy-at-request
    // regression this guard exists to catch.
    expect(src).toMatch(/^const \w+ = getBuildInfo\(\)/m);
  });
});
