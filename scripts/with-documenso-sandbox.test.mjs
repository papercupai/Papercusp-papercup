import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSandboxArgs, loopbackPort, sandboxEnvironment, runSandbox, dockerAllocation, dockerAllocationScope, startDockerAllocationOwner, startSandboxContainer, prepareSandboxImages, waitForSandboxPostgres, registerSandboxReaper, startSandboxReaper, cleanupSandboxResources, waitForSandboxChild, sandboxProviderFailureSignals } from './with-documenso-sandbox.mjs';

const failureRuntime = { container: 'owned-app', network: 'owned', appUrl: 'http://127.0.0.1:32123', mailUrl: 'http://127.0.0.1:32124' };

test('child failure preserves provider state and reachability before returning its original exit code', async () => {
  const calls = [], reports = [], secret = randomUUID();
  const child = spawn(process.execPath, ['-e', 'process.exit(23)'], { stdio: 'ignore' });
  const code = await waitForSandboxChild(child, { runtime: failureRuntime,
    run: args => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ Status: 'running', ExitCode: 0, OOMKilled: false, Error: secret }) };
    },
    probe: async (url, options) => {
      assert.equal(options.redirect, 'manual'); assert.ok(options.signal);
      assert.ok([failureRuntime.appUrl + '/signup', failureRuntime.mailUrl + '/email'].includes(url));
      return { status: 200, body: { cancel: async () => { calls.push('body-cancelled'); } } };
    },
    report: async value => { await new Promise(done => setImmediate(done)); reports.push(value); },
  });
  assert.equal(code, 23);
  assert.equal(reports.length, 1, 'the caller may clean up as soon as this returns');
  assert.deepEqual(reports[0].endpoints, [{ name: 'provider', status: 200 }, { name: 'mail', status: 200 }]);
  assert.deepEqual(reports[0].containers.map(row => row.name), ['owned-app', 'owned-pg', 'owned-mail']);
  assert.equal(calls.filter(Array.isArray).every(args => args[0] === 'inspect'), true, 'never collect post-signup application logs');
  assert.equal(JSON.stringify(reports).includes(secret), false);
  assert.equal(calls.filter(value => value === 'body-cancelled').length, 2);
});

test('child failure distinguishes a stopped provider and refused connection without exposing error text', async () => {
  const reports = [], secret = randomUUID();
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  assert.equal(await waitForSandboxChild(child, { runtime: failureRuntime,
    run: () => ({ status: 0, stdout: JSON.stringify({ Status: 'exited', ExitCode: 9, OOMKilled: true }) }),
    probe: async () => { throw new Error(secret, { cause: { code: 'ECONNREFUSED' } }); },
    report: value => reports.push(value),
  }), 7);
  assert.equal(reports[0].containers.every(row => row.status === 'exited' && row.exitCode === 9 && row.oomKilled), true);
  assert.equal(reports[0].endpoints.every(row => row.failure === 'ECONNREFUSED' && row.status === null), true);
  assert.equal(JSON.stringify(reports).includes(secret), false);
});

test('successful child does not inspect providers or issue extra requests', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  assert.equal(await waitForSandboxChild(child, { runtime: failureRuntime,
    run: () => assert.fail('success needs no failure diagnosis'),
    probe: () => assert.fail('success needs no failure probe'),
    report: () => assert.fail('success needs no failure report'),
  }), 0);
});

test('exited provider logs produce only fixed diagnostic signals before cleanup', async () => {
  const reports = [], calls = [], credential = randomUUID();
  const child = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
  assert.equal(await waitForSandboxChild(child, { runtime: failureRuntime,
    run: args => {
      calls.push(args);
      return { status: 0, stdout: args[0] === 'logs'
        ? 'PrismaClientInitializationError P1001 credential=' + credential
        : JSON.stringify({ Status: args.at(-1) === failureRuntime.container ? 'exited' : 'running', ExitCode: 1 }) };
    },
    probe: async () => ({ status: 200 }), report: value => reports.push(value),
  }), 1);
  assert.deepEqual(calls.filter(args => args[0] === 'logs'), [['logs', '--tail', '200', failureRuntime.container]]);
  assert.deepEqual(reports[0].providerFailure, { inspection: 'classified', signals: ['database-unreachable'] });
  assert.equal(JSON.stringify(reports).includes(credential), false);
  assert.equal(JSON.stringify(reports).includes('PrismaClientInitializationError'), false);
});

test('provider diagnostic log failure preserves the original child outcome without leaking exception text', async () => {
  const reports = [], credential = randomUUID();
  const child = spawn(process.execPath, ['-e', 'process.exit(19)'], { stdio: 'ignore' });
  assert.equal(await waitForSandboxChild(child, { runtime: failureRuntime,
    run: args => {
      if (args[0] === 'logs') throw new Error(credential);
      return { status: 0, stdout: JSON.stringify({ Status: 'exited', ExitCode: 1 }) };
    },
    probe: async () => ({ status: 200 }), report: value => reports.push(value),
  }), 19);
  assert.deepEqual(reports[0].providerFailure, { inspection: 'unavailable' });
  assert.equal(JSON.stringify(reports).includes(credential), false);
});

test('provider failure classifier leaves unknown errors unknown and distinguishes startup failure classes', () => {
  assert.deepEqual(sandboxProviderFailureSignals('private token=' + randomUUID()), []);
  for (const [text, expected] of [
    ['Assertion pthread_create failed', 'node-thread-creation'],
    ['FATAL ERROR: Reached heap limit Allocation failed', 'javascript-heap-exhaustion'],
    ['P1000 Authentication failed', 'database-authentication'],
    ['P2024 connection pool timeout', 'database-pool-timeout'],
    ['P2021 missing table', 'database-schema-missing'],
    ['Invalid environment variables', 'environment-invalid'],
    ['listen EADDRINUSE', 'address-in-use'],
    ['ERR_MODULE_NOT_FOUND', 'module-missing'],
    ['PrismaClientRustPanicError', 'prisma-engine-panic'],
    ['UnhandledPromiseRejection', 'unhandled-exception'],
  ]) assert.deepEqual(sandboxProviderFailureSignals(text), [expected]);
});

async function withReaperServer(handler, run) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handler(socket);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { await run(server.address().port); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); }
}

