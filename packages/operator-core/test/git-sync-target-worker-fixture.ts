/** Real HTTP/MCP and git-sync composition, always under with-test-pg isolation. */
import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';
import { handler } from '../../../apps/operator/bin/host-handler';
import { createMcpProxy, readMcpWorkerTargets } from '../../../apps/operator/lib/mcp-proxy/proxy';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { writeEndpointIpcDiscovery } from '../lib/endpoint-ipc-discovery';
import { readSuperuserToken, superuserTokenPath } from '../lib/superuser-token';
import { getServingHostIdentity } from '../lib/serving-host-identity';
import { readProcessIdentity } from '../lib/process-identity';
import { runEmbedSidecarServer } from '../lib/memory/embed-sidecar-server';

const root = process.env.FRICTION_SOURCE_ROOT!;
assert.ok(root, 'explicit source root required for the bundled private fixture');
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const workerMode = process.argv.includes('--worker');
const privateRoot = dirname(process.env.HOME!);
assert.match(workspace, /^test-runtime-/);
assert.notEqual(process.env.PAPERCUSP_PG_PORT, '5432');
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
const servers: Server[] = [];
const phase = (stage: string) => console.log('FRICTION_WORKER_PHASE ' + JSON.stringify({ stage, workerMode, pid: process.pid }));
const requestOptions = { timeout: 30_000, maxTotalTimeout: 30_000, resetTimeoutOnProgress: false };
const listen = (server: Server) => new Promise<number>((done, reject) => {
  servers.push(server); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port));
});
const closeServers = async () => {
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
};
const stopWorker = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  phase('worker-stop-start');
  let timer: ReturnType<typeof setTimeout>;
  const stopped = new Promise<void>((done, reject) => {
    child.once('close', () => done());
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('private worker did not close after SIGTERM'));
    }, 15_000);
  });
  child.kill('SIGTERM');
  try { await stopped; } finally { clearTimeout(timer!); }
  phase('worker-stop-complete');
};
const parse = (result: any) => {
  const block = result.content?.find((entry: any) => entry.type === 'text' && entry.text.trim().startsWith('{'));
  assert.ok(block, JSON.stringify(result));
  return JSON.parse(block.text);
};

