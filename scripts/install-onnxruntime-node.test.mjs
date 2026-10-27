import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertCudaProviderAssets,
  CUDA_PROVIDER_FILES,
  installCudaProvider,
  inspectCudaProvider,
  isOfflineSafeInstall,
  providerFilePaths,
  resolveTargetPlatform,
  resolveOrtPackageRoot,
  withNetworkAttemptTimeout,
  NETWORK_ATTEMPT_TIMEOUT_MS,
} from './install-onnxruntime-node.mjs';

// memory-reduction-2026-09-24 P-008: the upstream CUDA download died on Node's
// 250 ms happy-eyeballs attempt timeout while the host itself was reachable,
// silently leaving every model on CPU. The installer child must get a longer one.
test('withNetworkAttemptTimeout adds a long attempt timeout and keeps caller options', () => {
  const flag = `--network-family-autoselection-attempt-timeout=${NETWORK_ATTEMPT_TIMEOUT_MS}`;
  assert.ok(NETWORK_ATTEMPT_TIMEOUT_MS >= 2000);
  assert.equal(withNetworkAttemptTimeout(undefined), flag);
  assert.equal(withNetworkAttemptTimeout(''), flag);
  assert.equal(withNetworkAttemptTimeout('--max-old-space-size=4096'), `--max-old-space-size=4096 ${flag}`);
  const explicit = '--network-family-autoselection-attempt-timeout=900';
  assert.equal(withNetworkAttemptTimeout(explicit), explicit);
});

test('installCudaProvider passes the attempt timeout to the upstream installer child', () => {
  const root = mkdtempSync(join(tmpdir(), 'ort-attempt-'));
  const packageRoot = join(root, 'node_modules', 'onnxruntime-node');
  mkdirSync(join(packageRoot, 'script'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'onnxruntime-node', version: '1.24.3' }));
  let childEnv = null;
  try {
    installCudaProvider({
      repoRoot: root,
      env: { NODE_OPTIONS: '--trace-warnings' },
      host: { platform: 'linux', arch: 'x64' },
      resolvePackageRoot: () => packageRoot,
      fileExists: () => false,
      run: (_cmd, _args, opts) => {
        childEnv = opts.env;
        return { status: 0 };
      },
    });
  } catch {
    // The fake child produces no provider files, so the post-install asset check throws.
  }
  assert.ok(childEnv, 'the upstream installer child was spawned');
  assert.match(childEnv.NODE_OPTIONS, /--trace-warnings/);
  assert.match(childEnv.NODE_OPTIONS, /--network-family-autoselection-attempt-timeout=\d+/);
});

function fakeOrtPackage() {
  const packageRoot = mkdtempSync(join(tmpdir(), 'papercusp-ort-'));
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ binary: { napi_versions: [6] } }),
  );
  mkdirSync(join(packageRoot, 'script'), { recursive: true });
  writeFileSync(join(packageRoot, 'script', 'install.js'), '');
  return packageRoot;
}

test('resolveTargetPlatform honors npm_config_os and npm_config_cpu', () => {
  assert.deepEqual(
    resolveTargetPlatform(
      { npm_config_os: 'darwin', npm_config_cpu: 'arm64' },
      { platform: 'linux', arch: 'x64' },
    ),
    { os: 'darwin', cpu: 'arm64' },
  );
  assert.deepEqual(
    resolveTargetPlatform({}, { platform: 'linux', arch: 'amd64' }),
    { os: 'linux', cpu: 'x64' },
  );
});

test('offline-safe and skip settings prevent provider installation', () => {
  assert.equal(isOfflineSafeInstall({ ONNXRUNTIME_NODE_INSTALL: 'skip' }), true);
  assert.equal(isOfflineSafeInstall({ ONNXRUNTIME_NODE_INSTALL: 'offline-safe' }), true);
  assert.equal(isOfflineSafeInstall({ ONNXRUNTIME_NODE_INSTALL: 'cuda12' }), false);
});

test('providerFilePaths names the CUDA and shared provider payload', () => {
  const packageRoot = fakeOrtPackage();
  assert.deepEqual(
    providerFilePaths({
      packageRoot,
      target: { os: 'linux', cpu: 'x64' },
    }),
    CUDA_PROVIDER_FILES.map((file) =>
      join(packageRoot, 'bin', 'napi-v6', 'linux', 'x64', file),
    ),
  );
});

