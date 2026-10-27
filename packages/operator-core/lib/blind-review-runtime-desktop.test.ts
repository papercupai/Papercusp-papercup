import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brokerSourceFixture } from './blind-review-source.fixture';
import { write } from './source-preview.fixture';
import { buildRuntimeDesktop, RUNTIME_PRODUCT_ORIGIN } from './blind-review-runtime-desktop';
import { buildRuntimeGeneratedInputs } from './blind-review-generated-inputs';
import { packRuntimeSourceImage } from './blind-review-source-image';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(mode = 'valid') {
  const source = await brokerSourceFixture(roots, { gitCheckout: true, native: true, nativeStorageRefused: mode === 'storage-refused' });
  const tools = mkdtempSync(join(tmpdir(), 'broker-native-tools-')); roots.push(tools);
  const cargoExecutable = join(tools, 'cargo'), registryRoot = join(tools, 'registry');
  mkdirSync(registryRoot); mkdirSync(join(registryRoot, 'index'));
  write(registryRoot, 'cache/fixture', 'measured registry fixture');
  write(registryRoot, 'cache/fixture-index/fixture-registry-crate-1.0.0.crate',
    mode === 'registry-checksum' ? 'modified crate archive' : 'measured crate archive');
  write(registryRoot, 'src/poisoned-crate/lib.rs', 'HOST_MUTABLE_CRATE_SOURCE');
  if (mode === 'registry-redirect') symlinkSync('/etc/passwd', join(registryRoot, 'cache/redirect'));
  write(tools, 'credentials.toml', 'HOST_CARGO_SECRET');
  write(tools, 'config.toml', 'HOST_CARGO_CONFIG');
  write(tools, 'cargo', `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const assert=require('node:assert/strict');
assert.equal(process.env.BROKER_FIXTURE_STORAGE_ADMITTED,'1');
assert.equal(process.env.CARGO_INCREMENTAL,'0');
assert.equal(process.env.CARGO_NET_OFFLINE,'true');
assert.equal(process.env.PAPERCUSP_DESKTOP_NATIVE_DEV,'1');
assert.deepEqual(process.argv.slice(2),['build','--locked','--offline','--bin','papercusp-desktop','--message-format=json']);
assert.equal(fs.existsSync(path.join(process.env.CARGO_HOME,'credentials.toml')),false);
assert.equal(fs.existsSync(path.join(process.env.CARGO_HOME,'config.toml')),false);
assert.equal(fs.readFileSync(path.join(process.env.CARGO_HOME,'registry/cache/fixture'),'utf8'),'measured registry fixture');
assert.equal(fs.existsSync(path.join(process.env.CARGO_HOME,'registry/src')),false);
assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.CARGO_HOME,'registry/verified-archives.json'),'utf8')).length,1);
assert.equal(process.env.BROKER_HOST_SECRET,undefined);
const mode=${JSON.stringify(mode)}, target=process.env.CARGO_TARGET_DIR;
const executable=path.join(mode==='outside'?path.dirname(target):target,'desktop');
if(mode==='script') fs.writeFileSync(executable,'#!/bin/sh\\nexit 0\\n',{mode:0o755});
else {
 const input=path.join(target,'main.c');
 fs.writeFileSync(input,'#include <stdio.h>\\nint main(void) { puts("SEALED_NATIVE_ELF_EXECUTED"); return 0; }\\n');
 const c=cp.spawnSync('/usr/bin/cc',[input,'-o',executable]);
 if(c.status!==0) process.exit(90);
}
if(mode==='non-executable') fs.chmodSync(executable,0o444);
const artifact={reason:'compiler-artifact',target:{name:'papercusp-desktop',kind:['bin'],
 src_path:path.join(process.cwd(),mode==='wrong-source'?'src/foreign.rs':'src/main.rs')},profile:{test:false},executable};
console.log(JSON.stringify(artifact));
if(mode==='duplicate') console.log(JSON.stringify(artifact));
if(mode!=='missing-finish') console.log(JSON.stringify({reason:'build-finished',success:mode!=='failed-finish'}));
`);
  chmodSync(cargoExecutable, 0o755);
  const toolchain = { cargoExecutable, rustcExecutable: '/usr/bin/cc', registryRoot };
  return { ...source, tools, toolchain };
}

