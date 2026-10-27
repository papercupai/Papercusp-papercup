import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const subjects = [
  { name: 'embedder', path: 'memory/src/local-embedder-worker.ts', key: 'memory.local-embedder-worker',
    shutdown: 'shutdownLocalEmbedder', request: "embedViaWorker('hold')", script: 'local-embedder-worker.script.mjs' },
  { name: 'reranker', path: 'rerank/src/local-reranker-worker.ts', key: 'rerank.local-reranker-worker',
    shutdown: 'shutdownLocalReranker', request: "scoreViaWorker({query:'q',texts:['hold'],model:'fixture',dtype:'fp32',device:'cpu',maxLength:16,batchSize:1})",
    script: 'local-reranker-worker.script.mjs' },
];
const runtimes = [{ name: 'Node', executable: process.execPath },
  ...(process.env.PAPERCUSP_RUNTIME_TEST_BUN
    ? [{ name: 'Bun', executable: process.env.PAPERCUSP_RUNTIME_TEST_BUN }] : [])];

// These are product lifecycle tests with real worker_threads, without downloading
// model weights. The already-exited cases seed the existing singleton so that the
// shutdown contract is exercised even when the exit event preceded retirement.
// Live retirement uses the product's own spawn and message/exit handlers.
describe.each(runtimes)('$name product worker lifecycle', ({ name, executable }) => {
  for (const subject of subjects) {
    it.each(['exited-idle', 'exited-pending', 'live-drain', 'live-timeout'])
      (`${subject.name}: %s settles shutdown and rejects cut-off requests`, async scenario => {
        const directory = await mkdtemp(join(tmpdir(), 'product-worker-lifecycle-'));
        try {
          const entry = join(directory, 'host.mjs');
          const singleton = join(root, 'libs/generic/module-singleton/src/index.ts');
          const source = join(root, 'libs/generic', subject.path);
          const host = `
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import * as product from ${JSON.stringify(source)};
import { readPinnedModuleState } from ${JSON.stringify(singleton)};
const state = readPinnedModuleState(${JSON.stringify('@papercusp/' + subject.key)});
const scenario = ${JSON.stringify(scenario)};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let request, rejected = false, exitCode = null;
if (scenario.startsWith('exited')) {
  const worker = new Worker(new URL('./exits.mjs', import.meta.url), { execArgv: [] });
  [exitCode] = await once(worker, 'exit');
  if (worker.threadId !== -1) throw new Error('exit control did not observe threadId=-1');
  state.worker = worker;
  state.workerReady = Promise.resolve();
  if (scenario === 'exited-pending') {
    request = new Promise((resolve, reject) => state.pending.set(0, { resolve, reject }))
      .catch(error => { rejected = /shut down while 1 request/.test(error.message); });
  }
} else {
  request = product.${subject.request}.catch(error => {
    rejected = /shut down while 1 request/.test(error.message);
  });
  for (let attempt = 0; state.pending.size !== 1 && attempt < 1000; attempt++) await delay(5);
  if (state.pending.size !== 1) throw new Error('live control never had a pending request');
  const worker = state.worker;
  worker.on('message', message => {
    if (message.kind === 'retired') process.stdout.write('RETIRED\\n');
  });
  worker.once('exit', code => { exitCode = code; });
}
let deadline;
const completed = await Promise.race([
  product.${subject.shutdown}({ drainMs: 40 }).then(() => true),
  new Promise(resolve => { deadline = setTimeout(() => resolve(false), 1000); }),
]);
clearTimeout(deadline);
if (completed) await request;
product._resetBeforeExitHookForTest();
process.stdout.write('RESULT ' + JSON.stringify({ completed, rejected, exitCode,
  alive: state.worker !== null, pending: state.pending.size, retiring: state.retiring?.size ?? 0,
  runtime: process.versions.bun ? 'Bun' : 'Node' }) + '\\n');
process.exitCode = completed ? 0 : 3;
`;
          // Bundle the current product source, exactly as a host artifact does.
          // Keep its source hashes in assertion context: no committed-source
          // substitution or copied implementation can silently satisfy this test.
          const sourceBytes = await readFile(source);
          await build({ stdin: { contents: host, resolveDir: root, loader: 'ts' }, outfile: entry,
            bundle: true, platform: 'node', format: 'esm', packages: 'external',
            alias: { '@papercusp/module-singleton': singleton }, logLevel: 'silent' });
          expect(await readFile(source)).toEqual(sourceBytes);
          await writeFile(join(directory, 'exits.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.close();\n");
          await writeFile(join(directory, subject.script), `
import { parentPort } from 'node:worker_threads';
parentPort.on('message', message => {
  if (message.kind === 'retire' && ${JSON.stringify(scenario)} !== 'live-timeout') {
    parentPort.postMessage({ kind: 'retired' });
  }
});
parentPort.postMessage({ kind: 'ready' });
`);
          const result = await new Promise<{ code: number | string | null; signal: string | null; stdout: string; stderr: string }>(resolve => {
            execFile(executable, [entry], { timeout: 10_000, env: {}, maxBuffer: 64 << 10 }, (error, stdout, stderr) => {
              const failure = error as (Error & { code?: number | string; signal?: string }) | null;
              resolve({ code: failure?.code ?? 0, signal: failure?.signal ?? null, stdout, stderr });
            });
          });
          const evidence = JSON.stringify({ executable: await realpath(executable), scenario, ...result });
          expect({ code: result.code, signal: result.signal }, evidence).toEqual({ code: 0, signal: null });
          const receipt = JSON.parse(result.stdout.match(/^RESULT (.+)$/m)?.[1] ?? '{}');
          expect(receipt, evidence).toMatchObject({ completed: true, runtime: name, alive: false, pending: 0, retiring: 0,
            rejected: scenario !== 'exited-idle' });
          if (scenario.startsWith('exited')) expect(receipt.exitCode, evidence).toBe(0);
          if (scenario === 'live-drain') expect(result.stdout, evidence).toContain('RETIRED\n');
          if (scenario === 'live-timeout') expect(result.stderr, evidence).toContain('did not report retired');
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }, 20_000);
  }
});