test('reaper startup waits for its Started signal before reading the published port or registering ownership', { timeout: 5000 }, async () => {
  const owner = 'daohr-documenso-12345678-abc';
  let ready, waiting, registered = false, portRead = false;
  const atReadiness = new Promise(done => { waiting = done; });
  const connection = { close() {} };
  const pending = startSandboxReaper(owner, args => {
    assert.equal(args[0], 'port'); portRead = true; return '127.0.0.1:33199';
  }, () => {}, {
    getClient: async () => ({ info: { containerRuntime: { remoteSocketPath: '/var/run/docker.sock' } },
      container: { getById: id => ({ id }) } }),
    allocate: async () => 'owned-reaper-id',
    waitStrategy: { waitUntilReady: async container => {
      assert.equal(container.id, 'owned-reaper-id'); waiting();
      await new Promise(done => { ready = done; });
    } },
    register: async args => {
      assert.equal(args.port, 33199); assert.equal(args.owner, owner);
      registered = true; return connection;
    },
  });
  await atReadiness;
  assert.equal(portRead, false, 'a published proxy is not a ready cleanup server');
  assert.equal(registered, false, 'no ownership request before the startup signal');
  ready(); assert.equal(await pending, connection);
});

test('reaper readiness failure retains state and logs without opening an ownership connection', { timeout: 5000 }, async () => {
  await assert.rejects(startSandboxReaper('daohr-documenso-12345678-abc',
    () => assert.fail('must not inspect a published port after startup failure'), () => {}, {
      getClient: async () => ({ info: { containerRuntime: { remoteSocketPath: '/var/run/docker.sock' } },
        container: { getById: id => ({ id }) } }),
      allocate: async () => 'owned-reaper-id',
      waitStrategy: { waitUntilReady: async () => { throw new Error('startup log stream ended'); } },
      register: async () => assert.fail('must not register after readiness failure'),
      diagnosticRun: args => ({ status: 0, stdout: args[0] === 'logs' ? 'daemon connection failed' :
        JSON.stringify({ Status: 'exited', ExitCode: 2 }) }),
    }), error => {
      assert.match(error.message, /startup log stream ended/);
      assert.match(error.message, /daemon connection failed/);
      assert.match(error.message, /exited/);
      assert.equal(error.cause.message, 'startup log stream ended'); return true;
    });
});

