import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(existsSync(readFileSync(socketReceipt, 'utf8'))).toBe(false);
    const refused = spawnSync('bash', [join(root, 'scripts/mutation-probe.sh'), '--help'], {
      cwd: root, env: { ...env, TMPDIR: dir, VERIFY_TAURI_SOURCE_REF: 'b'.repeat(40) }, encoding: 'utf8', timeout: 10000,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('native runtime source receipt mismatch');
    expect(readdirSync(dir).filter(name => name.startsWith('mutation-probe-source.'))).toEqual([]);
  } finally {
    native.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);

it('cancels an actual native mutation guard and removes its observer and frozen script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-mutation-cancel-test-'));
  const receipt = join(dir, 'receipt.json');
  const marker = join(dir, 'guard-ready');
  const subject = join(dir, 'subject.txt');
  const commit = 'a'.repeat(40);
  writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: commit }));
  writeFileSync(subject, 'alpha\n');
  const native = spawn(process.execPath, ['-e', 'console.log("READY"); setInterval(() => {}, 1000)']);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((done, reject) => {
      native.stdout.once('data', () => done());
      native.once('error', reject);
    });
    child = spawn('bash', [join(root, 'scripts/mutation-probe.sh'), '--file', subject,
      '--mutate', 's/alpha/beta/', '--test',
      `printf '%s' "$PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET" > ${JSON.stringify(marker)}; sleep 30; grep -q alpha {}`], {
      cwd: root,
      env: { ...process.env, TMPDIR: dir, VERIFY_TAURI_PID: String(native.pid), OPERATOR_SOURCE_ROOT: root,
        VERIFY_TAURI_SOURCE_REF: commit, VERIFY_TAURI_SOURCE_RECEIPT: receipt,
        PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET: undefined },
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise<number | null>((done, reject) => {
      child!.once('close', done);
      child!.once('error', reject);
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null)
      await new Promise(done => setTimeout(done, 25));
    expect(existsSync(marker), stderr).toBe(true);
    const socket = readFileSync(marker, 'utf8');
    expect(existsSync(socket)).toBe(true);
    child.kill('SIGTERM');
    expect(await closed, stderr).toBe(143);
    expect(existsSync(socket)).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith('mutation-probe-source.'))).toEqual([]);
    expect(readFileSync(subject, 'utf8')).toBe('alpha\n');
  } finally {
    child?.kill('SIGTERM');
    native.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
