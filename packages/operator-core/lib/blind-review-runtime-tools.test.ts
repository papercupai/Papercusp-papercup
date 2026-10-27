import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureRuntimeTools } from './blind-review-runtime-tools';
import { buildRuntimeGeneratedInputs, verifyRuntimeGeneratedInputs } from './blind-review-generated-inputs';
import { packRuntimeSourceImage } from './blind-review-source-image';
import { brokerSourceFixture } from './blind-review-source.fixture';
import { write } from './source-preview.fixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'broker-runtime-tools-')); roots.push(root);
  const driverRoot = join(root, 'driver'), nodeExecutable = join(root, 'node');
  const destination = join(root, 'captured');
  write(root, 'node', '#!/bin/sh\nexit 0\n'); chmodSync(nodeExecutable, 0o755);
  write(driverRoot, 'package.json', JSON.stringify({ name: 'tauri-agent-tools', version: '1.0.0',
    bin: { 'tauri-agent-tools': './dist/cli.js' }, dependencies: { 'fixture-dep': '1.0.0' } }));
  write(driverRoot, 'dist/cli.js', 'console.log("driver-fixture");');
  write(driverRoot, 'node_modules/fixture-dep/package.json', '{"name":"fixture-dep","version":"1.0.0","main":"index.js"}');
  write(driverRoot, 'node_modules/fixture-dep/index.js', 'module.exports = "dependency-fixture";');
  write(driverRoot, 'node_modules/fixture-dep/empty.d.ts', '');
  write(driverRoot, '.npmrc', 'HOST_REGISTRY_CREDENTIAL_CANARY');
  write(driverRoot, 'host-profile', 'HOST_PROFILE_CANARY');
  return { root, driverRoot, nodeExecutable, destination };
}

