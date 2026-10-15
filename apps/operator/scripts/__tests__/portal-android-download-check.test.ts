import { describe, expect, it } from 'vitest';
import { assertAuthenticatedArtifact, assertFetchedArtifact, enterSupportedAccountShell, loadPortalModule, runDownloadPhases } from '../portal-android-download-check';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchAndroidDownloadCheck } from '../portal-android-download-launcher.mjs';

describe('Portal-owned Android download launcher', () => {
  it('routes the actual Node executable through the supplied Portal loader without admission', () => {
    const root = mkdtempSync(join(tmpdir(), 'android-launcher-executable-'));
    try {
      mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
      writeFileSync(join(root, 'node_modules/.bin/tsx'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({script:process.argv[2],root:process.env.PORTAL_ANDROID_ROOT}));process.exitCode=23;\n', { mode: 0o700 });
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../portal-android-download-launcher.mjs', import.meta.url))], {
        env: { ...process.env, PORTAL_ANDROID_CLICK_TEST: '1', PORTAL_ANDROID_ROOT: root }, encoding: 'utf8', timeout: 10000,
      });
      expect(result.status).toBe(23);
      expect(JSON.parse(result.stdout)).toEqual({ script: fileURLToPath(new URL('../portal-android-download-check.ts', import.meta.url)), root });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses missing opt-in, root, or Portal loader before spawning', () => {
    const spawn = () => { throw Error('must not spawn'); };
    expect(() => launchAndroidDownloadCheck({}, spawn)).toThrow('explicit_test_admission_required');
    expect(() => launchAndroidDownloadCheck({ PORTAL_ANDROID_CLICK_TEST: '1' }, spawn)).toThrow('explicit_portal_root_required');
    const root = mkdtempSync(join(tmpdir(), 'android-launcher-'));
    try {
      expect(() => launchAndroidDownloadCheck({ PORTAL_ANDROID_CLICK_TEST: '1', PORTAL_ANDROID_ROOT: root }, spawn)).toThrow('portal_tsx_launcher_missing');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('selects only the explicit Portal loader and forwards failure without retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'android-launcher-'));
    try {
      mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
      writeFileSync(join(root, 'node_modules/.bin/tsx'), '');
      let calls = 0;
      const env = { PORTAL_ANDROID_CLICK_TEST: '1', PORTAL_ANDROID_ROOT: root, PORTAL_ANDROID_RELEASE: 'retained-candidate' };
      const status = launchAndroidDownloadCheck(env, (command, args, options) => {
        calls++;
        expect(command).toBe(join(root, 'node_modules/.bin/tsx'));
        expect(args).toEqual([fileURLToPath(new URL('../portal-android-download-check.ts', import.meta.url))]);
        expect(options.env).toEqual(env);
        expect(options.stdio).toBe('inherit');
        return { status: 7 };
      });
      expect(status).toBe(7);
      expect(calls).toBe(1);
      expect(launchAndroidDownloadCheck(env, () => ({ status: null, signal: 'SIGTERM' }))).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Android served download phase evidence', () => {
  it.each([200, 403])('captures Playwright status() %s with the response receiver', async status => {
    let resolved = false;
    const response = { value: status, status() { return this.value; }, text: async () => 'secret' };
    const result = await runDownloadPhases([{ phase: 'authenticated-artifact-custody', run: () => assertAuthenticatedArtifact({ resolveServedRelease: () => { resolved = true; return { release: 'Gv90' }; }, assertTutorialSourceCustody: () => {} }, response, {}, '/portal', 'Gv90') }], async () => {}, async () => ({}));
    expect(result.passed).toBe(status === 200);
    expect(resolved).toBe(status === 200);
    if (status !== 200) expect(result.failure).toEqual({ substep: 'response-status', reason: 'http-status', status, code: null });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('sanitizes an exception from Playwright status() and still cleans up', async () => {
    const result = await runDownloadPhases([{ phase: 'authenticated-artifact-custody', run: () => assertAuthenticatedArtifact({}, { status() { throw Error('secret'); } }, {}, '/portal', 'Gv90') }], async () => {}, async () => ({}));
    expect(result.failure).toEqual({ substep: 'response-status', reason: 'unknown', status: null, code: null });
    expect(result.cleanup).toBe(true);
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('records nested transport codes without persisting the cause and fails closed on cleanup error', async () => {
    const result = await runDownloadPhases([{ phase: 'artifact-custody', run: () => assertFetchedArtifact(async () => { throw Object.assign(Error('secret'), { cause: { code: 'ECONNRESET', message: 'secret' } }); }, {}, () => ({}), '/portal', 'Gv90') }], async () => { throw Error('secret'); }, async () => ({}));
    expect(result.failure).toEqual({ substep: 'fetch', reason: 'unknown', status: null, code: 'ECONNRESET' });
    expect(result.cleanup).toBe(false);
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('redacts nonnumeric status even when runtime-path resolution fails', async () => {
    const result = await runDownloadPhases([{ phase: 'artifact-custody', run: () => assertFetchedArtifact(async () => ({ status: 'secret' }), {}, () => { throw Error('secret'); }, '/portal', 'Gv90') }], async () => {}, async () => ({}));
    expect(result.failure).toEqual({ substep: 'runtime-paths', reason: 'unknown', status: null, code: null });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('retains source-missing refusal for authenticated custody with no later click', async () => {
    let clicked = false;
    const result = await runDownloadPhases([
      { phase: 'authenticated-artifact-custody', run: () => assertAuthenticatedArtifact({ resolveServedRelease: () => ({ release: 'Gv90' }), assertTutorialSourceCustody: () => { throw Error('tutorial_served_source_missing'); } }, { status: 200, text: async () => 'secret' }, {}, '/portal', 'Gv90') },
      { phase: 'click', run: async () => { clicked = true; } },
    ], async () => {}, async () => ({}));
    expect(result.failure).toEqual({ substep: 'source-custody', reason: 'source-missing', status: 200, code: null });
    expect(clicked).toBe(false);
    expect(result.cleanup).toBe(true);
  });
  it.each(['fetch', 'runtime-paths', 'response-status', 'response-body', 'served-release', 'release-equality', 'source-custody'])('records sanitized %s refusal and suppresses admission', async substep => {
    const secret = 'cookie=secret https://secret.test/private';
    const error = Object.assign(new Error(secret), { code: 'ENOENT', reason: 'no-release', cookie: secret });
    let admitted = false;
    let cleaned = false;
    const response = { status: substep === 'response-status' ? 403 : 200, text: async () => { if (substep === 'response-body') throw error; return secret; } };
    const oracle = {
      resolveServedRelease: () => { if (substep === 'served-release') throw error; return { release: substep === 'release-equality' ? secret : 'Gv90' }; },
      assertTutorialSourceCustody: () => { if (substep === 'source-custody') throw Error('tutorial_served_source_mismatch:' + secret); },
    };
    const result = await runDownloadPhases([
      { phase: 'artifact-custody', run: () => assertFetchedArtifact(async () => { if (substep === 'fetch') throw error; return response; }, oracle, () => { if (substep === 'runtime-paths') throw error; return {}; }, '/portal', 'Gv90') },
      { phase: 'admission', run: async () => { admitted = true; } },
    ], async () => { cleaned = true; }, async () => ({}));
    expect(result.failure?.substep).toBe(substep);
    expect(result.failure?.status).toBe(substep === 'fetch' ? null : response.status);
    expect(result.failure?.reason).toBe(substep === 'response-status' ? 'http-status' : substep === 'release-equality' ? 'artifact-changed' : substep === 'source-custody' ? 'source-mismatch' : 'no-release');
    expect(result.passed).toBe(false);
    expect(admitted).toBe(false);
    expect(cleaned).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each(['no-build-id', 'unexpected-build-id', 'no-release', 'multiple-releases', 'build-id-mismatch', 'no-published-at', 'published-after-journey', 'secret'])('allowlists oracle reason %s without exposing messages or unknown codes', async reason => {
    const result = await runDownloadPhases([{ phase: 'artifact-custody', run: () => assertAuthenticatedArtifact({ resolveServedRelease: () => { throw Object.assign(Error('secret'), { reason, code: 'secret' }); } }, { status: 200, text: async () => 'secret' }, {}, '/portal', 'Gv90') }], async () => {}, async () => ({}));
    expect(result.failure).toEqual({ substep: 'served-release', reason: reason === 'secret' ? 'unknown' : reason, status: 200, code: null });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('imports fixture modules with the active tsx loader without a second namespace', async () => {
    const module = await loadPortalModule(fileURLToPath(new URL('../portal-android-download-check.ts', import.meta.url)));
    expect(module.runDownloadPhases).toBeTypeOf('function');
  });
  it('refuses changed authenticated build before onboarding or click and still cleans', async () => {
    const actions: string[] = [];
    const oracle = {
      resolveServedRelease: ({ html }: { html: string }) => ({ release: html }),
      assertTutorialSourceCustody: () => { actions.push('source'); },
    };
    const result = await runDownloadPhases([
      { phase: 'authenticated-artifact-custody', run: () => assertAuthenticatedArtifact(oracle, { text: async () => 'changed' }, {}, '/portal', 'Gv90') },
      { phase: 'onboarding', run: async () => { actions.push('onboarding'); } },
      { phase: 'click', run: async () => { actions.push('click'); } },
    ], async () => { actions.push('cleanup'); }, async () => ({}));
    expect(result.failedPhase).toBe('authenticated-artifact-custody');
    expect(result.passed).toBe(false);
    expect(actions).toEqual(['cleanup']);
  });
  it('checks authenticated response HTML and source custody for the accepted artifact', async () => {
    let checked = false;
    await assertAuthenticatedArtifact({
      resolveServedRelease: ({ html }: { html: string }) => { expect(html).toBe('authenticated-html'); return { release: 'Gv90' }; },
      assertTutorialSourceCustody: (release: { release: string }, root: string) => { expect(release.release).toBe('Gv90'); expect(root).toBe('/portal'); checked = true; },
    }, { text: async () => 'authenticated-html' }, {}, '/portal', 'Gv90');
    expect(checked).toBe(true);
  });
  it.each([true, false])('uses real account-guide navigation only when welcome is visible (%s)', async visible => {
    const clicked: string[] = [];
    const page = {
      getByRole: (_role: string, opts: { name: string }) => ({ isVisible: async () => visible, click: async () => { clicked.push(opts.name); } }),
      waitForURL: async (predicate: (url: URL) => boolean) => {
        expect(predicate(new URL('https://example.test/?firstRun=deferred&panel=account'))).toBe(true);
        expect(predicate(new URL('https://example.test/'))).toBe(false);
      },
    };
    await enterSupportedAccountShell(page);
    expect(clicked).toEqual(visible ? ['Manage your account and preferences', 'Open account'] : []);
  });
  it.each(['navigation', 'supported-onboarding', 'android-toolbar', 'candidate-hash'])('retains %s failure, stops later actions and cleans the fixture', async phase => {
    const calls: string[] = [];
    const result = await runDownloadPhases([
      { phase: 'admission', run: async () => { calls.push('admission'); } },
      { phase, run: async () => { throw new Error('cookie=private URL=private'); } },
      { phase: 'later', run: async () => { calls.push('later'); } },
    ], async () => { calls.push('cleanup'); }, async () => ({ navigationStatus: 200, androidLinks: 0 }));
    expect(result.failedPhase).toBe(phase);
    expect(result.diagnostics).toEqual({ navigationStatus: 200, androidLinks: 0 });
    expect(calls).toEqual(['admission', 'cleanup']);
    expect(result.cleanup).toBe(true);
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('refuses success if cleanup fails even after hash verification', async () => {
    const result = await runDownloadPhases([{ phase: 'candidate-hash', run: async () => {} }], async () => { throw Error('cleanup'); }, async () => ({}));
    expect(result.cleanup).toBe(false);
    expect(result.passed).toBe(false);
  });
  it('still cleans up when page diagnostics fail', async () => {
    let cleaned = false;
    const result = await runDownloadPhases([{ phase: 'navigation', run: async () => { throw Error(); } }], async () => { cleaned = true; }, async () => { throw Error(); });
    expect(cleaned).toBe(true);
    expect(result.diagnostics).toEqual({ observationFailed: true });
  });
});
