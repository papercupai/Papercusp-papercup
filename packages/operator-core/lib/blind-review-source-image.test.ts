import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { captureVerifierDependencies, prepareVerifierSource } from '../../../scripts/source-preview.mjs';
import * as preview from '../../../scripts/source-preview.mjs';
import { git, write } from './source-preview.fixture';
import { packRuntimeSourceClosure, packRuntimeSourceImage, prepareRuntimeSourceImage,
  encodeRuntimeClosureManifest, RuntimeSourcePackFailure, type RuntimeSourceImage } from './blind-review-source-image';
import { runtimeInputsMustBeRetained } from './blind-review-generated-inputs';

const packControl = vi.hoisted(() => ({ fail: false }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (packControl.fail && args[0] === '/usr/bin/mksquashfs') {
      const argv = [...args[1]!]; argv[0] += '/missing-pack-control'; args[1] = argv;
    }
    return actual.spawn(...args);
  } };
});

const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));
const policy = fileURLToPath(new URL('../../../apps/operator/bin/release/dependency-generation.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); packControl.fail = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const custodyRoot = mkdtempSync(join(tmpdir(), 'broker-producer-')); roots.push(custodyRoot);
  const repo = join(custodyRoot, 'repo'), root = join(custodyRoot, 'frozen');
  mkdirSync(repo);
  write(repo, 'package.json', '{"name":"broker-fixture","private":true}');
  write(repo, 'src/input.ts', 'export const marker = "committed source";\n');
  write(repo, 'src/duplicate.ts', 'export const marker = "committed source";\n');
  write(repo, 'bin/duplicate-source', 'export const marker = "committed source";\n');
  chmodSync(join(repo, 'bin/duplicate-source'), 0o755);
  write(repo, 'papercusp-desktop/bin/lib/pinned-deps.sh', '#!/bin/bash\n[ "$1" = trees ] || exit 2\nprintf "node_modules\\n"\n');
  write(repo, 'apps/operator/bin/release/dependency-generation.sh', readFileSync(policy, 'utf8'));
  write(repo, 'bin/run', '#!/bin/sh\nprintf "recorded executable"\n'); chmodSync(join(repo, 'bin/run'), 0o755);
  symlinkSync('src/input.ts', join(repo, 'source-link'));
  git(repo, ['init', '-q']); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'pinned broker fixture']);
  const source = await prepareVerifierSource({ repo, ref: git(repo, ['rev-parse', 'HEAD']),
    dest: root, inputs: ['src/input.ts'] });
  // The production dependency census/writer measures these installed bytes,
  // including its real exclusions and a real workspace symlink.
  write(root, 'node_modules/dep/index.js', 'module.exports = "measured dependency";\n');
  write(root, 'node_modules/.cache/ambient-secret', 'MUST_NOT_SHIP');
  symlinkSync('../src', join(root, 'node_modules/workspace-source'));
  const dependencies = captureVerifierDependencies({ dest: root, receipt: source });
  return { root, custodyRoot, source, dependencies };
}

function mount(image: RuntimeSourceImage, code: string, manifestSha256 = image.manifestSha256) {
  return spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'seal-exec', '--sha256', image.imageSha256,
    '--max-bytes', String(image.imageBytes), '--', '/usr/bin/python3', '-I', '-S', helper,
    'mount-exec', '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
    '--manifest-sha256', manifestSha256, '--', '/usr/bin/python3', '-I', '-S', '-c', code],
  { stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 20_000 });
}