test('installCudaProvider runs ORT cuda12 install and verifies all provider files', () => {
  const packageRoot = fakeOrtPackage();
  const env = { npm_config_os: 'linux', npm_config_cpu: 'x64' };
  let call;
  const result = installCudaProvider({
    env,
    host: { platform: 'linux', arch: 'x64' },
    resolvePackageRoot: () => packageRoot,
    run: (...args) => {
      call = args;
      for (const file of providerFilePaths({ packageRoot, target: { os: 'linux', cpu: 'x64' } })) {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'provider');
      }
      return { status: 0 };
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(call[0], process.execPath);
  assert.equal(call[1][0], join(packageRoot, 'script', 'install.js'));
  assert.equal(call[2].env.ONNXRUNTIME_NODE_INSTALL, '1');
  assert.deepEqual(inspectCudaProvider({ env, resolvePackageRoot: () => packageRoot }).missing, []);
});

test('complete read-only CUDA providers are reused without downloading or changing shared inodes', () => {
  const packageRoot = fakeOrtPackage();
  const target = { os: 'linux', cpu: 'x64' };
  const env = { npm_config_os: 'linux', npm_config_cpu: 'x64' };
  const files = providerFilePaths({ packageRoot, target });
  try {
    for (const file of files) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(`${file}.generation`, 'pinned provider');
      chmodSync(`${file}.generation`, 0o444);
      linkSync(`${file}.generation`, file);
    }
    const result = installCudaProvider({
      env,
      host: { platform: 'linux', arch: 'x64' },
      resolvePackageRoot: () => packageRoot,
      run: () => assert.fail('complete providers must not invoke the downloader'),
    });
    assert.equal(result.reused, true);
    assert.deepEqual(result.files, files);
    for (const file of files) {
      assert.equal(statSync(file).ino, statSync(`${file}.generation`).ino);
      assert.equal(statSync(file).mode & 0o777, 0o444);
      assert.equal(readFileSync(file, 'utf8'), 'pinned provider');
    }
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('repair detaches read-only shared providers and replaces an empty asset without mutating the generation', () => {
  const packageRoot = fakeOrtPackage();
  const target = { os: 'linux', cpu: 'x64' };
  const env = { npm_config_os: 'linux', npm_config_cpu: 'x64' };
  const files = providerFilePaths({ packageRoot, target });
  const originals = ['pinned provider', 'pinned provider', ''];
  try {
    files.forEach((file, i) => {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(`${file}.generation`, originals[i]);
      chmodSync(`${file}.generation`, 0o444);
      linkSync(`${file}.generation`, file);
    });
    assert.deepEqual(inspectCudaProvider({ env, resolvePackageRoot: () => packageRoot }).missing, [files[2]]);
    let calls = 0;
    const result = installCudaProvider({
      env,
      host: { platform: 'linux', arch: 'x64' },
      resolvePackageRoot: () => packageRoot,
      run: () => {
        calls += 1;
        for (const file of files) writeFileSync(file, 'repaired provider');
        return { status: 0 };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.skipped, false);
    files.forEach((file, i) => {
      assert.notEqual(statSync(file).ino, statSync(`${file}.generation`).ino);
      assert.equal(readFileSync(file, 'utf8'), 'repaired provider');
      assert.equal(readFileSync(`${file}.generation`, 'utf8'), originals[i]);
      assert.equal(statSync(`${file}.generation`).mode & 0o777, 0o444);
    });
    assert.ok(readdirSync(join(files[0], '..')).every((name) => !name.includes('.install-')));
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('the installed upstream parser recognizes the force flag during an npm local lifecycle', () => {
  const packageRoot = fakeOrtPackage();
  const installedRoot = resolveOrtPackageRoot();
  try {
    const result = installCudaProvider({
      env: { npm_config_local_prefix: packageRoot, npm_package_json: join(packageRoot, 'package.json') },
      host: { platform: 'linux', arch: 'x64' },
      resolvePackageRoot: () => packageRoot,
      run: (_command, _args, options) => {
        // Use the real installed parser and requirements without downloading a
        // CUDA payload. The old cuda12 value returns undefined here, enabling
        // upstream install.js's local-install early exit.
        const probe = spawnSync(process.execPath, ['-e', `
          const path = require('node:path');
          const root = process.argv[1];
          const flag = require(path.join(root, 'script/install-utils.js')).parseInstallFlag();
          const metadata = require(path.join(root, 'script/install-metadata.js'));
          console.log(JSON.stringify({ flag, requirements: metadata.requirements['linux/x64'] }));
        `, installedRoot], { env: options.env, encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr);
        const parsed = JSON.parse(probe.stdout);
        assert.equal(parsed.flag, true, 'must force installation rather than taking the local-install no-op');
        assert.deepEqual(parsed.requirements, ['cuda12']);
        for (const file of providerFilePaths({ packageRoot, target: { os: 'linux', cpu: 'x64' } })) {
          mkdirSync(join(file, '..'), { recursive: true });
          writeFileSync(file, 'provider');
        }
        return { status: 0 };
      },
    });
    assert.equal(result.skipped, false);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('installCudaProvider skips non-linux/x64 cross-targets without running a native installer', () => {
  let invoked = false;
  const result = installCudaProvider({
    env: { npm_config_os: 'darwin', npm_config_cpu: 'arm64' },
    host: { platform: 'linux', arch: 'x64' },
    run: () => {
      invoked = true;
      return { status: 0 };
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'target-not-linux-x64');
  assert.equal(invoked, false);
});

test('assertCudaProviderAssets is inert unless CUDA reranking is requested', () => {
  const packageRoot = fakeOrtPackage();
  assert.deepEqual(
    assertCudaProviderAssets({
      env: { PAPERCUSP_RERANK_DEVICE: 'cpu' },
      resolvePackageRoot: () => packageRoot,
    }),
    { requested: false, ok: true },
  );
  assert.throws(
    () =>
      assertCudaProviderAssets({
        env: { PAPERCUSP_RERANK_DEVICE: 'cuda' },
        resolvePackageRoot: () => packageRoot,
      }),
    /requests CUDA, but onnxruntime-node/,
  );
});