test('cleanup registration waits for ACK and sends only the exact sandbox ownership label', { timeout: 5000 }, async () => {
  const owner = 'daohr-documenso-12345678-abc';
  let registered = false, releaseAck;
  await withReaperServer(socket => socket.once('data', data => {
    assert.equal(data.toString(), 'label=papercusp.test.owner=' + owner + '\n');
    releaseAck = () => { socket.write('A'); setImmediate(() => socket.write('CK\n')); };
  }), async port => {
    const pending = registerSandboxReaper({ port, owner, timeoutMs: 1000 }).then(value => { registered = true; return value; });
    pending.catch(() => {}); // consumed below; a bad fixture must fail, never hang the runner
    const deadline = Date.now() + 1000;
    while (!releaseAck && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
    if (!releaseAck) { await pending; assert.fail('reaper filter was never sent'); }
    assert.equal(registered, false, 'provider allocation cannot proceed before ACK');
    releaseAck();
    const connection = await pending;
    connection.assertConnected(); connection.close();
    assert.throws(() => connection.assertConnected(), /disconnected/);
  });
});

test('cleanup registration fails closed on rejection, EOF, missing ACK or an unsafe filter owner', async () => {
  const owner = 'daohr-documenso-12345678-abc';
  await assert.rejects(registerSandboxReaper({ port: 1, owner: owner + '\nlabel=peer' }), /Invalid/);
  for (const reply of ['NO\n', 'EOF', 'NONE']) {
    await withReaperServer(socket => socket.once('data', () => {
      if (reply === 'EOF') socket.end();
      else if (reply !== 'NONE') socket.write(reply);
    }), async port => {
      await assert.rejects(registerSandboxReaper({ port, owner, timeoutMs: 100 }), /rejected|closed|did not acknowledge/);
    });
  }
});

test('losing an acknowledged cleanup connection stops the sandbox and forbids further allocations', { timeout: 5000 }, async () => {
  let peer, stopped = 0;
  await withReaperServer(socket => { peer = socket; socket.once('data', () => socket.write('ACK\n')); }, async port => {
    const connection = await registerSandboxReaper({ port, owner: 'daohr-documenso-12345678-abc', timeoutMs: 1000, onDisconnect: () => stopped++ });
    peer.destroy();
    const deadline = Date.now() + 1000;
    while (!stopped && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
    assert.equal(stopped, 1);
    assert.throws(() => connection.assertConnected(), /closed/);
    connection.close();
  });
});

test('sandbox refuses mutable image tags before any service allocation', () => {
  assert.throws(() => parseSandboxArgs(['--image=documenso/documenso:latest', '--', 'node', 'journey.mjs']), /pinned/);
  assert.throws(() => parseSandboxArgs(['--image=documenso/documenso@sha256:' + 'a'.repeat(64)]), /usage/);
  const image = 'documenso/documenso@sha256:' + 'a'.repeat(64);
  assert.deepEqual(parseSandboxArgs(['--image=' + image, '--', 'node', 'journey.mjs']), { image, command: ['node', 'journey.mjs'] });
});

test('sandbox refuses ports published outside loopback', () => {
  assert.equal(loopbackPort('127.0.0.1:33199\n'), 33199);
  for (const value of ['0.0.0.0:33199', '[::]:33199', '127.0.0.1:0', '127.0.0.1:65536']) {
    assert.throws(() => loopbackPort(value), /loopback/);
  }
});

test('cached immutable sandbox images do not need a registry request', async () => {
  const inspected = [];
  assert.equal(await prepareSandboxImages('documenso/documenso@sha256:' + 'a'.repeat(64), {
    inspect: ref => inspected.push(ref), pull: () => assert.fail('cache hit must not pull'),
  }), true);
  assert.equal(inspected.length, 4);
  assert.equal(new Set(inspected).size, 4);
  for (const ref of inspected) assert.match(ref, /@sha256:[a-f0-9]{64}$/);
});

test('missing reaper image is pulled by its exact digest and verified after the request completes', async () => {
  let present = false, releasePull, completed = false;
  const calls = [];
  const ready = prepareSandboxImages('documenso/documenso@sha256:' + 'a'.repeat(64), {
    inspect: ref => {
      calls.push(['inspect', ref]);
      if (ref.startsWith('testcontainers/ryuk@') && !present) throw new Error('No such image');
    },
    pull: ref => { calls.push(['pull', ref]); return new Promise(done => { releasePull = () => { present = true; done(); }; }); },
  }).then(value => { completed = true; return value; });
  assert.equal(completed, false, 'preparation must wait for the daemon pull');
  assert.equal(typeof releasePull, 'function');
  releasePull();
  assert.equal(await ready, true);
  const reaper = 'testcontainers/ryuk@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0';
  assert.deepEqual(calls.slice(-3), [['inspect', reaper], ['pull', reaper], ['inspect', reaper]]);
});

test('image preparation refuses mutable references, a failed pull, and a pull that did not install its digest', async () => {
  await assert.rejects(prepareSandboxImages('documenso/documenso:latest', {
    inspect: () => assert.fail('unsafe image must be refused before Docker'),
  }), /pinned/);
  const image = 'documenso/documenso@sha256:' + 'a'.repeat(64);
  await assert.rejects(prepareSandboxImages(image, {
    inspect: () => { throw new Error('No such image'); },
    pull: async ref => { assert.equal(ref, image); throw new Error('registry unavailable'); },
  }), /registry unavailable/);
  await assert.rejects(prepareSandboxImages(image, {
    inspect: () => { throw new Error('digest still absent'); }, pull: async () => {},
  }), /digest still absent/);
});

test('stop during an image pull joins the request and prevents subsequent preparation', async () => {
  let stopped = false, pulls = 0, inspections = 0;
  assert.equal(await prepareSandboxImages('documenso/documenso@sha256:' + 'a'.repeat(64), {
    inspect: () => { inspections++; throw new Error('No such image'); },
    pull: async () => { pulls++; stopped = true; }, isStopped: () => stopped,
  }), false);
  assert.equal(pulls, 1);
  assert.equal(inspections, 1);
});

test('actual sandbox entry refuses provider allocation when pinned image preparation fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'daohr-image-preparation-'));
  const calls = join(directory, 'calls.jsonl');
  try {
    writeFileSync(join(directory, 'docker'), '#!' + process.execPath + '\n' +
      'const fs=require("node:fs"); const args=process.argv.slice(2);\n' +
      'fs.appendFileSync(process.env.DAOHR_IMAGE_TEST_CALLS,JSON.stringify(args)+"\\n");\n' +
      'process.stderr.write(args[0]==="pull"?"registry unavailable":"No such image"); process.exit(1);\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ['scripts/with-documenso-sandbox.mjs',
      '--image=documenso/documenso@sha256:' + 'a'.repeat(64), '--', process.execPath, '-e', 'process.exit(91)'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, DAOHR_IMAGE_TEST_CALLS: calls },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /registry unavailable/);
    const phases = result.stderr.split('\n').filter(line => line.startsWith('[documenso-sandbox-phase] '))
      .map(line => JSON.parse(line.slice('[documenso-sandbox-phase] '.length)));
    assert.deepEqual(phases.map(({ phase, status }) => [phase, status]),
      [['images', 'started'], ['images', 'failed'], ['cleanup', 'started'], ['cleanup', 'completed']]);
    assert.ok(phases.every(row => /^daohr-documenso-/.test(row.network) &&
      Number.isFinite(Date.parse(row.at)) && row.elapsedMs >= 0));
    const requests = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(requests, [
      ['image', 'inspect', 'documenso/documenso@sha256:' + 'a'.repeat(64)],
      ['pull', 'documenso/documenso@sha256:' + 'a'.repeat(64)],
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('provider config routes mail and data into the isolated fixture', () => {
  const input = { appUrl: 'http://127.0.0.1:33199', databasePassword: 'pg-secret',
    secret: 'auth-secret', encryptionKey: 'enc-secret', secondaryKey: 'secondary-secret', signingPassword: 'cert-secret' };
  const env = sandboxEnvironment(input);
  assert.equal(env.NEXT_PRIVATE_SMTP_HOST, 'mail');
  assert.equal(env.NEXT_PRIVATE_DATABASE_URL, 'postgres://documenso:pg-secret@database:5432/documenso');
  assert.equal(env.NEXT_PRIVATE_DIRECT_DATABASE_URL, env.NEXT_PRIVATE_DATABASE_URL);
  assert.equal(env.NEXT_PUBLIC_WEBAPP_URL, input.appUrl);
  assert.equal(env.NEXT_PRIVATE_SIGNING_PASSPHRASE, input.signingPassword);
  assert.equal(env.NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH, '/opt/documenso/cert.p12');
  assert.equal(env.DOCUMENSO_DISABLE_TELEMETRY, 'true');
  assert.throws(() => sandboxEnvironment({ ...input, appUrl: 'https://example.com' }), /loopback/);
});

for (const operation of ['create', 'start', 'stop', 'rm']) {
  test(`slow Docker ${operation} is joined before cleanup instead of being killed at the warning threshold`, async () => {
    const observations = [];
    const outcome = await dockerAllocation([operation, 'fixture'], {}, {
      pendingAfterMs: 10,
      onPending: () => observations.push('still pending'),
      spawnChild: () => spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("daemon-outcome"),80)']),
    });
    observations.push('safe to continue ' + outcome);
    assert.deepEqual(observations, ['still pending', 'safe to continue daemon-outcome']);
  });
}

test('hook teardown joins late create before inspecting and refuses the timed-out setup continuation', async () => {
  let settle, created = false, removed = false;
  const calls = [];
  const scope = dockerAllocationScope({ allocate: async args => {
    calls.push(args[0]);
    await new Promise(resolve => { settle = resolve; });
    created = true;
    return 'owned-container';
  } });
  const setup = scope.run(['create', 'owned-container']).then(() => scope.run(['start', 'owned-container']));
  const setupFailed = assert.rejects(setup, /scope is closing/);
  await new Promise(resolve => setImmediate(resolve));
  const cleanup = scope.close(() => {
    assert.equal(created, true, 'inspection must follow the actual create outcome');
    removed = true;
  });
  assert.equal(scope.close(() => assert.fail('duplicate cleanup')), cleanup);
  assert.equal(removed, false);
  settle();
  await setupFailed;
  await cleanup;
  assert.equal(removed, true);
  assert.deepEqual(calls, ['create']);
});

test('failed pending allocation still permits cleanup and preserves its original failure', async () => {
  let reject, cleaned = false;
  const scope = dockerAllocationScope({ allocate: () => new Promise((_, fail) => { reject = fail; }) });
  const outcome = scope.run(['create']);
  const failed = assert.rejects(outcome, /daemon failure/);
  await new Promise(resolve => setImmediate(resolve));
  const cleanup = scope.close(() => { cleaned = true; });
  reject(new Error('daemon failure'));
  await failed;
  await cleanup;
  assert.equal(cleaned, true);
});

async function fixtureCondition(check, description) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + description);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function allocationOwnerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pc-personal-ssh-'));
  const control = mkdtempSync(join(tmpdir(), 'pc-allocation-control-'));
  const name = 'pc-personal-ssh-' + randomUUID();
  mkdirSync(join(control, 'bin'));
  // A real CLI subprocess with a deliberately delayed mutation. Its state is
  // outside the fixture mount, so removal ordering is independently observable.
  writeFileSync(join(control, 'bin', 'docker'), `#!${process.execPath}
import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
const control = ${JSON.stringify(control)}, root = ${JSON.stringify(root)}, name = ${JSON.stringify(name)};
const operation = process.argv[2], container = control + '/container';
if (operation === 'create') {
  writeFileSync(control + '/started', 'started');
  const timer = setInterval(() => {
    if (!existsSync(control + '/release')) return;
    clearInterval(timer);
    writeFileSync(control + '/created', JSON.stringify({ keysRetained: existsSync(root + '/private-key') }));
    writeFileSync(container, name);
    process.stdout.write('abcdef123456');
  }, 10);
} else if (operation === 'ps') {
  if (existsSync(container)) process.stdout.write('abcdef123456 ' + readFileSync(container, 'utf8'));
} else if (operation === 'rm') {
  if (process.argv.at(-1) !== 'abcdef123456') process.exit(9);
  rmSync(container);
  writeFileSync(control + '/removed', 'removed');
}
`, { mode: 0o700 });
  writeFileSync(join(root, 'private-key'), 'disposable test fixture');
  return { root, control, name, env: { ...process.env, PATH: join(control, 'bin') + ':' + process.env.PATH } };
}

test('external allocation owner survives killed worker cgroup and removes a late create before fixture keys', { timeout: 30_000 }, async () => {
  const fixture = allocationOwnerFixture();
  const { root, control, name, env } = fixture;
  const workerUnit = 'papercusp-test-allocation-worker-' + randomUUID() + '.scope';
  const worker = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit=' + workerUnit,
    '--property=RuntimeMaxSec=30', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', `
      import { startDockerAllocationOwner } from ${JSON.stringify(new URL('./with-documenso-sandbox.mjs', import.meta.url).href)};
      const owner = await startDockerAllocationOwner({ name: ${JSON.stringify(name)}, root: ${JSON.stringify(root)}, onProgress() {} });
      await owner.run(['create', ${JSON.stringify(name)}]);
      await owner.close();
    `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  worker.stdout.on('data', data => { output += data; });
  worker.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await fixtureCondition(() => existsSync(join(control, 'started')), 'pending create; worker output=' + output);
    const ownerUnit = 'papercusp-fixture-' + name + '.scope';
    const cgroup = unit => spawnSync('systemctl', ['--user', 'show', '--property=ControlGroup', '--value', unit], { encoding: 'utf8' }).stdout.trim();
    assert.ok(cgroup(workerUnit));
    assert.ok(cgroup(ownerUnit));
    assert.notEqual(cgroup(workerUnit), cgroup(ownerUnit));
    const killed = spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', workerUnit], { encoding: 'utf8', timeout: 5000 });
    assert.equal(killed.status, 0, killed.stderr);
    const result = await exited;
    assert.notEqual(result.code, 0, output);
    assert.equal(existsSync(join(control, 'removed')), false, 'must join the pending create');
    assert.equal(existsSync(join(root, 'private-key')), true, 'pending daemon still owns the mount');
    writeFileSync(join(control, 'release'), 'settle after the worker died');
    await fixtureCondition(() => existsSync(join(control, 'removed')) && !existsSync(root), 'verified late-create cleanup');
    assert.deepEqual(JSON.parse(readFileSync(join(control, 'created'), 'utf8')), { keysRetained: true });
    assert.equal(existsSync(join(control, 'container')), false);
  } finally {
    writeFileSync(join(control, 'release'), 'release pending CLI even on assertion failure');
    spawnSync('systemctl', ['--user', 'stop', workerUnit], { timeout: 5000 });
    await fixtureCondition(() => !existsSync(root), 'owner cleanup after test finalization');
    rmSync(control, { recursive: true, force: true });
  }
});

test('external allocation owner closes admission, joins setup and verifies cleanup on normal teardown', { timeout: 30_000 }, async () => {
  const { root, control, name, env } = allocationOwnerFixture();
  const previousPath = process.env.PATH;
  let owner;
  try {
    process.env.PATH = env.PATH;
    owner = await startDockerAllocationOwner({ name, root, onProgress() {} });
    const creating = owner.run(['create', name]);
    await fixtureCondition(() => existsSync(join(control, 'started')), 'normal pending create');
    const closing = owner.close();
    assert.equal(owner.close(), closing);
    await assert.rejects(owner.run(['start', name]), /scope is closing/);
    writeFileSync(join(control, 'release'), 'settle');
    assert.equal(await creating, 'abcdef123456');
    assert.equal(await closing, 'cleanup-verified');
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(join(control, 'container')), false);
  } finally {
    process.env.PATH = previousPath;
    writeFileSync(join(control, 'release'), 'release pending CLI');
    if (owner) await owner.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});

test('external allocation owner refuses another owner and retains private state for accountable cleanup', { timeout: 30_000 }, async () => {
  const { root, control, name, env } = allocationOwnerFixture();
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = env.PATH;
    const owner = await startDockerAllocationOwner({ name, root, onProgress() {} });
    writeFileSync(join(control, 'container'), 'a-different-fixture-owner');
    await assert.rejects(owner.close(), /cleanup ownership mismatch/);
    assert.equal(existsSync(join(control, 'removed')), false);
    assert.equal(existsSync(join(root, 'private-key')), true);
    const receipts = readFileSync(join(root, 'owner.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(receipts.at(-1).status, 'cleanup-failed');
    await assert.rejects(owner.run(['start', name]), /scope is closing/);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});

test('external allocation owner rejects an invalid identity before allocating a socket or scope', async () => {
  await assert.rejects(startDockerAllocationOwner({ name: 'another-persons-container', root: tmpdir() }), /Invalid Docker fixture ownership/);
});

test('allocation errors redact injected credentials', async () => {
  const NEVER_EMIT_MARKER = 'never-emit-me';
  await assert.rejects(dockerAllocation(['create'], { PASSWORD: NEVER_EMIT_MARKER }, {
    spawnChild: () => spawn(process.execPath, ['-e', 'process.stderr.write(process.env.PASSWORD);process.exitCode=7'],
      { env: { ...process.env, PASSWORD: NEVER_EMIT_MARKER } }),
  }), error => error.message.includes('[redacted]') && !error.message.includes(NEVER_EMIT_MARKER));
});

test('allocation evidence identifies a pending request and its failed outcome without logging arguments or secrets', async () => {
  // Generate the credential at runtime so this redaction fixture contains no secret assignment in source.
  const receipts = [], owner = 'daohr-documenso-12345678-abc-pg', secret = randomUUID();
  await assert.rejects(dockerAllocation(['start', owner, secret], { PASSWORD: secret }, {
    pendingAfterMs: 10, onPending() {}, onProgress: receipt => receipts.push(receipt),
    spawnChild: () => spawn(process.execPath, ['-e', 'setTimeout(()=>{process.stderr.write("private output");process.exitCode=7},80)']),
    readEvents: () => ({ status: 1, stdout: '' }),
  }), /start 7/);
  assert.deepEqual(receipts.map(row => row.status), ['started', 'pending', 'failed', 'events-unavailable']);
  assert.ok(receipts.every(row => row.operation === 'start' && row.resource === owner &&
    Number.isFinite(Date.parse(row.at)) && row.elapsedMs >= 0));
  assert.ok(receipts.at(-1).elapsedMs >= receipts[1].elapsedMs);
  assert.equal(JSON.stringify(receipts).includes(secret), false);
  assert.equal(JSON.stringify(receipts).includes('private output'), false);
});

test('combined reaper allocation retains exact daemon create and start boundaries without private attributes', async () => {
  const owner = 'daohr-documenso-12345678-abc-reaper', receipts = [], secret = randomUUID();
  const result = await dockerAllocation(['run', '--name', owner, secret], {}, {
    onProgress: receipt => receipts.push(receipt),
    spawnChild: () => spawn(process.execPath, ['-e', 'process.stdout.write("reaper-id")']),
    readEvents: args => {
      assert.deepEqual(args.slice(0, 2), ['events', '--since']);
      assert.equal(args[args.indexOf('--filter') + 1], 'container=' + owner);
      assert.ok(Number(args[2]) <= Number(args[4]));
      const event = (name, Action, timeMs) => JSON.stringify({ Action,
        Actor: { Attributes: { name, credential: secret } }, timeNano: String(BigInt(timeMs) * 1_000_000n) });
      const now = Date.now();
      return { status: 0, stdout: [event(owner, 'create', now - 10), event(owner, 'start', now),
        event('peer-container', 'start', now)].join('\n') };
    },
  });
  assert.equal(result, 'reaper-id');
  assert.deepEqual(receipts.map(row => row.status), ['started', 'completed', 'daemon-event', 'daemon-event']);
  const events = receipts.filter(row => row.status === 'daemon-event');
  assert.deepEqual(events.map(row => row.daemonAction), ['create', 'start']);
  assert.ok(events.every(row => row.resource === owner && Number.isFinite(Date.parse(row.at))));
  assert.ok(events[1].elapsedMs >= events[0].elapsedMs);
  assert.equal(JSON.stringify(receipts).includes(secret), false);
  assert.equal(JSON.stringify(receipts).includes('peer-container'), false);
});

test('unavailable daemon history preserves the failed allocation outcome and records the evidence gap', async () => {
  const owner = 'daohr-documenso-12345678-abc-reaper', receipts = [];
  await assert.rejects(dockerAllocation(['run', '--name', owner], {}, {
    onProgress: receipt => receipts.push(receipt),
    spawnChild: () => spawn(process.execPath, ['-e', 'process.exitCode=7']),
    readEvents: () => { throw new Error('private daemon response'); },
  }), /run 7/);
  assert.deepEqual(receipts.map(row => row.status), ['started', 'failed', 'events-unavailable']);
  assert.equal(JSON.stringify(receipts).includes('private daemon response'), false);
});

test('personal SSH allocation receipts retain exact resource and daemon identity without arguments', async () => {
  const owner = 'pc-personal-ssh-' + randomUUID(), receipts = [], secret = randomUUID();
  for (const operation of ['create', 'start', 'stop', 'rm']) {
    await dockerAllocation([operation, '--name', owner, secret], {}, {
      onProgress: receipt => receipts.push(receipt),
      spawnChild: () => spawn(process.execPath, ['-e', 'process.stdout.write("owned-id")']),
      readEvents: args => {
        assert.equal(args[args.indexOf('--filter') + 1], 'container=' + owner);
        return { status: 0, stdout: JSON.stringify({ Action: operation === 'rm' ? 'destroy' : operation === 'stop' ? 'die' : operation,
          Actor: { Attributes: { name: owner, credential: secret } }, time: Math.floor(Date.now() / 1000) }) };
      },
    });
  }
  assert.ok(receipts.every(receipt => receipt.resource === owner));
  assert.deepEqual(receipts.filter(row => row.status === 'daemon-event').map(row => [row.operation, row.daemonAction]),
    [['create', 'create'], ['start', 'start'], ['stop', 'die'], ['rm', 'destroy']]);
  assert.equal(JSON.stringify(receipts).includes(secret), false);
});

test('container start remains joined past its warning and cleanup follows the actual daemon outcome', { timeout: 5000 }, async () => {
  const owner = 'daohr-documenso-12345678-abc', containers = [], calls = [];
  let warned, cleaned = false, finished = false;
  const pendingWarning = new Promise(done => { warned = done; });
  const pending = (async () => {
    try {
      await startSandboxContainer({ name: owner + '-pg', network: owner, args: ['pinned-image'], containers,
        reaper: { assertConnected() {} },
        allocate: async args => {
          calls.push(args[0]);
          if (args[0] === 'create') return 'owned-container';
          assert.deepEqual(args, ['start', owner + '-pg']);
          await dockerAllocation(args, {}, { pendingAfterMs: 10, onPending: warned,
            spawnChild: () => spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("started"),80)']),
          });
          finished = true;
        },
      });
    } finally {
      await cleanupSandboxResources({ containers, network: owner, networkCreated: false,
        remove: async () => { assert.equal(finished, true); cleaned = true; }, inspect: () => '',
      });
    }
  })();
  await pendingWarning;
  assert.equal(finished, false);
  assert.equal(cleaned, false, 'a pending start must not race cleanup');
  assert.deepEqual(containers, [owner + '-pg']);
  await pending;
  assert.deepEqual(calls, ['create', 'start']);
  assert.equal(cleaned, true);
});

test('stop or lost cleanup lease during create forbids the subsequent start', async () => {
  for (const loseLease of [false, true]) {
    let created = false;
    const containers = [];
    const pending = startSandboxContainer({ name: 'owned-pg', network: 'owned-network', args: [], containers,
      isStopped: () => created && !loseLease,
      reaper: { assertConnected() { if (created) throw new Error('cleanup lease disconnected'); } },
      allocate: async args => { assert.equal(args[0], 'create'); created = true; },
      diagnosticRun: () => ({ status: 0, stdout: '{}' }),
    });
    if (loseLease) await assert.rejects(pending, /cleanup lease disconnected/);
    else await pending;
    assert.deepEqual(containers, ['owned-pg'], 'created resource remains owned for cleanup');
  }
});

test('failed container start retains phase, container state and sanitized evidence before cleanup', async () => {
  const secret = randomUUID(), calls = [];
  await assert.rejects(startSandboxContainer({ name: 'owned-mail', network: 'owned-network', args: [], containers: [],
    environment: { PASSWORD: secret }, reaper: { assertConnected() {} },
    allocate: async args => { if (args[0] === 'start') throw new Error('daemon start failed ' + secret); },
    diagnosticRun: args => {
      calls.push(args[0]);
      return { status: 0, stdout: args[0] === 'logs' ? 'startup detail ' + secret :
        JSON.stringify({ Status: 'created', ExitCode: 0, Error: 'bind failed ' + secret, OOMKilled: false }) };
    },
  }), error => {
    assert.match(error.message, /container start failed/);
    assert.match(error.message, /owned-mail/);
    assert.match(error.message, /created/);
    assert.match(error.message, /daemon start failed/);
    assert.match(error.message, /startup detail/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(calls, ['inspect', 'logs']);
});

test('normal cleanup waits for slow daemon removal before inspecting exact ownership', { timeout: 5000 }, async () => {
  const owner = 'daohr-documenso-12345678-abc', calls = [];
  let removed = false, warned = false;
  await cleanupSandboxResources({ containers: ['owned-app'], network: owner, networkCreated: true,
    remove: async args => {
      calls.push(args);
      if (args[0] === 'rm') {
        await dockerAllocation(args, {}, { pendingAfterMs: 10,
          onPending: () => { warned = true; },
          spawnChild: () => spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),80)']),
        });
        removed = true;
      }
    },
    inspect: args => {
      assert.equal(removed, true, 'daemon request must finish before absence is inspected');
      assert.equal(args.at(-1), 'label=papercusp.test.owner=' + owner);
      calls.push(args); return '';
    },
  });
  assert.equal(warned, true);
  assert.deepEqual(calls.map(args => args[0]), ['rm', 'network', 'ps', 'network']);
});

test('cleanup accepts an already reaped resource but reports a retained resource with its removal failure', async () => {
  const owner = 'daohr-documenso-12345678-abc';
  const removal = { containers: ['owned-app'], network: owner, networkCreated: false,
    remove: async () => { throw new Error('daemon removal failed'); } };
  await cleanupSandboxResources({ ...removal, inspect: () => '' });
  await assert.rejects(cleanupSandboxResources({ ...removal,
    inspect: args => args[0] === 'ps' ? 'retained-container' : '' }), /retained-container.*daemon removal failed/);
});

test('personal SSH fixture leaves container removal to the external owner', () => {
  const source = readFileSync(new URL('../packages/operator-core/lib/workspace-host/personal-ssh-connection.e2e.test.ts', import.meta.url), 'utf8');
  const createStart = source.indexOf("await docker(['create'");
  assert.notEqual(createStart, -1, 'personal SSH fixture must create a labeled container');
  const createEnd = source.indexOf(']);', createStart);
  assert.notEqual(createEnd, -1, 'personal SSH fixture create call must remain readable');
  const create = source.slice(createStart, createEnd);
  assert.equal(create.includes("'--rm'"), false,
    'Docker --rm races the external owner rm --force after the fixture is stopped');
  assert.match(create, /'--label', `papercusp\.test\.owner=/);
  assert.match(source, /allocations\.close\(\)/,
    'the external owner must remain the cleanup authority');
});

test('database startup failure retains state, readiness and sanitized logs before cleanup', async () => {
  const secret = 'never-emit-me', calls = [];
  await assert.rejects(waitForSandboxPostgres('owned-pg', {
    secrets: [secret], delay: async () => assert.fail('an exited container cannot become ready'),
    run: args => {
      calls.push(args[0]);
      if (args[0] === 'exec') return { status: 1, stderr: 'container is not running' };
      if (args[0] === 'logs') return { status: 0, stderr: 'initdb: permission denied; password=' + secret };
      return { status: 0, stdout: args[2] === '{{.State.Status}}' ? 'exited\n' :
        JSON.stringify({ Status: 'exited', ExitCode: 1, Error: '', OOMKilled: false }) };
    },
  }), error => {
    assert.match(error.message, /container is not running/);
    assert.match(error.message, /permission denied/);
    assert.match(error.message, /exitCode.*1/);
    assert.match(error.message, /redacted/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(calls, ['exec', 'inspect', 'inspect', 'logs']);
});

test('database readiness waits for the final TCP server while the temporary Unix server accepts', async () => {
  let tcpProbes = 0, delays = 0;
  await waitForSandboxPostgres('owned-pg', {
    delay: async () => { delays++; },
    run: args => {
      if (args[0] !== 'exec') return { status: 0, stdout: 'running' };
      // A socket-only initialization server would immediately satisfy the old
      // check. The final server begins accepting TCP on the second probe.
      if (!args.includes('-h')) return { status: 0, stdout: 'socket accepting connections' };
      assert.deepEqual(args, ['exec', 'owned-pg', 'pg_isready', '-h', '127.0.0.1', '-U', 'documenso', '-d', 'documenso']);
      return { status: ++tcpProbes === 2 ? 0 : 2, stdout: '127.0.0.1:5432 - no response' };
    },
  });
  assert.equal(tcpProbes, 2);
  assert.equal(delays, 1);
});

test('running database readiness retries converge and exhaustion retains the final probe', async () => {
  let probes = 0, delays = 0;
  const run = args => args[0] === 'exec' ? { status: ++probes === 3 ? 0 : 1, stdout: 'rejecting connections' } :
    { status: 0, stdout: 'running' };
  await waitForSandboxPostgres('owned-pg', { run, delay: async () => { delays++; } });
  assert.equal(probes, 3);
  assert.equal(delays, 2);
  probes = 0;
  await assert.rejects(waitForSandboxPostgres('owned-pg', { run, attempts: 2, delay: async () => {} }),
    /rejecting connections/);
  assert.equal(probes, 2);
});

test('database initialization can advance beyond the TCP failure budget before the final server accepts', async () => {
  let probes = 0, delays = 0;
  const receipts = [];
  await waitForSandboxPostgres('owned-pg', {
    delay: async () => { delays++; }, onProgress: receipt => receipts.push(receipt),
    run: args => {
      if (args[0] === 'exec') return { status: ++probes === 47 ? 0 : 2, stdout: '127.0.0.1:5432 - no response' };
      if (args[0] === 'inspect') return { status: 0, stdout: 'running' };
      // Simulate the retained failure: initialization and the temporary
      // shutdown progress while none of the final TCP probes can succeed.
      return { status: 0, stderr: probes < 16 ? 'performing post-bootstrap initialization' :
        probes < 31 ? 'listening on Unix socket' : 'checkpoint starting: shutdown immediate' };
    },
  });
  assert.equal(probes, 47);
  assert.equal(delays, 46);
  assert.equal(receipts.at(-1).status, 'accepting');
  assert.equal(receipts.every(receipt => receipt.stalledAttempts <= 16), true);
  assert.deepEqual([...new Set(receipts.map(receipt => receipt.initializationStage))],
    ['post-bootstrap', 'temporary-server', 'shutdown-checkpoint']);
});

test('database initialization stalls despite repeated milestones, arbitrary log activity and backwards stages', async () => {
  let probes = 0, delays = 0;
  const receipts = [], secret = randomUUID();
  await assert.rejects(waitForSandboxPostgres('owned-pg', {
    attempts: 3, secrets: [secret], delay: async () => { delays++; },
    onProgress: receipt => receipts.push(receipt),
    run: args => {
      if (args[0] === 'exec') return { status: ++probes === 4 ? 0 : 2, stdout: '127.0.0.1:5432 - no response' };
      if (args[0] === 'inspect') return { status: 0, stdout: args[2] === '{{.State.Status}}' ? 'running' : '{}' };
      return { status: 0, stderr: (probes === 1 ? 'checkpoint starting: shutdown immediate' : 'listening on Unix socket') +
        '\nactivity=' + probes + ' password=' + secret };
    },
  }), error => {
    assert.match(error.message, /no response/);
    assert.match(error.message, /redacted/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(probes, 3, 'a stalled stage must fail before a later successful probe');
  assert.equal(delays, 2);
  assert.deepEqual(receipts.map(receipt => receipt.stalledAttempts), [1, 2, 3]);
  assert.equal(receipts.every(receipt => receipt.initializationStage === 'shutdown-checkpoint'), true);
  assert.equal(JSON.stringify(receipts).includes(secret), false);
});

test('failed database probes cannot gain a fresh failure budget from initialization logs', async () => {
  let probes = 0;
  await assert.rejects(waitForSandboxPostgres('owned-pg', {
    attempts: 2, delay: async () => {}, onProgress: () => {},
    run: args => {
      if (args[0] === 'exec') return { status: null, error: new Error('Docker probe timed out ' + ++probes) };
      if (args[0] === 'inspect') return { status: 0, stdout: args[2] === '{{.State.Status}}' ? 'running' : '{}' };
      assert.equal(probes, 2, 'probe errors must not request startup logs until collecting failure evidence');
      return { status: 0, stdout: 'PostgreSQL init process complete; ready for start up' };
    },
  }), /Docker probe timed out 2/);
  assert.equal(probes, 2);
});

test('database readiness reports each actual TCP probe without emitting Docker output or secrets', async () => {
  const secret = randomUUID(), receipts = [];
  let probes = 0;
  await waitForSandboxPostgres('owned-pg', {
    delay: async () => {}, onProgress: receipt => receipts.push(receipt),
    run: args => args[0] === 'exec' ? { status: ++probes === 3 ? 0 : 2, stdout: secret } :
      { status: 0, stdout: probes === 1 ? secret : 'running' },
  });
  assert.deepEqual(receipts.map(r => [r.attempt, r.status, r.containerState]),
    [[1, 'not-ready', 'unknown'], [2, 'not-ready', 'running'], [3, 'accepting', undefined]]);
  assert.equal(receipts.every(r => r.container === 'owned-pg' && r.attempts === 31 && r.elapsedMs >= 0), true);
  assert.equal(JSON.stringify(receipts).includes(secret), false);
});

test('database readiness distinguishes a failed Docker probe and records exhaustion before teardown', async () => {
  const receipts = [];
  await assert.rejects(waitForSandboxPostgres('owned-pg', {
    attempts: 1, onProgress: receipt => receipts.push(receipt),
    run: args => args[0] === 'exec' ? { status: null, error: new Error('Docker probe timed out') } :
      { status: 0, stdout: args[2] === '{{.State.Status}}' ? 'running' : '{}' },
    delay: async () => assert.fail('exhausted readiness cannot retry'),
  }), /Docker probe timed out/);
  assert.deepEqual(receipts.map(r => [r.attempt, r.attempts, r.status, r.containerState]),
    [[1, 1, 'probe-error', 'running']]);
});

test('stopping a sandbox cancels database readiness without another Docker operation', async () => {
  await waitForSandboxPostgres('owned-pg', { isStopped: () => true, run: () => assert.fail('already stopping') });
});

test('an already aborted sandbox refuses image preparation and provider allocation', async () => {
  assert.equal(await runSandbox({ image: 'must-not-be-inspected', command: [], signal: AbortSignal.abort() }, {
    prepareImages: () => assert.fail('an aborted caller cannot start preparation'),
  }), 130);
});

test('caller abort joins pending image preparation and stops the sandbox before its next allocation', async () => {
  const controller = new AbortController();
  let started, release, completed = false;
  const preparing = new Promise(done => { started = done; });
  const pending = runSandbox({ image: 'fixture', command: [], signal: controller.signal }, {
    prepareImages: async (_image, { isStopped }) => {
      assert.equal(isStopped(), false);
      started();
      await new Promise(done => { release = done; });
      assert.equal(isStopped(), true, 'caller cancellation must reach the sandbox stop guard');
      return false;
    },
  }).then(code => { completed = true; return code; });
  await preparing;
  controller.abort();
  assert.equal(completed, false, 'an in-flight daemon operation must settle before cleanup');
  release();
  assert.equal(await pending, 130);
});

test('real provider starts with a private database and cleans every owned service after child failure',
  { skip: !process.env.DOCUMENSO_TEST_IMAGE, timeout: 240_000 }, async t => {
    const before = spawnSync('docker', ['ps', '-aq', '--filter', 'label=papercusp.test.owner'], { encoding: 'utf8' });
    assert.equal(before.status, 0);
    const code = await runSandbox({ image: process.env.DOCUMENSO_TEST_IMAGE, signal: t.signal, command: [process.execPath, '--input-type=module', '-e',
      'const r=JSON.parse(process.env.DOCUMENSO_TEST_RUNTIME); if(!r.isolatedDatabase||r.externalMail||!r.testCertificate) process.exit(91); const a=await fetch(process.env.DOCUMENSO_URL+"/signin"); if(!a.ok) process.exit(92); const m=await fetch(process.env.DOCUMENSO_TEST_MAIL_URL+"/email"); if(!m.ok) process.exit(93); process.exit(23);'] });
    assert.equal(code, 23, 'child failure must survive provider cleanup');
    const after = spawnSync('docker', ['ps', '-aq', '--filter', 'label=papercusp.test.owner'], { encoding: 'utf8' });
    assert.equal(after.status, 0);
    assert.deepEqual(after.stdout.trim().split('\n').filter(Boolean).sort(), before.stdout.trim().split('\n').filter(Boolean).sort());
  });

test('external SIGKILL of the sandbox process group reaps its Docker resources and preserves a peer',
  { skip: !process.env.DOCUMENSO_TEST_IMAGE, timeout: 300_000 }, async () => {
    const docker = args => {
      const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.error, undefined, 'Docker probe failed: ' + result.error?.message);
      assert.equal(result.status, 0, 'Docker ' + args[0] + ': ' + result.stderr);
      return result.stdout.trim();
    };
    const sentinel = 'daohr-peer-' + randomUUID().slice(0, 12);
    const directory = mkdtempSync(join(tmpdir(), 'daohr-kill-test-'));
    let wrapper, owner, reaper, output = '';
    try {
      docker(['network', 'create', '--label', 'papercusp.test.owner=' + sentinel, sentinel]);
      docker(['create', '--pull=never', '--name', sentinel, '--network', sentinel,
        '--label', 'papercusp.test.owner=' + sentinel, process.env.DOCUMENSO_TEST_IMAGE]);
      wrapper = spawn(process.execPath, ['scripts/with-documenso-sandbox.mjs', '--image=' + process.env.DOCUMENSO_TEST_IMAGE,
        '--', process.execPath, '-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, TMPDIR: directory } });
      wrapper.stderr.on('data', data => {
        output = (output + data).slice(-12000);
        const receipt = /\[documenso-sandbox-reaper\] (\{[^\n]+\})/.exec(output);
        if (receipt) { const runtime = JSON.parse(receipt[1]); owner = runtime.network; reaper = runtime.container; }
      });
      const ended = new Promise(done => wrapper.once('close', (code, signal) => done({ code, signal })));
      const startedBy = Date.now() + 90_000;
      for (;;) {
        assert.equal(wrapper.exitCode, null, output);
        if (owner && docker(['ps', '-aq', '--filter', 'name=^/' + owner + '-pg$'])) break;
        assert.ok(Date.now() < startedBy, 'sandbox did not reach Docker allocation: ' + output);
        await new Promise(done => setTimeout(done, 100));
      }
      // Kill before the detached journey starts. SIGKILL cannot run the
      // wrapper's finally or signal handlers; cleanup must be external.
      assert.equal(output.includes('[documenso-sandbox] {'), false, 'kill fixture already started its child');
      assert.ok(docker(['network', 'ls', '-q', '--filter', 'label=papercusp.test.owner=' + owner]));
      process.kill(-wrapper.pid, 'SIGKILL');
      assert.deepEqual(await ended, { code: null, signal: 'SIGKILL' });
      const cleanedBy = Date.now() + 120_000;
      for (;;) {
        const containers = docker(['ps', '-aq', '--filter', 'label=papercusp.test.owner=' + owner]);
        const networks = docker(['network', 'ls', '-q', '--filter', 'label=papercusp.test.owner=' + owner]);
        const guardian = docker(['ps', '-aq', '--filter', 'name=^/' + reaper + '$']);
        if (!containers && !networks && !guardian) break;
        assert.ok(Date.now() < cleanedBy, 'external cleanup retained containers=' + containers + ' networks=' + networks + ' reaper=' + guardian);
        await new Promise(done => setTimeout(done, 250));
      }
      assert.equal(docker(['inspect', '--format', '{{.Name}}', sentinel]), '/' + sentinel);
      assert.equal(docker(['network', 'inspect', '--format', '{{.Name}}', sentinel]), sentinel);
    } finally {
      if (wrapper?.pid && wrapper.exitCode === null && wrapper.signalCode === null) {
        try { process.kill(-wrapper.pid, 'SIGKILL'); } catch { /* already ended */ }
      }
      // Only our recorded names, even after a failed assertion; never delete
      // the fleet-wide ownership population to clean up a failed test.
      for (const name of owner ? [owner + '-app', owner + '-mail', owner + '-pg', reaper, sentinel] : [sentinel]) {
        spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 30_000 });
      }
      for (const name of owner ? [owner, sentinel] : [sentinel]) {
        spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore', timeout: 10_000 });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