describe('canonical broker source image producer', () => {
  it('admits a bounded compressed UTF-8 manifest while the legacy representation exceeds the wire budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'broker-manifest-budget-')); roots.push(root);
    const manifest = { version: 1 as const, sourceCommit: 'a'.repeat(40),
      sourceReceiptSha256: 'b'.repeat(64), dependenciesReceiptSha256: 'c'.repeat(64),
      files: Array.from({ length: 80_000 }, (_, index) => ({ path: index + '/' + '界'.repeat(128),
        kind: 'file' as const, executable: false, sha256: 'd'.repeat(64) })) };
    const encoded = JSON.stringify(manifest);
    expect(encoded.length).toBeLessThan(32 * 1024 * 1024);
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(32 * 1024 * 1024);
    const compressed = encodeRuntimeClosureManifest(manifest);
    expect(compressed.length).toBeLessThan(32 * 1024 * 1024);
    writeFileSync(join(root, '.broker-closure.json'), encoded);
    const rejected = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import importlib.util
spec=importlib.util.spec_from_file_location('source_helper',${JSON.stringify(helper)})
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.verify_manifest(${JSON.stringify(root)},'e'*64)
`], { encoding: 'utf8', timeout: 10_000 });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('closure_manifest_invalid');
    rmSync(join(root, '.broker-closure.json'));
    writeFileSync(join(root, '.broker-closure.json.gz'), compressed);
    const accepted = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import importlib.util
spec=importlib.util.spec_from_file_location('source_helper',${JSON.stringify(helper)})
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest=module.read_manifest(${JSON.stringify(root)},${JSON.stringify(createHash('sha256').update(compressed).digest('hex'))})
assert len(manifest['files']) == 80000
`], { encoding: 'utf8', timeout: 10_000 });
    expect(accepted.status, accepted.stderr).toBe(0);
  });

  it('bounds compressed manifest expansion before parsing and rejects two manifest identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'broker-manifest-expansion-')); roots.push(root);
    const bomb = gzipSync(Buffer.alloc(128 * 1024 * 1024 + 1, 32), { level: 1 });
    writeFileSync(join(root, '.broker-closure.json.gz'), bomb);
    const run = () => spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import importlib.util
spec=importlib.util.spec_from_file_location('source_helper',${JSON.stringify(helper)})
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.read_manifest(${JSON.stringify(root)},${JSON.stringify(createHash('sha256').update(bomb).digest('hex'))})
`], { encoding: 'utf8', timeout: 10_000 });
    expect(run().stderr).toContain('closure_manifest_expansion_invalid');
    writeFileSync(join(root, '.broker-closure.json'), '{}');
    expect(run().stderr).toContain('closure_manifest_invalid');
  });

  it.each([0, 74])('prewarms the exact cross-device input before source materialization (exit %s)', async exitCode => {
    const f = await fixture();
    const custodyRoot = mkdtempSync('/dev/shm/broker-source-prewarm-'); roots.push(custodyRoot);
    expect(statSync(custodyRoot).dev).not.toBe(statSync(f.root).dev);
    write(f.root, 'scripts/npm-install-safe.mjs', `
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]!=='--exec-under-lock'||args[1]!=='--')process.exit(88);
process.exit(spawnSync(args[2],args.slice(3),{stdio:'inherit'}).status??1);
`);
    write(f.root, 'apps/operator/bin/release/dependency-generation.sh', `#!/bin/bash
set -eu
[ "$1" = --integration ] && [ "$2" = "$PWD" ] && [ "$3" = --ensure-ref ] && [ "$4" = ${f.source.sourceCommit} ] && [ "$5" = --retain-as ] && [ "$6" = blind-review-${f.source.sourceCommit.slice(0, 48)} ] || exit 95
printf exact-ref > warm-marker
exit ${exitCode}
`);
    const stop = new Error('source-materialization-control');
    const materialize = vi.spyOn(preview, 'prepareVerifierSource').mockImplementationOnce(async () => {
      expect(readFileSync(join(f.root, 'warm-marker'), 'utf8')).toBe('exact-ref');
      throw stop;
    });
    const preparation = prepareRuntimeSourceImage({ repositoryRoot: f.root, custodyRoot,
      sourceCommit: f.source.sourceCommit, inputs: ['src/input.ts'] });
    if (exitCode === 0) {
      await expect(preparation).rejects.toBe(stop);
      expect(materialize).toHaveBeenCalledOnce();
    } else {
      await expect(preparation).rejects.toThrow('verifier dependency preflight failed');
      expect(materialize).not.toHaveBeenCalled();
    }
    expect(readFileSync(join(f.root, 'warm-marker'), 'utf8')).toBe('exact-ref');
    expect(readdirSync(custodyRoot)).toEqual([]);
  });

  it('preserves the measured closure and terminal phase receipt after a real compressor failure', async () => {
    const f = await fixture();
    packControl.fail = true;
    let failure: unknown;
    try { await packRuntimeSourceImage(f); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RuntimeSourcePackFailure);
    expect(runtimeInputsMustBeRetained(failure)).toBe(true);
    const retained = (failure as RuntimeSourcePackFailure).retainedInputRoot!;
    expect(retained).toMatch(/broker-source-/);
    const receipt = JSON.parse(readFileSync(join(retained, 'pack-attempt.json'), 'utf8'));
    expect(receipt).toMatchObject({ version: 1, status: 'failed', sourceCommit: f.source.sourceCommit,
      diagnostics: { timedOut: false, aborted: false, signal: null } });
    expect(receipt.diagnostics.exitCode).not.toBe(0);
    expect(receipt.inputFiles).toBeGreaterThan(0); expect(receipt.inputBytes).toBeGreaterThan(0);
    expect(readFileSync(join(retained, 'closure/src/input.ts'), 'utf8')).toContain('committed source');
    const copied = statSync(join(retained, 'closure/src/input.ts'));
    expect(copied.ino).toBe(statSync(join(retained, 'closure/src/duplicate.ts')).ino);
    expect(copied.ino).not.toBe(statSync(join(retained, 'closure/bin/duplicate-source')).ino);
    expect(copied.ino).not.toBe(statSync(join(f.root, 'src/input.ts')).ino);
    writeFileSync(join(f.root, 'src/input.ts'), 'donor changed after independent copy');
    expect(readFileSync(join(retained, 'closure/src/duplicate.ts'), 'utf8')).toContain('committed source');
    // Re-run only the preserved pack stage. This is a diagnosis control, never
    // a reconstructed producer origin or an admission receipt.
    packControl.fail = false;
    await packRuntimeSourceClosure(join(retained, 'closure'), join(retained, 'stage-retry.squashfs'));
  });

  it('retains compressor failure diagnostics and verifies the pack stage without rebuilding the product', async () => {
    const f = await fixture();
    const output = join(f.custodyRoot, 'focused.squashfs');
    let failure: unknown;
    try { await packRuntimeSourceClosure(join(f.root, 'missing-source'), output); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RuntimeSourcePackFailure);
    const diagnostics = (failure as RuntimeSourcePackFailure).diagnostics;
    expect(diagnostics).toMatchObject({ signal: null, timedOut: false, aborted: false, spawnErrorCode: null });
    expect(diagnostics.exitCode).not.toBe(0);
    expect(diagnostics.stderrTail).toMatch(/Cannot stat|No such file/i);
    expect(Buffer.byteLength(diagnostics.stderrTail)).toBeLessThanOrEqual(8192);
    expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
    await packRuntimeSourceClosure(f.root, output);
    const listing = spawnSync('/usr/bin/unsquashfs', ['-ll', output], { encoding: 'utf8', timeout: 10_000 });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain('src/input.ts');
  });

  it('boots the real sealed closure with measured dependencies, manifests and executable modes after donor removal', async () => {
    const f = await fixture();
    const image = await packRuntimeSourceImage(f);
    try {
      expect((await image.handle.stat()).nlink).toBe(0);
      expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-source-'))).toBe(false);
      rmSync(f.root, { recursive: true });
      const result = mount(image, `
