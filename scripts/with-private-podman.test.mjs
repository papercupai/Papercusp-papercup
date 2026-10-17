import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runWithPrivatePodman, waitForPrivatePodmanApi } from './with-private-podman.mjs';

async function fixture(t, handle) {
  const dir = await mkdtemp(join(tmpdir(), 'pc-ping-test-'));
  const socketPath = join(dir, 'api.sock');
  const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const server = createServer(handle);
  await new Promise(done => server.listen(socketPath, done));
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) {
      const exited = new Promise(done => host.once('close', done));
      host.kill(); await exited;
    }
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await rm(dir, { recursive: true, force: true });
  });
  return { host, socketPath };
}

test('metadata that never answers cannot block a healthy private API', async t => {
  const paths = [];
  const f = await fixture(t, (req, res) => {
    paths.push(req.url);
    if (req.url === '/_ping') res.end('OK');
    // /version deliberately never answers, matching the diagnosed failure.
  });
  const result = await waitForPrivatePodmanApi({ ...f, timeoutMs: 500 });
  assert.equal(result.attempts, 1);
  assert.deepEqual(paths, ['/_ping']);
});

test('hung bodies are bounded and retries wait for the prior request to close', async t => {
  let active = 0, maxActive = 0, requests = 0;
  const f = await fixture(t, (_req, res) => {
    active++; maxActive = Math.max(active, maxActive); requests++;
    res.once('close', () => active--);
    if (requests === 3) res.end('OK');
    else { res.writeHead(200); res.write('O'); }
  });
  const probes = [];
  await waitForPrivatePodmanApi({ ...f, probes, timeoutMs: 1000, requestTimeoutMs: 40, retryMs: 10 });
  assert.equal(probes.length, 3);
  assert.equal(maxActive, 1);
  assert.equal(probes.filter(probe => probe.error === 'ping deadline exceeded').length, 2);
});

test('HTTP errors and unexpected bodies cannot establish readiness', async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => {
    requests++;
    res.statusCode = requests === 1 ? 503 : 200;
    res.end(requests === 2 ? 'not ready' : 'OK');
  });
  const probes = [];
  await waitForPrivatePodmanApi({ ...f, probes, timeoutMs: 1000, retryMs: 1 });
  assert.deepEqual(probes.map(p => p.ok), [false, false, true]);
});

test('service exit interrupts an in-flight probe', async t => {
  const f = await fixture(t, () => { f.host.kill('SIGTERM'); });
  await assert.rejects(waitForPrivatePodmanApi({ ...f, timeoutMs: 1000 }), /exited before readiness/);
});

test('startup deadline refuses an unresponsive API', async t => {
  const f = await fixture(t, () => {});
  const probes = [];
  await assert.rejects(waitForPrivatePodmanApi({ ...f, probes, timeoutMs: 80, requestTimeoutMs: 30, retryMs: 1 }),
    /startup deadline/);
  assert.ok(probes.length >= 1);
  assert.equal(probes.some(p => p.ok), false);
});

test('owned service is cleaned after command failure and preserves its exit code', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-podman-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const podman = join(dir, 'podman');
  await writeFile(podman, `#!/usr/bin/env node
const http=require('node:http');
const endpoint=process.argv.at(-1);
http.createServer((req,res)=>{res.end(req.url==='/_ping'?'OK':'unexpected')}).listen(endpoint.slice(7));
`);
  await chmod(podman, 0o755);
  const evidenceDir = join(dir, 'evidence');
  const code = await runWithPrivatePodman(process.execPath, ['-e',
    'if(!process.env.DOCKER_HOST.startsWith("unix://"))process.exit(99);process.exit(7)'],
    { podman, evidenceDir });
  assert.equal(code, 7);
  const receipt = JSON.parse(await readFile(join(evidenceDir, 'receipt.json'), 'utf8'));
  assert.equal(receipt.readiness.attempts >= 1, true);
  assert.deepEqual(receipt.cleanup, { apiStopped: true, commandStopped: true });
  assert.throws(() => process.kill(receipt.apiPid, 0), { code: 'ESRCH' });
});

test('failed service spawn is retained and no test command starts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-podman-spawn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const evidenceDir = join(dir, 'evidence');
  await assert.rejects(runWithPrivatePodman(process.execPath, ['-e', 'process.exit(99)'],
    { podman: join(dir, 'missing'), evidenceDir }), /ENOENT/);
  const receipt = JSON.parse(await readFile(join(evidenceDir, 'receipt.json'), 'utf8'));
  assert.equal(receipt.commandPid, undefined);
  assert.equal(receipt.cleanup.apiStopped, true);
});

test('cancellation cleans an active test command and its private API', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-podman-abort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const podman = join(dir, 'podman');
  await writeFile(podman, `#!/usr/bin/env node
require('node:http').createServer((req,res)=>res.end('OK')).listen(process.argv.at(-1).slice(7));
`);
  await chmod(podman, 0o755);
  const evidenceDir = join(dir, 'evidence');
  const abort = new AbortController();
  const marker = join(dir, 'started');
  const running = runWithPrivatePodman(process.execPath, ['-e',
    'require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)', marker],
    { podman, evidenceDir, signal: abort.signal });
  const timer = setTimeout(() => abort.abort(new Error('test deadline')), 5000);
  try {
    for (;;) {
      try { await readFile(marker); break; } catch { /* command has not started yet */ }
      if (abort.signal.aborted) break;
      await new Promise(done => setTimeout(done, 10));
    }
    abort.abort(new Error('requested cancellation'));
    await assert.rejects(running, /requested cancellation/);
  } finally { clearTimeout(timer); }
  const receipt = JSON.parse(await readFile(join(evidenceDir, 'receipt.json'), 'utf8'));
  assert.deepEqual(receipt.cleanup, { apiStopped: true, commandStopped: true });
  assert.throws(() => process.kill(receipt.commandPid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(receipt.apiPid, 0), { code: 'ESRCH' });
});

test('failed readiness cleans the API and keeps the command unstarted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-podman-unready-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const podman = join(dir, 'podman');
  await writeFile(podman, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n');
  await chmod(podman, 0o755);
  const evidenceDir = join(dir, 'evidence');
  await assert.rejects(runWithPrivatePodman(process.execPath, ['-e', 'process.exit(99)'],
    { podman, evidenceDir, timeoutMs: 50 }), /startup deadline/);
  const receipt = JSON.parse(await readFile(join(evidenceDir, 'receipt.json'), 'utf8'));
  assert.equal(receipt.commandPid, undefined);
  assert.equal(receipt.cleanup.apiStopped, true);
  assert.throws(() => process.kill(receipt.apiPid, 0), { code: 'ESRCH' });
});