describe('runtime tools captured into the measured sealed closure', () => {
  it('copies independent regular bytes and excludes host config, profiles and package siblings', async () => {
    const f = fixture();
    symlinkSync('../node_modules/fixture-dep/index.js', join(f.driverRoot, 'dist/dependency-alias.js'));
    await captureRuntimeTools(f.destination, f);
    expect(readFileSync(join(f.destination, 'node'), 'utf8')).toContain('#!/bin/sh');
    expect(lstatSync(join(f.destination, 'driver/dist/dependency-alias.js')).isFile()).toBe(true);
    expect(readFileSync(join(f.destination, 'driver/dist/dependency-alias.js'), 'utf8')).toContain('dependency-fixture');
    expect(existsSync(join(f.destination, 'driver/.npmrc'))).toBe(false);
    expect(existsSync(join(f.destination, 'driver/host-profile'))).toBe(false);
    write(f.driverRoot, 'dist/cli.js', 'changed donor');
    expect(readFileSync(join(f.destination, 'driver/dist/cli.js'), 'utf8')).toContain('driver-fixture');
    const receipt = JSON.parse(readFileSync(join(f.destination, 'tools.json'), 'utf8'));
    expect(receipt.driver).toMatchObject({ name: 'tauri-agent-tools', version: '1.0.0' });
    expect(JSON.stringify(receipt)).not.toContain(f.root);
  });

  it.each(['outside-file', 'cycle', 'non-executable-node', 'foreign-dependency', 'metadata-redirect', 'fifo-node'])(
    'refuses an incomplete or escaping runtime closure (%s)', async defect => {
      const f = fixture();
      if (defect === 'outside-file') symlinkSync('/etc/passwd', join(f.driverRoot, 'dist/outside'));
      if (defect === 'cycle') symlinkSync('.', join(f.driverRoot, 'dist/cycle'));
      if (defect === 'non-executable-node') chmodSync(f.nodeExecutable, 0o644);
      if (defect === 'metadata-redirect') {
        rmSync(join(f.driverRoot, 'package.json'));
        symlinkSync('/etc/passwd', join(f.driverRoot, 'package.json'));
      }
      if (defect === 'fifo-node') {
        rmSync(f.nodeExecutable);
        expect(spawnSync('/usr/bin/mkfifo', [f.nodeExecutable]).status).toBe(0);
      }
      if (defect === 'foreign-dependency') {
        mkdirSync(join(f.root, 'node_modules'), { recursive: true });
        const dependency = join(f.driverRoot, 'node_modules/fixture-dep');
        rmSync(dependency, { recursive: true });
        write(f.root, 'node_modules/fixture-dep/package.json', '{"name":"fixture-dep","main":"index.js"}');
        write(f.root, 'node_modules/fixture-dep/index.js', 'host sibling');
      }
      await expect(captureRuntimeTools(f.destination, f)).rejects.toThrow();
      expect(existsSync(f.destination)).toBe(false);
    });

  it('refuses canceled capture and an existing destination without deleting another invocation', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(captureRuntimeTools(f.destination, f, controller.signal)).rejects.toThrow();
    expect(existsSync(f.destination)).toBe(false);
    write(f.destination, 'sentinel', 'prior-invocation');
    await expect(captureRuntimeTools(f.destination, f)).rejects.toThrow();
    expect(readFileSync(join(f.destination, 'sentinel'), 'utf8')).toBe('prior-invocation');
  });

  it('executes the captured Node and driver after donor removal inside the sealed network/PID/mount scope', async () => {
    const f = fixture();
    const source = await brokerSourceFixture(roots, { gitCheckout: true });
    const generated = await buildRuntimeGeneratedInputs({ ...source,
      runtimeTools: { nodeExecutable: process.execPath, driverRoot: f.driverRoot } });
    expect(generated.files.some(file => file.path === 'apps/operator/dist-verify/runtime/node')).toBe(true);
    const capturedDependency = 'apps/operator/dist-verify/runtime/driver/node_modules/fixture-dep/index.js';
    expect(generated.files.some(file => file.path === capturedDependency)).toBe(true);
    // Excluding emitted dependencies from the source-install census must never
    // exclude their bytes from the generated closure's integrity check.
    const capturedPath = join(source.root, capturedDependency);
    const originalDependency = readFileSync(capturedPath, 'utf8');
    chmodSync(capturedPath, 0o644);
    write(source.root, capturedDependency, 'changed captured driver dependency');
    await expect(verifyRuntimeGeneratedInputs(source.root, source.source, source.dependencies, generated))
      .rejects.toThrow('broker_generated_inputs_changed');
    write(source.root, capturedDependency, originalDependency);
    chmodSync(capturedPath, 0o444);
    const image = await packRuntimeSourceImage({ ...source, generated });
    const listener = createServer(socket => { socket.destroy(); });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    const hostNamespaces = Object.fromEntries(['net', 'pid', 'mnt', 'ipc', 'user']
      .map(kind => [kind, readlinkSync('/proc/self/ns/' + kind)]));
    try {
      rmSync(source.root, { recursive: true }); rmSync(source.repositoryRoot, { recursive: true });
      rmSync(f.driverRoot, { recursive: true });
      const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));
      const result = spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'mount-exec',
        '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
        '--manifest-sha256', image.manifestSha256, '--',
        '/source/apps/operator/dist-verify/runtime/node', '--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
assert.equal(process.env.BROKER_HOST_SECRET, undefined);
assert.equal(existsSync(${JSON.stringify(f.root)}), false);
for (const [kind,id] of Object.entries(${JSON.stringify(hostNamespaces)}))
 assert.notEqual(readlinkSync('/proc/self/ns/' + kind), id, kind + '_namespace_shared');
assert.throws(() => writeFileSync('/source/apps/operator/dist-verify/runtime/node', 'changed'));
assert.equal(readFileSync('/source/apps/operator/dist-verify/runtime/driver/node_modules/fixture-dep/empty.d.ts','utf8'),'');
await new Promise((resolve,reject) => {
 const socket = createConnection({host:'127.0.0.1',port:${port}});
 socket.setTimeout(1000);
 socket.once('connect',()=>{socket.destroy();reject(new Error('host_listener_reachable'));});
 socket.once('timeout',()=>{socket.destroy();reject(new Error('host_network_probe_indeterminate'));});
 socket.once('error',error=>{try { assert.ok(['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(error.code));resolve(); } catch(error){reject(error);}});
});
await import('/source/apps/operator/dist-verify/runtime/driver/dist/cli.js');
console.log('SEALED_RUNTIME_TOOLS_EXECUTED');`], {
        stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 30_000,
        env: { PATH: '/usr/bin:/bin', BROKER_HOST_SECRET: 'HOST_ENV_CANARY' },
      });
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('driver-fixture');
      expect(result.stdout).toContain('SEALED_RUNTIME_TOOLS_EXECUTED');
    } finally {
      await image.handle.close();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  }, 120_000);
});
