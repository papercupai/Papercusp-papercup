import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tsx = createRequire(import.meta.url).resolve('tsx');
const scratch = mkdtempSync(join(tmpdir(), 'host-native-module-'));
const spaUrl = new URL('./host-spa.ts', import.meta.url).href;
const llmTestUrl = new URL('./llm-test.ts', import.meta.url).href;
const scenarioRegistryUrl = new URL('../../../packages/operator-core/lib/llm-testing/scenarios/index.ts', import.meta.url).href;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runNative(script: string, overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...overrides };
  // Exercise the source-native hosted runtime, without Vitest's module
  // transform/interoperability shim or the parent's committed-source hook.
  // The strict committed-source sidecar controls have their own loader suite;
  // this child must evaluate these current source files, including a local fix.
  delete env.NODE_OPTIONS;
  delete env.PAPERCUSP_SPA_DIST;
  delete env.PAPERCUSP_DOCS_ROOT;
  delete env.PAPERCUSP_PUBLIC_DOCS_ROOT;
  delete env.PAPERCUSP_RUST_OPENAPI;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', script], {
    cwd: scratch,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

function expectNativeSuccess(result: ReturnType<typeof runNative>) {
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('NATIVE_HOST_OK');
}

describe('source-native ESM host boundaries (WI-6554700010010797)', () => {
  it('serves the hosted shell and build identity through the actual CommonJS leaf boundary', () => {
    writeFileSync(join(scratch, 'index.html'), '<html><head></head><body>native shell</body></html>');
    const result = runNative(`
      import assert from 'node:assert/strict';
      const { createSpaRoutes, hostedBrowserApiMarker } = await import(${JSON.stringify(spaUrl)});
      assert.equal(hostedBrowserApiMarker('native-workspace').controlPlaneWorkspaceId, 'native-workspace');
      const routes = createSpaRoutes({ kind: 'hosted', controlPlaneWorkspaceId: 'native-workspace' });
      const shell = await routes.request('/');
      assert.equal(shell.status, 200);
      const body = await shell.text();
      assert.ok(body.includes('window.__PAPERCUSP_HOSTED_BROWSER__='));
      assert.ok(body.includes('native-workspace'));
      const identity = await routes.request('/__spa/build-id');
      assert.equal(identity.status, 200);
      assert.equal(typeof (await identity.json()).buildId, 'string');
      console.log('NATIVE_HOST_OK');
    `, { PAPERCUSP_SPA_DIST: scratch });
    expectNativeSuccess(result);
  }, 40_000);

  it('describes a missing SPA through the actual CommonJS leaf boundary', () => {
    const result = runNative(`
      import assert from 'node:assert/strict';
      const { createSpaRoutes } = await import(${JSON.stringify(spaUrl)});
      const routes = createSpaRoutes({ kind: 'hosted', controlPlaneWorkspaceId: 'native-workspace' });
      const response = await routes.request('/');
      assert.equal(response.status, 503);
      assert.ok((await response.text()).includes('operator-vite is not built'));
      console.log('NATIVE_HOST_OK');
    `, { PAPERCUSP_SPA_DIST: join(scratch, 'missing') });
    expectNativeSuccess(result);
  }, 40_000);

  it.each(['host-spa', 'host-docs', 'host-docs-public', 'host-proxies'])(
    'loads %s with default module-relative paths from an unrelated working directory',
    (name) => {
      const url = new URL(`./${name}.ts`, import.meta.url).href;
      const result = runNative(`
        const host = await import(${JSON.stringify(url)});
        if (Object.keys(host).length === 0) throw new Error('Missing host exports');
        console.log('NATIVE_HOST_OK');
      `, { PAPERCUSP_ENABLE_RUST_REWRITES: '1' });
      expectNativeSuccess(result);
    },
    40_000,
  );
});

describe('source-native static LLM CLI (EI-25893704524349749)', () => {
  it('lints a real scenario and resolves its maintained fixture from an unrelated working directory', () => {
    const result = runNative(`
      const { getScenario } = await import(${JSON.stringify(scenarioRegistryUrl)});
      const scenario = getScenario('op-S01-status-quick');
      scenario.fixtures = { sseTapePath: 'fixtures/operator/smoke/handoff-round-trip.sse' };
      process.argv = [process.execPath, ${JSON.stringify(llmTestUrl)}, 'lint', '--scenario', scenario.id];
      await import(${JSON.stringify(llmTestUrl)});
    `);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('lint clean');
  }, 40_000);
});
