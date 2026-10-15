import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sources, productSources, productPortalSources, hostedProductPortalSources, resolveReviewArgs, reviewCommand, verifySources, verifyProductImports, speechReady, browserLaunchReady } from './review-cloud-tutorial-native.mjs';

function browserFixture(t, moduleText) {
  const root = mkdtempSync(join(tmpdir(), 'native-browser-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'node_modules/playwright');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
  writeFileSync(join(pkg, 'index.mjs'), moduleText);
  return root;
}

test('browser readiness runs launch and close with a deadline inside its outer budget', async t => {
  const root = browserFixture(t, `export const chromium={async launch(options){
    if (!(options.timeout > 0 && options.timeout < 2000)) throw Error('unbounded browser launch');
    return {version:()=> 'fixture-browser',async close(){ console.error('closed owned browser'); }};
  }};`);
  const result = await browserLaunchReady(root, { timeoutMs: 2000 });
  assert.match(result.stdout, /fixture-browser/);
  assert.match(result.stdout, /"phase":"ready"/);
  assert.match(result.stderr, /closed owned browser/);
  assert.deepEqual(result.diagnostics.phases.map(x => x.phase), ['import', 'launch', 'close', 'ready']);
  for (const mark of result.diagnostics.phases) {
    assert.equal(Number.isFinite(Date.parse(mark.at)), true);
    assert.equal(mark.elapsedMs >= 0, true);
  }
});

test('browser readiness preserves pending CDP requests across split lines and bounded log tails', async t => {
  const root = browserFixture(t, `export const chromium={async launch(){
    if (!process.env.DEBUG.includes('pw:protocol')) throw Error('protocol logging missing');
    process.stderr.write('2026-10-14T00:00:00.000Z pw:protocol SEND ► {"id":1,"method":"Browser.get');
    await new Promise(resolve=>setTimeout(resolve,10));
    process.stderr.write('Version"}\\n');
    console.error('2026-10-14T00:00:00.001Z pw:protocol ◀ RECV {"id":1,"result":{}}');
    console.error('2026-10-14T00:00:00.002Z pw:protocol SEND ► {"id":2,"method":"Target.setAutoAttach"}');
    console.error('2026-10-14T00:00:00.003Z pw:protocol ◀ RECV {broken}');
    console.error('x'.repeat(20000));
    throw Error('fixture pending protocol refused');
  }};`);
  await assert.rejects(browserLaunchReady(root, { timeoutMs: 2000 }), error => {
    assert.equal(error.phase, 'launch');
    assert.deepEqual(error.diagnostics.protocol, { sent: 2, received: 1,
      pending: [{ id: 2, method: 'Target.setAutoAttach', at: '2026-10-14T00:00:00.002Z' }] });
    assert.doesNotMatch(error.stderr, /Browser.getVersion/);
    assert.match(error.message, /Target.setAutoAttach/);
    return true;
  });
});

test('browser readiness preserves the failing phase and browser diagnostics', async t => {
  for (const [phase, body] of [
    ['import', `throw Error('fixture import refused');`],
    ['launch', `export const chromium={async launch(){throw Error('fixture protocol refused')}};`],
    ['close', `export const chromium={async launch(){return {version:()=> 'fixture',async close(){throw Error('fixture close refused')}}}};`],
  ]) {
    const root = browserFixture(t, body);
    await assert.rejects(browserLaunchReady(root, { timeoutMs: 2000 }), error => {
      assert.equal(error.phase, phase);
      assert.equal(error.timedOut, false);
      assert.match(error.message, /fixture .* refused/);
      return true;
    });
  }
});

test('browser readiness kills a stalled browser descendant and retains its launch phase', async t => {
  const root = browserFixture(t, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
    export const chromium={async launch(){
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      writeFileSync('browser.pid',String(child.pid));
      await new Promise(()=>{});
    }};`);
  await assert.rejects(browserLaunchReady(root, { timeoutMs: 1000 }), error => {
    assert.equal(error.phase, 'launch');
    assert.equal(error.timedOut, true);
    assert.match(error.message, /deadline exceeded/);
    return true;
  });
  const pid = Number(readFileSync(join(root, 'browser.pid'), 'utf8'));
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('desktop re-entry keeps caller-relative manifests and roots when its working directory changes', () => {
  const caller = resolve('/caller'), child = resolve('/retained');
  const args = ['--root', '/retained', '--source-root', '.', '--manifest', 'docs/review.json',
    '--out', '../evidence/native', '--portal-root', '../portal', '--portal-source-root', 'portal-current',
    '--profile', 'product-guide'];
  const normalized = resolveReviewArgs(args, caller);
  assert.equal(normalized[normalized.indexOf('--manifest') + 1], resolve(caller, 'docs/review.json'));
  assert.equal(normalized[normalized.indexOf('--out') + 1], resolve(caller, '../evidence/native'));
  assert.equal(normalized[normalized.indexOf('--source-root') + 1], caller);
  assert.equal(normalized[normalized.indexOf('--portal-root') + 1], resolve(caller, '../portal'));
  assert.equal(normalized[normalized.indexOf('--portal-source-root') + 1], resolve(caller, 'portal-current'));
  assert.deepEqual(resolveReviewArgs(normalized, child), normalized);
  assert.deepEqual(args.slice(-2), normalized.slice(-2));
  assert.equal(args[args.indexOf('--manifest') + 1], 'docs/review.json');
  assert.throws(() => resolveReviewArgs(['--manifest', '--desktop'], caller), /Required --manifest/);
  assert.throws(() => resolveReviewArgs(['--out'], caller), /Required --out/);
});

test('declared root source custody paths exist in the reviewed repository', () => {
  for (const path of [...sources, ...productSources]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, `Missing reviewed source: ${path}`);
  }
  const portalRoot = process.env.PAPERCUSP_REVIEW_PORTAL_SOURCE_ROOT;
  if (portalRoot) for (const path of productPortalSources) {
    assert.equal(existsSync(join(portalRoot, path)), true, `Missing reviewed Portal source: ${path}`);
  }
});

test('healthy existing Speech Dispatcher is accepted by SSIP without spawning or restarting it', () => {
  const calls = [];
  const modules = speechReady({ run(command, args) {
    calls.push({ command, args });
    assert.equal(command, '/usr/bin/python3');
    assert.match(args[1], /SSIPClient/);
    assert.match(args[1], /list_output_modules/);
    return { status: 0, stdout: '["espeak-ng"]' };
  } });
  assert.deepEqual(modules, ['espeak-ng']);
  assert.equal(calls.length, 1);
});

test('unusable daemon, missing module and invalid SSIP reply fail closed before browser review', () => {
  for (const result of [
    { status: 1, stderr: 'connection refused' },
    { status: 0, stdout: '[]' },
    { status: 0, stdout: 'not JSON' },
    { status: null, error: new Error('SSIP deadline') },
  ]) assert.throws(() => speechReady({ run: () => result }));
});

test('source preflight rejects missing scope, duplicate scope, current drift and changed paused fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-at-source-'));
  const current = mkdtempSync(join(tmpdir(), 'native-at-current-'));
  const fixture = 'apps/operator/e2e/cloud-tutorial.spec.ts';
  for (const base of [root, current]) for (const p of [...sources, fixture]) {
    mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), p);
  }
  const manifest = { files: sources.map(path => ({ path, sha256: createHash('sha256').update(path).digest('hex') })) };
  verifySources(root, current, manifest);
  assert.throws(() => verifySources(root, current, { files: manifest.files.slice(1) }), /exactly/);
  assert.throws(() => verifySources(root, current, { files: manifest.files.map(() => manifest.files[0]) }), /exactly/);
  writeFileSync(join(current, sources[0]), 'changed');
  assert.throws(() => verifySources(root, current, manifest), /source drift/);
  writeFileSync(join(current, sources[0]), sources[0]);
  writeFileSync(join(current, fixture), 'changed fixture');
  assert.throws(() => verifySources(root, current, manifest), /fixture source drift/);
});

test('product review refuses drift in either source tree, including its paused Portal fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-product-root-'));
  const sourceRoot = mkdtempSync(join(tmpdir(), 'native-product-current-'));
  const portalRoot = mkdtempSync(join(tmpdir(), 'native-product-portal-'));
  const portalSourceRoot = mkdtempSync(join(tmpdir(), 'native-product-portal-current-'));
  const seed = (roots, files) => {
    for (const base of roots) for (const p of files) {
      mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), p);
    }
    return files.map(path => ({ path, sha256: createHash('sha256').update(path).digest('hex') }));
  };
  const manifest = { files: seed([root, sourceRoot], productSources),
    portalFiles: seed([portalRoot, portalSourceRoot], productPortalSources) };
  const options = { profile: 'product-guide', portalRoot, portalSourceRoot };
  verifySources(root, sourceRoot, manifest, options);
  assert.throws(() => verifySources(root, sourceRoot, manifest, { profile: 'product-guide' }), /both.*roots/);
  assert.throws(() => verifySources(root, sourceRoot, { ...manifest, portalFiles: manifest.portalFiles.slice(1) }, options), /exactly/);
  writeFileSync(join(sourceRoot, productSources[0]), 'changed charge explanation');
  assert.throws(() => verifySources(root, sourceRoot, manifest, options), /Product guide source drift/);
  writeFileSync(join(sourceRoot, productSources[0]), productSources[0]);
  writeFileSync(join(portalSourceRoot, 'e2e/portal-product-tutorial.spec.ts'), 'changed fixture');
  assert.throws(() => verifySources(root, sourceRoot, manifest, options), /Product Portal source drift/);
});

test('review profile selects the maintained Portal script and one explicit pause journey', () => {
  assert.equal(reviewCommand({ root: '/root', out: '/evidence/native' }).cwd, '/root/apps/operator');
  assert.deepEqual(reviewCommand({ profile: 'product-guide', root: '/root', portalRoot: '/portal', out: '/evidence/native' }), {
    cwd: '/portal', args: ['run', 'test:e2e:browser', '--', 'e2e/portal-product-tutorial.spec.ts', '--headed', '--workers=1',
      '--grep', 'guide precedes portal destination and persists reload with workspace=null$', '--output', '/evidence/native-test-results'],
  });
  assert.throws(() => reviewCommand({ profile: 'product-guide', root: '/root', out: '/evidence/native' }), /portal-root/);
  assert.throws(() => reviewCommand({ profile: 'unknown', root: '/root', out: '/evidence/native' }), /Unknown/);
});

test('product import preflight rejects matching live bytes and redirected package exports', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'native-product-imports-'));
  try {
    const root = join(fixture, 'frozen'), live = join(fixture, 'live');
    for (const base of [root, live]) {
      for (const path of productSources) {
        mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), path);
      }
      writeFileSync(join(base, 'packages/operator-ui/package.json'), JSON.stringify({ name: '@papercusp/operator-ui',
        exports: { './onboarding': './src/onboarding/product-tutorial.tsx', './browser-telemetry': './src/browser-telemetry.tsx' } }));
      writeFileSync(join(base, 'packages/operator-core/package.json'), JSON.stringify({ name: '@papercusp/operator-core',
        exports: { './lib/*': './lib/*.ts' } }));
      mkdirSync(join(base, 'node_modules/@papercusp'), { recursive: true });
      symlinkSync(join(base, 'packages/operator-core'), join(base, 'node_modules/@papercusp/operator-core'));
    }
    const consumer = (name, source) => {
      const portal = join(fixture, name), modules = join(portal, 'node_modules/@papercusp');
      mkdirSync(modules, { recursive: true });
      for (const pkg of ['operator-ui', 'operator-core']) symlinkSync(join(source, 'packages', pkg), join(modules, pkg));
      return portal;
    };
    assert.throws(() => verifyProductImports(root, consumer('live-portal', live)), /imported source escapes/);
    const portal = consumer('frozen-portal', root);
    assert.equal(verifyProductImports(root, portal).length, 5);
    // A package can be pinned while one source child is still linked to the live tree.
    rmSync(join(root, productSources[2])); symlinkSync(join(live, productSources[2]), join(root, productSources[2]));
    assert.throws(() => verifyProductImports(root, portal), /imported source escapes/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('product review filter accepts Playwright file-qualified titles and excludes the other account journey', () => {
  const { args } = reviewCommand({ profile: 'product-guide', root: '/root', portalRoot: '/portal', out: '/evidence/native' });
  const filter = new RegExp(args[args.indexOf('--grep') + 1]);
  assert.equal(filter.test('portal-product-tutorial.spec.ts guide precedes portal destination and persists reload with workspace=null'), true);
  assert.equal(filter.test('portal-product-tutorial.spec.ts guide precedes portal destination and persists reload with workspace=assigned-workspace'), false);
  assert.equal(filter.test('portal-product-tutorial.spec.ts guide precedes portal destination and persists reload with workspace=null extra case'), false);
});

test('hosted native review selects only the maintained real Tab journey and refuses a missing pause or changed admission fixture', () => {
  const { cwd, args } = reviewCommand({ profile: 'product-hosted', root: '/root', portalRoot: '/portal', out: '/evidence/native' });
  assert.equal(cwd, '/portal');
  assert.ok(args.includes('e2e/portal-product-tutorial-served.spec.ts'));
  const filter = new RegExp(args[args.indexOf('--grep') + 1]);
  const title = 'a real hosted non-Cloud preference task saves and survives reload using only Tab and arrow traversal at 200 percent text';
  assert.equal(filter.test('portal-product-tutorial-served.spec.ts ' + title), true);
  assert.equal(filter.test(title + ' extra case'), false);
  assert.equal(filter.test('a real hosted non-Cloud preference task saves and survives reload with narrow enlarged text, reduced motion and keyboard activation'), false);
  const fixture = mkdtempSync(join(tmpdir(), 'native-hosted-custody-'));
  try {
    const root = join(fixture, 'core'), portalRoot = join(fixture, 'portal'), portalSourceRoot = join(fixture, 'current');
    const seed = (roots, paths) => paths.map(path => {
      for (const base of roots) {
        mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), path);
      }
      return { path, sha256: createHash('sha256').update(path).digest('hex') };
    });
    const manifest = { files: seed([root], productSources), portalFiles: seed([portalRoot, portalSourceRoot], hostedProductPortalSources) };
    const options = { profile: 'product-hosted', portalRoot, portalSourceRoot };
    assert.throws(() => verifySources(root, root, manifest, options), /attended pause seam/);
    const pausedPath = 'e2e/portal-product-tutorial-served.spec.ts';
    const paused = "if (process.env.PORTAL_TUTORIAL_ORCA_REVIEW === '1') await page.pause();";
    for (const base of [portalRoot, portalSourceRoot]) writeFileSync(join(base, pausedPath), paused);
    manifest.portalFiles.find(row => row.path === pausedPath).sha256 = createHash('sha256').update(paused).digest('hex');
    verifySources(root, root, manifest, options);
    writeFileSync(join(portalSourceRoot, 'e2e/hosted-test-user.ts'), 'changed admission');
    assert.throws(() => verifySources(root, root, manifest, options), /Product Portal source drift/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('native review refuses missing, reused, nested and symlinked artifact destinations for every profile', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'native-output-boundary-'));
  try {
    const roots = Object.fromEntries(['root', 'sourceRoot', 'portalRoot', 'portalSourceRoot'].map(key => {
      const path = join(fixture, key); mkdirSync(path); return [key, path];
    }));
    for (const profile of ['cloud', 'product-guide', 'product-hosted']) {
      assert.throws(() => reviewCommand({ profile, ...roots }), /external --out/);
      for (const source of Object.values(roots)) {
        assert.throws(() => reviewCommand({ profile, ...roots, out: source }), /outside every reviewed/);
        assert.throws(() => reviewCommand({ profile, ...roots, out: join(source, 'nested', 'native') }), /outside every reviewed/);
      }
      const out = join(fixture, 'evidence', profile);
      const command = reviewCommand({ profile, ...roots, out });
      assert.equal(command.args[command.args.indexOf('--output') + 1], `${out}-test-results`);
      mkdirSync(`${out}-test-results`, { recursive: true });
      assert.throws(() => reviewCommand({ profile, ...roots, out }), /already exists/);
    }
    const alias = join(fixture, 'external-looking');
    symlinkSync(roots.portalRoot, alias);
    assert.throws(() => reviewCommand({ ...roots, out: join(alias, 'native') }), /outside every reviewed/);
    // A sibling sharing the source basename is still a valid external path.
    assert.doesNotThrow(() => reviewCommand({ ...roots, out: roots.root + '-evidence/native' }));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('a failed Playwright review keeps its real failure artifacts outside the verifier checkout', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'native-output-playwright-'));
  try {
    const root = join(fixture, 'core'), portalRoot = join(fixture, 'portal'), out = join(fixture, 'evidence', 'native');
    mkdirSync(root); mkdirSync(join(portalRoot, 'e2e'), { recursive: true });
    const require = createRequire(import.meta.url);
    const testModule = require.resolve('@playwright/test');
    const config = join(portalRoot, 'playwright.config.cjs');
    writeFileSync(config, "module.exports = {testDir:'./e2e', retries:0, reporter:'line'};");
    const spec = join(portalRoot, 'e2e/portal-product-tutorial-served.spec.ts');
    const title = 'a real hosted non-Cloud preference task saves and survives reload using only Tab and arrow traversal at 200 percent text';
    writeFileSync(spec, `const {test} = require(${JSON.stringify(testModule)}); test(${JSON.stringify(title)}, () => { throw new Error('native-output-regression-sentinel'); });`);
    const before = [readFileSync(config, 'utf8'), readFileSync(spec, 'utf8')];
    const review = reviewCommand({ profile: 'product-hosted', root, portalRoot, out });
    const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', ...review.args.slice(3), '--config', config], {
      cwd: review.cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PWDEBUG: '0', NODE_OPTIONS: '' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /native-output-regression-sentinel/);
    assert.equal(JSON.parse(readFileSync(`${out}-test-results/.last-run.json`, 'utf8')).status, 'failed');
    assert.equal(existsSync(join(portalRoot, 'test-results')), false);
    assert.deepEqual([readFileSync(config, 'utf8'), readFileSync(spec, 'utf8')], before);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
