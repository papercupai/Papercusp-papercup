import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const modulePath = join(root, 'packages/operator-core/lib/testing-native-runtime.ts');
const bwrap = spawnSync('bwrap', ['--dev-bind', '/', '/', '--die-with-parent', '--', 'true']);

it.skipIf(bwrap.status !== 0)('keeps native custody outside a mutation overlay and rejects source mismatch and process exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-runtime-wrapper-test-'));
  const receipt = join(dir, 'receipt.json');
  const socketReceipt = join(dir, 'socket');
  const commit = 'a'.repeat(40);
  writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: commit }));
  const native = spawn(process.execPath, ['-e', 'console.log("READY"); setInterval(() => {}, 1000)']);
  try {
    await new Promise<void>((done, reject) => {
      native.stdout.once('data', () => done());
      native.once('error', reject);
    });
    const env = { ...process.env, VERIFY_TAURI_PID: String(native.pid), OPERATOR_SOURCE_ROOT: root,
      VERIFY_TAURI_SOURCE_REF: commit, VERIFY_TAURI_SOURCE_RECEIPT: receipt,
      PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET: undefined };
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', modulePath, '--with-native-observer', '--',
        'bwrap', '--dev-bind', '/', '/', '--die-with-parent', '--', process.execPath,
        '--import', 'tsx', '--input-type=module', '-e', `
          import assert from 'node:assert/strict';
          import { statSync, writeFileSync } from 'node:fs';
          import { prepareNativeRuntimeReader } from ${JSON.stringify(pathToFileURL(modulePath).href)};
          assert.throws(() => statSync('/proc/' + process.env.VERIFY_TAURI_PID + '/exe'), { code: 'EACCES' });
          writeFileSync(${JSON.stringify(socketReceipt)}, process.env.PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET);
          const read = prepareNativeRuntimeReader(${JSON.stringify(root)}, ${JSON.stringify(commit)});
          assert.match(read().fingerprint, /^[a-f0-9]{64}$/);
          assert.throws(() => prepareNativeRuntimeReader(${JSON.stringify(root)}, 'b'.repeat(40)), /source receipt mismatch/);
          console.log('WITNESS_READY');
          const end = Date.now() + 10000;
          const timer = setInterval(() => {
            if (read() === null) { clearInterval(timer); console.log('EXIT_REFUSED'); process.exitCode = 7; }
            else if (Date.now() > end) { clearInterval(timer); process.exitCode = 9; }
          }, 50);
        `], { cwd: root, env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`observer timed out: ${stderr}`)); }, 30000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('WITNESS_READY')) native.kill('SIGTERM');
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    });
    expect(result.code, result.stderr).toBe(7);
    expect(result.stdout).toContain('EXIT_REFUSED');
    const { readFileSync } = await import('node:fs');
    expect(existsSync(readFileSync(socketReceipt, 'utf8'))).toBe(false);
    const refused = spawnSync('bash', [join(root, 'scripts/mutation-probe.sh'), '--help'], {
      cwd: root, env: { ...env, VERIFY_TAURI_SOURCE_REF: 'b'.repeat(40) }, encoding: 'utf8', timeout: 10000,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('native runtime source receipt mismatch');
  } finally {
    native.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