import os,json,errno,hashlib,gzip
assert 'committed source' in open('/source/src/input.ts').read()
assert 'committed source' in open('/source/node_modules/workspace-source/input.ts').read()
assert 'measured dependency' in open('/source/node_modules/dep/index.js').read()
assert os.readlink('/source/source-link') == 'src/input.ts'
assert os.stat('/source/bin/run').st_mode & 0o111
assert not os.path.exists('/source/node_modules/.cache')
manifest=json.load(gzip.open('/source/.broker-closure.json.gz'))
deps=json.load(open('/source/.broker-dependencies.json'))
assert deps['root'] == '/source'
paths={row['path'] for row in manifest['files']}
assert {'.verifier-source.json','.broker-dependencies.json'} <= paths
assert manifest['sourceReceiptSha256'] == deps['sourceReceiptSha256']
assert hashlib.sha256(open('/source/.broker-dependencies.json','rb').read()).hexdigest() == manifest['dependenciesReceiptSha256']
try: open('/source/src/input.ts','w')
except OSError as error: assert error.errno == errno.EROFS
else: raise AssertionError('source writable')
print('CANONICAL_CLOSURE_BOOTED')`);
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('CANONICAL_CLOSURE_BOOTED');
    } finally { await image.handle.close(); }
  });

  it('refuses a wrong manifest pin before executing the child and does not rely on receipt-shaped metadata', async () => {
    const f = await fixture(); const image = await packRuntimeSourceImage(f);
    try {
      const result = mount(image, "print('CHILD_EXECUTED')", '0'.repeat(64));
      expect(result.status).toBe(3); expect(result.stdout).not.toContain('CHILD_EXECUTED');
      expect(result.stderr).toContain('SEALED_SOURCE_REFUSED');
    } finally { await image.handle.close(); }
  });

  it.each(['dependency-bytes', 'omitted-dependency', 'source-bytes', 'unrecorded-source', 'source-receipt'])(
    'refuses changed or incomplete verifier provenance (%s) without publishing an image', async defect => {
      const f = await fixture();
      if (defect === 'dependency-bytes') write(f.root, 'node_modules/dep/index.js', 'changed');
      if (defect === 'omitted-dependency') f.dependencies.trees[0]!.files.pop();
      if (defect === 'source-bytes') write(f.root, 'src/input.ts', 'changed');
      if (defect === 'unrecorded-source') write(f.root, 'unrecorded.ts', 'unknown input');
      if (defect === 'source-receipt') write(f.root, '.verifier-source.json', '{}');
      await expect(packRuntimeSourceImage(f)).rejects.toThrow();
      expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-source-'))).toBe(false);
    });

  it('refuses escaping dependency symlinks through the canonical dependency census', async () => {
    const f = await fixture();
    symlinkSync('/etc/passwd', join(f.root, 'node_modules/escape'));
    await expect(packRuntimeSourceImage(f)).rejects.toThrow('symlink escapes source root');
  });

  it('honors cancellation before allocating image storage and requires an exact source commit', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(packRuntimeSourceImage({ ...f, signal: controller.signal })).rejects.toThrow();
    await expect(prepareRuntimeSourceImage({ repositoryRoot: f.root, custodyRoot: f.custodyRoot,
      sourceCommit: 'HEAD', inputs: ['src/input.ts'] })).rejects.toThrow('broker_requires_exact_commit');
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-source-'))).toBe(false);
  });
});