describe('native desktop in the sealed runtime closure', () => {
  it('captures and executes a real ELF after removing build/toolchain donors', async () => {
    const f = await fixture();
    const generated = await buildRuntimeGeneratedInputs({ ...f, nativeDesktop: { toolchain: f.toolchain } });
    expect(generated.files.some(row => row.path === 'apps/operator/dist-verify/native/papercusp-desktop')).toBe(true);
    const receipt = readFileSync(join(f.root, 'apps/operator/dist-verify/native/build.json'), 'utf8');
    expect(JSON.parse(receipt)).toMatchObject({ sourceCommit: f.source.sourceCommit, origin: RUNTIME_PRODUCT_ORIGIN });
    expect(receipt).not.toContain(f.custodyRoot);
    expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(false);
    const image = await packRuntimeSourceImage({ ...f, generated });
    try {
      rmSync(f.root, { recursive: true }); rmSync(f.repositoryRoot, { recursive: true }); rmSync(f.tools, { recursive: true });
      const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));
      const run = spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'mount-exec',
        '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
        '--manifest-sha256', image.manifestSha256, '--',
        '/source/apps/operator/dist-verify/native/papercusp-desktop'], {
        stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 30_000,
      });
      expect(run.error).toBeUndefined(); expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('SEALED_NATIVE_ELF_EXECUTED');
    } finally { await image.handle.close(); }
  }, 120_000);

  it.each(['outside', 'script', 'non-executable', 'wrong-source', 'duplicate', 'missing-finish', 'failed-finish', 'registry-redirect', 'registry-checksum'])(
    'refuses non-authoritative or incomplete Cargo output (%s)', async mode => {
      const f = await fixture(mode);
      await expect(buildRuntimeGeneratedInputs({ ...f, nativeDesktop: { toolchain: f.toolchain } })).rejects.toThrow();
      expect(readdirSync(f.custodyRoot).some(name => name.startsWith('broker-build-'))).toBe(false);
      expect(existsSync(join(f.root, 'apps/operator/dist-verify/native/papercusp-desktop'))).toBe(false);
    }, 30_000);

  it('releases the native storage reservation when Cargo evidence is refused', async () => {
    const f = await fixture('missing-finish');
    const work = join(f.custodyRoot, 'native-owned'); mkdirSync(work);
    const env = { PATH: '/usr/bin:/bin', HOME: work, TMPDIR: work };
    await expect(buildRuntimeDesktop({ ...f, work, env, sourceCommit: f.source.sourceCommit })).rejects.toThrow();
    expect(existsSync(join(work, 'cargo-target/released'))).toBe(true);
  });

  it('creates its standalone output before compiling and refuses another build output', async () => {
    const f = await fixture();
    const work = join(f.custodyRoot, 'native-owned'); mkdirSync(work);
    expect(existsSync(join(f.root, 'apps/operator/dist-verify'))).toBe(false);
    await buildRuntimeDesktop({ ...f, work, env: { HOME: work, TMPDIR: work }, sourceCommit: f.source.sourceCommit });
    expect(existsSync(join(f.root, 'apps/operator/dist-verify/native/papercusp-desktop'))).toBe(true);
    await expect(buildRuntimeDesktop({ ...f, work, env: {}, sourceCommit: f.source.sourceCommit })).rejects.toThrow();
  });

  it('refuses storage admission before copying a registry or starting Cargo', async () => {
    const f = await fixture('storage-refused');
    const work = join(f.custodyRoot, 'native-owned'); mkdirSync(work);
    await expect(buildRuntimeDesktop({ ...f, work, env: { HOME: work, TMPDIR: work },
      sourceCommit: f.source.sourceCommit })).rejects.toThrow('NATIVE_STORAGE_REFUSED');
    expect(existsSync(join(work, 'cargo-home/registry'))).toBe(false);
    expect(existsSync(join(work, 'cargo-target/desktop'))).toBe(false);
  });
});
