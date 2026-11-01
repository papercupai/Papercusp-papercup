import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertVmReleaseApplicationRuntime, assertVmReleaseRuntimePolicy, assertVmReleaseRuntimePort } from './vm-release-runtime-policy';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vm-release-policy-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'serve.mjs'), 'serve-bytes');
  writeFileSync(join(root, 'bin/node'), 'node-bytes');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const transformersRoot = join(root, 'node_modules/@huggingface/transformers');
  const modelsRoot = join(transformersRoot, 'models/onnx-community');
  mkdirSync(modelsRoot, { recursive: true });
  writeFileSync(
    join(transformersRoot, 'package.json'),
    JSON.stringify({ name: '@huggingface/transformers', version: '4.2.0' }),
  );
  const models = [
    { mode: 'harrier', runtimeId: 'onnx-community/harrier-oss-v1-0.6b-ONNX', nativeDimensions: 1024 },
    { mode: 'gemma', runtimeId: 'onnx-community/embeddinggemma-300m-ONNX', nativeDimensions: 768 },
  ].map((model, index) => {
    const bytes = `model-${index}`;
    const name = model.runtimeId.split('/')[1]!;
    mkdirSync(join(modelsRoot, name, 'onnx'), { recursive: true });
    writeFileSync(join(modelsRoot, name, 'onnx/model.onnx'), bytes);
    return {
      ...model,
      revision: String(index + 1).repeat(40),
      files: [{ path: 'onnx/model.onnx', bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }],
    };
  });
  writeFileSync(
    join(transformersRoot, 'models/papercusp-model-assets.json'),
    JSON.stringify({
      schemaVersion: 1,
      pack: 'local-models',
      required: true,
      cachePolicy: {
        mode: 'installed-local-only',
        remoteFetch: 'forbidden-on-vm-release',
        readyWhen: 'every-declared-file-matches-size-and-sha256',
        missingOrCorrupt: 'refuse-startup',
        recovery: 'replace-with-a-signed-runtime-containing-the-declared-pack',
      },
      compatibility: {
        transformersPackage: '4.2.0',
        executionProvider: 'cpu',
        runtimeDefaults: ['harrier', 'gemma'],
      },
      models,
    }),
  );
  const manifest = {
    version: '1.2.3',
    buildSha: 'abc123',
    artifacts: [
      { name: 'serve.mjs', sha256: hash('serve-bytes') },
      { name: 'bin/node', sha256: hash('node-bytes') },
    ],
    ...overrides,
  };
  writeFileSync(join(root, 'build-provenance.json'), JSON.stringify(manifest));
  return root;
}

const vmEnv = {
  PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release',
  PAPERCUSP_BUILD_VERSION: '1.2.3',
  PAPERCUSP_BUILD_SHA: 'abc123',
  PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
};

