import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const subject = fileURLToPath(new URL('./cluster-fork.ts', import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const runtimes = [{ name: 'node', executable: process.execPath },
  ...(process.env.PAPERCUSP_RUNTIME_TEST_BUN
    ? [{ name: 'bun', executable: process.env.PAPERCUSP_RUNTIME_TEST_BUN }] : [])];

describe.each(runtimes)('$name actual cluster process roles', ({ name, executable }) => {
  it('keeps initial and replacement workers on the measured interpreter and request-only contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cluster-runtime-'));
    try {
      const entry = join(directory, 'cluster-host.mjs');
      const sourceBytes = await readFile(subject);
      await build({ stdin: { resolveDir: directory, loader: 'ts', contents: `
import cluster from 'node:cluster';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startCluster } from ${JSON.stringify(subject)};
const identity = () => ({ runtime: process.versions.bun ? 'bun' : 'node',
  version: process.versions.bun || process.versions.node, executable: realpathSync(process.execPath),
  binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  background: process.env.PAPERCUSP_BACKGROUND_WORKERS, pid: process.pid });
const workers = [];
let primaryCalls = 0, handle, replaced = false, timer;
const finish = () => {
  clearTimeout(timer);
  const result = { parent: identity(), primaryCalls, workers, live: handle.liveWorkerCount() };
  handle.drain();
  cluster.disconnect(() => process.stdout.write('RESULT ' + JSON.stringify(result) + '\\n'));
};
if (cluster.isPrimary) {
  process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
  timer = setTimeout(() => { handle?.drain(); process.exit(3); }, 8000);
  cluster.on('message', (worker, message) => {
    if (message?.kind !== 'role') return;
    workers.push(message.identity);
    if (workers.length === 2 && !replaced) { replaced = true; worker.kill('SIGKILL'); }
    if (workers.length === 3) finish();
  });
}
handle = startCluster({ workers: 2, workerEnv: { PAPERCUSP_BACKGROUND_WORKERS: '1' },
  onPrimary() { primaryCalls++; }, onWorker() {
    process.on('disconnect', () => process.exit(0));
    process.send({ kind: 'role', identity: identity() });
  }, log() {} });
` }, outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
      expect(await readFile(subject)).toEqual(sourceBytes);
      const result = await new Promise<{ code: number | string; signal: string | null; stdout: string; stderr: string }>(resolve => {
        execFile(executable, [entry], { env: {}, timeout: 15_000, maxBuffer: 64 << 10 }, (error, stdout, stderr) => {
          const failure = error as (Error & { code?: number | string; signal?: string }) | null;
          resolve({ code: failure?.code ?? 0, signal: failure?.signal ?? null, stdout, stderr });
        });
      });
      const context = JSON.stringify({ executable, sourceSha256: digest(sourceBytes), ...result });
      expect({ code: result.code, signal: result.signal }, context).toEqual({ code: 0, signal: null });
      const receipt = JSON.parse(result.stdout.match(/^RESULT (.+)$/m)?.[1] ?? '{}');
      const pin = { runtime: name, executable: await realpath(executable), binarySha256: digest(await readFile(executable)) };
      expect(receipt, context).toMatchObject({ parent: { ...pin, background: '1' }, primaryCalls: 1, live: 2 });
      expect(receipt.workers, context).toHaveLength(3);
      for (const worker of receipt.workers) expect(worker, context).toMatchObject({ ...pin, background: '0' });
      expect(new Set(receipt.workers.map((worker: { pid: number }) => worker.pid)).size, context).toBe(3);
      expect(await readFile(subject)).toEqual(sourceBytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