export async function runGitSyncTargetWorkerFixture() {
  if (workerMode) {
    assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
    // This fixture composes the side-effect-free request handler, so it owns
    // the listener lifecycle that the production host bootstrap normally owns.
    process.once('SIGTERM', () => {
      phase('worker-shutdown');
      void closeServers().then(async () => {
        await getOrgPg().sql.end({ timeout: 5 });
        await _resetForTests();
        process.exit(0);
      }).catch(error => { console.error('FRICTION_WORKER_FAILURE', error); process.exit(1); });
    });
    const port = await listen(createServer(getRequestListener(handler)));
    await writeEndpointIpcDiscovery(join(process.env.PAPERCUSP_HOME!, 'private-worker.sock'), { port });
    const descriptor = JSON.parse(readFileSync(join(process.env.PAPERCUSP_HOME!, `endpoint-ipc.${port}.json`), 'utf8'));
    assert.equal(descriptor.processRole, 'bg-host');
    assert.equal(descriptor.executionProcessId, readProcessIdentity(process.pid));
    assert.ok(descriptor.executionTarget?.buildSha);
    process.send?.({ kind: 'worker-ready', port, target: descriptor.executionTarget, pid: process.pid,
      identity: descriptor.executionProcessId });
    return;
  }
  // The maintained background runtime enables explicit work, with global
  // routines disabled. This side-effect-free HTTP handler is the request-only
  // control; the separate child below retains the background role.
  process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
  const token = randomUUID();
  mkdirSync(dirname(superuserTokenPath()), { recursive: true });
  writeFileSync(superuserTokenPath(), token, { mode: 0o600 });
  assert.equal(readSuperuserToken(), token);
  const slug = 'friction-private-repository';
  const repository = join(privateRoot, 'git-sync-repository');
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  // Fixture-only git setup. The product action performs the measured commit.
  git('init', '-b', 'staging'); git('config', 'user.name', 'Private acceptance');
  git('config', 'user.email', 'private-acceptance@example.invalid');
  writeFileSync(join(repository, 'payload.txt'), 'initial\n');
  git('add', 'payload.txt'); git('commit', '-m', 'private fixture initial state');
  const remote = join(privateRoot, 'origin.git');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '--set-upstream', 'origin', 'staging');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(repository, 'payload.txt'), 'measured private mutation\n');
  const otherRepository = join(privateRoot, 'non-target-repository');
  mkdirSync(otherRepository);
  const otherGit = (...args: string[]) => execFileSync('git', ['-C', otherRepository, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  otherGit('init', '-b', 'staging');
  otherGit('config', 'user.name', 'Private acceptance');
  otherGit('config', 'user.email', 'private-acceptance@example.invalid');
  writeFileSync(join(otherRepository, 'payload.txt'), 'non-target initial\n');
  otherGit('add', 'payload.txt'); otherGit('commit', '-m', 'non-target fixture initial state');
  const otherBefore = otherGit('rev-parse', 'HEAD');
  writeFileSync(join(otherRepository, 'payload.txt'), 'non-target dirty state\n');
  const otherStatus = otherGit('status', '--porcelain');
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug, path: repository, hive_slug: workspace },
    { slug: `${slug}-non-target`, path: otherRepository, hive_slug: workspace }] }, workspace);
  phase('private-repository-ready');
  let child: ChildProcess | undefined;
  const clients: Client[] = [];
  let scenarioFailure: unknown;
  try {
    const requestPort = await listen(createServer(getRequestListener(handler)));
    child = fork(import.meta.filename, ['--worker'], { cwd: root, execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_BACKGROUND_WORKERS: '1', PAPERCUSP_SERVING_BUILD: 'staging' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout!.on('data', data => process.stdout.write(data));
    child.stderr!.on('data', data => process.stderr.write(data));
    const ready = await new Promise<any>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('private worker readiness deadline')), 60_000);
      child!.on('message', (message: any) => { if (message.kind === 'worker-ready') { clearTimeout(timer); done(message); } });
      child!.once('error', error => { clearTimeout(timer); reject(error); });
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`worker exited ${code}`)); });
    });
    phase('background-worker-ready');
    const discovered = () => readMcpWorkerTargets(process.env.PAPERCUSP_HOME!);
    assert.equal(discovered().filter(worker => worker.port === ready.port).length, 1);
    const proxyPort = await listen(createMcpProxy({ listenPort: 0, targetPort: requestPort,
      resolveWorkerTargets: discovered, retryWindowMs: 100, retryBackoffMs: 5, log: () => {} }));
    const connect = async (port: number) => {
      phase(`initialize-start:${port}`);
      const client = new Client({ name: 'private-friction-acceptance', version: '1' });
      clients.push(client);
      const query = new URLSearchParams({ superuser: '1', client: 'friction-private-acceptance', workspace, harness: slug, format: 'json', profile: 'engineer' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp?${query}`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } }), requestOptions);
      phase(`initialize-complete:${port}`);
      await client.listTools(undefined, requestOptions);
      phase(`catalog-complete:${port}`);
      return client;
    };
    const direct = await connect(requestPort);
    phase('request-only-start');
    const requestOnly = parse(await direct.callTool({ name: 'git-sync:run', arguments: { installSlug: slug } }, undefined, requestOptions));
    assert.equal(requestOnly.reason, 'request-only-host', JSON.stringify(requestOnly));
    assert.equal(git('rev-parse', 'HEAD'), before);
    phase('request-only-refused');
    const client = await connect(proxyPort);
    phase('preview-start');
    const preview = parse(await client.callTool({ name: 'git-sync:run', arguments: { installSlug: slug, target: ready.target, dryRun: true } }, undefined, requestOptions));
    assert.equal(preview.fired, false);
    assert.equal(git('rev-parse', 'HEAD'), before);
    phase('preview-complete');
    const wrong = await fetch(`http://127.0.0.1:${proxyPort}/api/mcp`, { method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'git-sync:run', arguments: { installSlug: slug, target: { ...ready.target, buildSha: '0'.repeat(40) } } } }) });
    assert.equal(wrong.status, 503);
    const principal = await fetch(`http://127.0.0.1:${proxyPort}/api/mcp`, { method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'tools:invoke', arguments: { name: 'git-sync:run', args: { installSlug: slug, target: ready.target }, authenticatedPrincipal: {} } } }) });
    assert.equal(principal.status, 400);
    assert.equal(git('rev-parse', 'HEAD'), before);
    phase('mutation-start');
    const result = parse(await client.callTool({ name: 'git-sync:run', arguments: { installSlug: slug, target: ready.target } }, undefined,
      { timeout: 60_000, maxTotalTimeout: 60_000, resetTimeoutOnProgress: false }));
    phase('mutation-returned');
    const after = git('rev-parse', 'HEAD');
    assert.equal(result.fired, true, JSON.stringify(result));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.status, 'synced', JSON.stringify(result));
    assert.notEqual(after, before, JSON.stringify(result));
    assert.equal(git('show', 'HEAD:payload.txt'), 'measured private mutation');
    assert.equal(git('rev-list', '--count', `${before}..${after}`), '1', 'one request creates exactly one expected commit');
    assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/staging'), after);
    assert.equal(otherGit('rev-parse', 'HEAD'), otherBefore, 'non-target ref must not move');
    assert.equal(otherGit('status', '--porcelain'), otherStatus, 'non-target dirty state must remain unchanged');
    assert.equal(readFileSync(join(otherRepository, 'payload.txt'), 'utf8'), 'non-target dirty state\n');
    phase('mutation-verified');
    for (const client of clients.splice(0)) await client.close();
    phase('clients-closed');
    await stopWorker(child);
    assert.equal(child.exitCode, 0, 'private worker must shut down gracefully');
    assert.equal(readProcessIdentity(ready.pid), null);
    console.log('FRICTION_WORKER_RECEIPT ' + JSON.stringify({ workspace, runtimeRoot: privateRoot,
      target: ready.target, worker: { pid: ready.pid, identity: ready.identity },
      before, after, committed: true, wrongTargetDispatched: false, principalDispatched: false,
      requestOnlyRefused: true, workerStopped: true, resultStatus: result.status,
      remoteConfirmed: true, nonTargetUnchanged: true, commits: 1,
      sourceHost: getServingHostIdentity() }));
  } catch (error) {
    scenarioFailure = error;
    throw error;
  } finally {
    try {
      for (const client of clients) await client.close();
      if (child?.exitCode === null && child.signalCode === null) {
        await stopWorker(child);
      }
      await closeServers();
      await getOrgPg().sql.end({ timeout: 5 });
      await _resetForTests();
    } catch (cleanupFailure) {
      if (scenarioFailure !== undefined) {
        throw new AggregateError([scenarioFailure, cleanupFailure],
          `Private git-sync scenario failed: ${String(scenarioFailure)}; cleanup failed: ${String(cleanupFailure)}`);
      }
      throw cleanupFailure;
    }
  }
}
// The maintained embedding client re-executes its containing bundle. Honor
// that production entry contract instead of re-entering fixture setup.
if (process.env.PAPERCUSP_EMBED_SIDECAR_MODE === '1') runEmbedSidecarServer();
else if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  runGitSyncTargetWorkerFixture().then(() => { if (!workerMode) process.exit(0); }).catch(error => {
    console.error('FRICTION_WORKER_FAILURE', error); process.exit(1);
  });
}