function runPackagedRuntime(options: { foreignNode?: boolean; gitHead?: string; corruptNode?: boolean;
  bun?: string; accepted?: boolean; missingReader?: boolean; mutateManifest?: boolean; corruptBun?: boolean } = {}) {
  const root = fixture({ gitHead: options.gitHead ?? 'a'.repeat(40), ...(options.bun ? {
    applicationRuntime: { name: 'bun', acceptanceRef: 'docs/evidence/candidate.json', harnessSlug: 'papercusp' },
  } : {}) });
  const nodePath = join(root, 'bin/node');
  copyFileSync(process.execPath, nodePath);
  const manifestPath = join(root, 'build-provenance.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.artifacts.find((artifact: { name: string }) => artifact.name === 'bin/node').sha256 =
    createHash('sha256').update(readFileSync(nodePath)).digest('hex');
  if (options.bun) {
    copyFileSync(options.bun, join(root, 'bin/bun'));
    manifest.artifacts.push({ name: 'bin/bun', sha256: createHash('sha256')
      .update(readFileSync(join(root, 'bin/bun'))).digest('hex') });
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  if (options.corruptNode) writeFileSync(nodePath, 'changed runtime bytes');
  if (options.corruptBun) writeFileSync(join(root, 'bin/bun'), 'changed Bun bytes');
  const subject = fileURLToPath(new URL('./vm-release-runtime-policy.ts', import.meta.url));
  const runner = join(root, 'check-host.mjs');
  buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { assertVmReleaseApplicationRuntime } from ${JSON.stringify(subject)};
try {
  const launch = await assertVmReleaseApplicationRuntime({ sidecarDir: process.argv[2],
    hostname: '127.0.0.1', port: 45821,
    ${options.missingReader ? '' : `verifyApplicationRuntimeAcceptance: async ({ candidate, evidenceRef, role }) => {
      ${options.mutateManifest ? `const fs = await import('node:fs'); fs.appendFileSync(process.argv[2] + '/build-provenance.json', ' ');` : ''}
      return ${options.accepted ? `{ verdict: 'accepted', evidenceRef, role,
        candidateSha256: candidate.candidateSha256, sourceSha: candidate.sourceSha,
        binarySha256: candidate.bun.binarySha256, nodeBinarySha256: candidate.node.binarySha256,
        entrypointSha256: candidate.entrypointSha256, validUntil: Date.now() + 60000 }` : 'null'};
    },`}
  });
  process.stdout.write(JSON.stringify({ runtime: launch.runtime, role: launch.role,
    source: launch.candidateSha256, env: launch.env }));
} catch (error) { console.error(error.message); process.exitCode = 42; }
` }, outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  // Run the verifier under the actual package path, or a byte-identical foreign
  // Node for the negative control. No database or host service is started.
  const executable = options.foreignNode || options.corruptNode || options.corruptBun ? process.execPath
    : options.bun ? join(root, 'bin/bun') : nodePath;
  return { root, nodePath, result: spawnSync(executable, [runner, root], {
    env: { ...vmEnv }, encoding: 'utf8', timeout: 20_000,
  }) };
}

describe('ordinary package host runtime selection', () => {
  it('keeps non-vm launches unchanged without reading a package', async () => {
    await expect(assertVmReleaseApplicationRuntime({ env: {}, sidecarDir: '/absent',
      hostname: '127.0.0.1', port: 3170 })).resolves.toBeNull();
  });

  it('uses the real package-pinned Node as the ordinary host default', () => {
    const { nodePath, result } = runPackagedRuntime();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ role: 'host', runtime: {
      name: 'node', executable: nodePath, version: process.versions.node,
      platform: process.platform, arch: process.arch,
    } });
  }, 30_000);

  it('refuses an outside interpreter even when its Node bytes are identical', () => {
    const { result } = runPackagedRuntime({ foreignNode: true });
    expect(result.status, result.stderr).toBe(42);
    expect(result.stderr).toContain('package-pinned Node executable');
  }, 30_000);

  it('refuses provenance without an exact source revision', () => {
    const { result } = runPackagedRuntime({ gitHead: 'unknown' });
    expect(result.status, result.stderr).toBe(42);
    expect(result.stderr).toContain('exact provenance gitHead');
  }, 30_000);

  it('rejects changed retained Node bytes before an identity subprocess', () => {
    const { result } = runPackagedRuntime({ corruptNode: true });
    expect(result.status, result.stderr).toBe(42);
    expect(result.stderr).toContain('artifact bin/node hash mismatch');
  }, 30_000);

  // The native Bun matrix supplies a pinned interpreter explicitly. Source-only
  // runs still cover declaration/reader refusal; no PATH executable is substituted.
  const nativeBun = process.env.PAPERCUSP_RUNTIME_TEST_BUN;
  it.skipIf(!nativeBun)('qualifies the real package-pinned Bun with retained Node and canonical callback', () => {
    const { result } = runPackagedRuntime({ bun: nativeBun, accepted: true });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ role: 'host', runtime: { name: 'bun' } });
  }, 30_000);
  it.skipIf(!nativeBun).each([
    ['unaccepted candidate', { accepted: false }, 'Matching current candidate acceptance'],
    ['missing authority', { missingReader: true }, 'canonical Bun acceptance reader'],
    ['foreign interpreter', { foreignNode: true, accepted: true }, 'package-pinned Bun'],
    ['mutated manifest', { mutateManifest: true, accepted: true }, 'build provenance changed'],
    ['corrupted Bun', { corruptBun: true }, 'artifact bin/bun hash mismatch'],
  ] as const)('rejects real packaged Bun %s', (_label, options, message) => {
    const { result } = runPackagedRuntime({ bun: nativeBun, ...options });
    expect(result.status, result.stderr).toBe(42);
    expect(result.stderr).toContain(message);
  }, 30_000);
});

describe('vm-release runtime policy', () => {
  it('is a byte-for-byte behavior no-op outside the exact vm-release profile', () => {
    expect(() =>
      assertVmReleaseRuntimePolicy({
        env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'dogfood' },
        sidecarDir: '/does/not/exist',
        hostname: '0.0.0.0',
        port: 3170,
      }),
    ).not.toThrow();
  });

  it('accepts an exact loopback package manifest and all declared hashes', () => {
    const env: NodeJS.ProcessEnv = { ...vmEnv };
    expect(() =>
      assertVmReleaseRuntimePolicy({
        env,
        sidecarDir: fixture(),
        hostname: '127.0.0.1',
        port: 45821,
      }),
    ).not.toThrow();
    expect(env.PAPERCUSP_TRANSFORMERS_LOCAL_ONLY).toBe('1');
  });

  it('refuses a missing or corrupt required model pack before readiness and names recovery', () => {
    const missing = fixture();
    unlinkSync(join(missing, 'node_modules/@huggingface/transformers/models/papercusp-model-assets.json'));
    expect(() =>
      assertVmReleaseRuntimePolicy({ env: { ...vmEnv }, sidecarDir: missing, hostname: '127.0.0.1', port: 45821 }),
    ).toThrow(/signed release containing the pinned local-models pack/);

    const corrupt = fixture();
    writeFileSync(
      join(
        corrupt,
        'node_modules/@huggingface/transformers/models/onnx-community/harrier-oss-v1-0.6b-ONNX/onnx/model.onnx',
      ),
      'tampered',
    );
    expect(() =>
      assertVmReleaseRuntimePolicy({ env: { ...vmEnv }, sidecarDir: corrupt, hostname: '127.0.0.1', port: 45821 }),
    ).toThrow(/model asset (?:size|sha256) mismatch.*replace-with-a-signed-runtime/s);
  });

  it('refuses model/runtime compatibility drift and never enables local-only on a failed pack', () => {
    const root = fixture();
    const packagePath = join(root, 'node_modules/@huggingface/transformers/package.json');
    writeFileSync(packagePath, JSON.stringify({ name: '@huggingface/transformers', version: '9.9.9' }));
    const env: NodeJS.ProcessEnv = { ...vmEnv };
    expect(() =>
      assertVmReleaseRuntimePolicy({ env, sidecarDir: root, hostname: '127.0.0.1', port: 45821 }),
    ).toThrow(/compatibility requires @huggingface\/transformers@4\.2\.0/);
    expect(env.PAPERCUSP_TRANSFORMERS_LOCAL_ONLY).toBeUndefined();
  });

  it('refuses undeclared bytes beside a pinned model', () => {
    const root = fixture();
    writeFileSync(
      join(
        root,
        'node_modules/@huggingface/transformers/models/onnx-community/embeddinggemma-300m-ONNX/unpinned.json',
      ),
      '{}',
    );
    expect(() =>
      assertVmReleaseRuntimePolicy({ env: { ...vmEnv }, sidecarDir: root, hostname: '127.0.0.1', port: 45821 }),
    ).toThrow(/model file inventory mismatch.*unpinned\.json/);
  });

  it.each([
    [{ ...vmEnv, PAPERCUSP_BUILD_VERSION: '9.9.9' }, {}, /manifest version/],
    [{ ...vmEnv, PAPERCUSP_BUILD_SHA: 'wrong' }, {}, /manifest buildSha/],
    [{ ...vmEnv, PAPERCUSP_PROVISION_ENV_OPERATORS: '1' }, {}, /must be exactly 0/],
    [{ ...vmEnv, PAPERCUSP_ENV_OPERATOR_ID: 'staging' }, {}, /second environment operator/],
    [vmEnv, { artifacts: [{ name: '../serve.mjs', sha256: '0'.repeat(64) }] }, /unsafe artifact/],
  ])('rejects an identity/environment violation', (env, manifest, error) => {
    expect(() =>
      assertVmReleaseRuntimePolicy({
        env: env as NodeJS.ProcessEnv,
        sidecarDir: fixture(manifest),
        hostname: '127.0.0.1',
        port: 45821,
      }),
    ).toThrow(error as RegExp);
  });

  it('rejects tampered bytes and unauthenticated off-loopback ingress', () => {
    const root = fixture();
    writeFileSync(join(root, 'serve.mjs'), 'tampered');
    expect(() =>
      assertVmReleaseRuntimePolicy({ env: vmEnv, sidecarDir: root, hostname: '127.0.0.1', port: 45821 }),
    ).toThrow(/hash mismatch/);
    expect(() =>
      assertVmReleaseRuntimePolicy({ env: vmEnv, sidecarDir: fixture(), hostname: '0.0.0.0', port: 45821 }),
    ).toThrow(/ALLOW_REMOTE_ADMIN/);
  });

  it.each([3055, 3170, 3270])('rejects dogfood port %i before and after sticky resolution', (port) => {
    expect(() => assertVmReleaseRuntimePort(port, vmEnv)).toThrow(/dogfood dev\/local\/staging/);
  });
});
