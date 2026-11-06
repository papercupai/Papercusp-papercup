import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { runHarness } from '@papercusp/verification-harness';
import * as ts from 'typescript';
import { archivePrivateOperatorApiBuild, buildPrivateOperatorApiBundle, censusPrivateRuntimeArtifact, preparePrivateOperatorApiBundle, privateBundleRuntimeEnv, privateGitCloneBundleEnv, privatePgStartupIdentity, stopPrivateOperatorHost, waitForPrivateOperator, type PrivateHostStopObservation } from './private-http-workspace-preflight';
import { createHash, randomUUID } from 'node:crypto';
import { readProcessIdentity } from '../lib/process-identity';
import { hashNativeArtifactBytes, readNativeProcessTraceArtifacts } from '../../../scripts/lib/budgeted-task-scheduler.mjs';

const dirs: string[] = [];
const common = resolve(import.meta.dirname, '../../../apps/operator/bin/bundle-host-common.sh');
function cleanupPrivateHostTestDirectories(directories: string[], failed: boolean) {
  if (failed) {
    process.stderr.write(`[private-host-runtime] retained failure evidence: ${JSON.stringify(directories)}\n`);
    return;
  }
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
}

afterEach(({ task }) => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanupPrivateHostTestDirectories(dirs.splice(0), task.result?.state === 'fail');
});

it.each([false, true])('preserves private-host failure evidence and cleans successful fixtures (failed=%s)', failed => {
  const root = mkdtempSync(join(tmpdir(), 'private-builder-cleanup-')); dirs.push(root);
  const journal = join(root, 'hono-host.mjs.build-steps.jsonl');
  const original = '{"step":"compile","event":"start"}\n';
  writeFileSync(journal, original);
  const report = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    cleanupPrivateHostTestDirectories([root], failed);
    if (failed) {
      expect(readFileSync(journal, 'utf8')).toBe(original);
      expect(report).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify([root])));
    } else {
      expect(existsSync(root)).toBe(false);
      expect(report).not.toHaveBeenCalled();
    }
  } finally {
    report.mockRestore();
  }
});


it('censuses full private artifact bytes and modes with same-descriptor large-file advice', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-artifact-census-'));
  dirs.push(root);
  mkdirSync(join(root, 'nested'));
  const large = Buffer.alloc(16 * 1024 ** 2 + 17, 0xa7);
  const entries: Array<[string, Buffer, number]> = [
    ['empty', Buffer.alloc(0), 0o600], ['nested/model', large, 0o640],
    ['serve.mjs', Buffer.from('real small runtime bytes'), 0o755],
  ];
  const digest = createHash('sha256');
  for (const [path, data, mode] of entries) {
    writeFileSync(join(root, path), data); chmodSync(join(root, path), mode);
    digest.update(JSON.stringify([path, mode, createHash('sha256').update(data).digest('hex')]));
  }
  const before = statSync(join(root, 'nested/model'), { bigint: true });
  const observed: unknown[] = [];
  const result = censusPrivateRuntimeArtifact(root, { onReadAdvice: record => observed.push(record) });
  expect(result.sha256).toBe(digest.digest('hex'));
  expect(result.files).toBe(3);
  expect(result.bytes).toBe(entries.reduce((total, [, data]) => total + data.length, 0));
  expect(result.inventory.map(row => row.path)).toEqual(['', 'empty', 'nested', 'nested/model', 'serve.mjs']);
  expect(result.readAdvice).toEqual(observed);
  if (process.platform === 'linux') {
    expect(result.readAdvice).toEqual([expect.objectContaining({ path: 'nested/model',
      dev: String(before.dev), ino: String(before.ino), size: String(before.size),
      advice: 'POSIX_FADV_RANDOM', executable: expect.any(String), version: expect.any(String),
      helperSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      dependencySha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    const inputs = result.readAdvice[0].dependencies;
    expect(inputs.scope).toBe('isolated-python-imports-and-native-maps');
    expect(inputs.files.map(file => file.path)).toContain(inputs.resolvedExecutable);
    expect(inputs.modules.some(module => module.name === 'json' && module.files.length)).toBe(true);
    expect(inputs.limitations).toEqual(['startup-file-opens-unobserved', 'mapped-memory-bytes-unobserved']);
    for (const input of inputs.files) {
      expect(createHash('sha256').update(readFileSync(input.path)).digest('hex')).toBe(input.sha256);
      expect(statSync(input.path).size).toBe(input.size);
      expect(statSync(input.path).mode & 0o7777).toBe(input.mode);
    }
    expect(censusPrivateRuntimeArtifact(root, {
      expectedReadAdviceDependencySha256: result.readAdvice[0].dependencySha256,
    }).sha256).toBe(result.sha256);
  } else {
    expect(result.advicePlatform).toBe('not-applicable');
    expect(observed).toEqual([]);
  }
  const after = statSync(join(root, 'nested/model'), { bigint: true });
  for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const)
    expect(after[key]).toBe(before[key]);
});

it.skipIf(process.platform !== 'linux')('rejects private artifact advice from a different Python dependency closure', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-artifact-python-pin-'));
  dirs.push(root);
  writeFileSync(join(root, 'model'), Buffer.alloc(16 * 1024 ** 2));
  expect(() => censusPrivateRuntimeArtifact(root, {
    expectedReadAdviceDependencySha256: '0'.repeat(64),
  })).toThrow(/Python advice dependencies differ from fixture pin/);
  expect(() => censusPrivateRuntimeArtifact(root, {
    expectedReadAdviceDependencySha256: 'invalid',
  })).toThrow(/Invalid Python dependency pin/);
});

it.skipIf(process.platform !== 'linux')('rejects changed, replaced, or unenumerated artifact content after advice', () => {
  for (const mutation of ['truncate', 'replace', 'add'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'private-artifact-mutation-'));
    dirs.push(root);
    const file = join(root, 'model');
    writeFileSync(file, Buffer.alloc(16 * 1024 ** 2));
    expect(() => censusPrivateRuntimeArtifact(root, { onReadAdvice: () => {
      if (mutation === 'truncate') truncateSync(file, 8);
      if (mutation === 'replace') { renameSync(file, join(root, 'old')); writeFileSync(file, 'replacement'); }
      if (mutation === 'add') writeFileSync(join(root, 'new-unenumerated'), 'added');
    } })).toThrow(/Artifact changed during census/);
  }
});

it.skipIf(process.platform !== 'linux')('fails private artifact qualification when the Linux advice prerequisite is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-artifact-no-python-'));
  dirs.push(root);
  writeFileSync(join(root, 'model'), Buffer.alloc(16 * 1024 ** 2));
  vi.stubEnv('PATH', root);
  expect(() => censusPrivateRuntimeArtifact(root)).toThrow(/python3.*ENOENT/);
});

it.skipIf(process.platform === 'win32')('rejects artifact links and refuses byte/time overflow before reading', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-artifact-bounds-'));
  dirs.push(root);
  writeFileSync(join(root, 'real'), 'bytes');
  symlinkSync('real', join(root, 'link'));
  expect(() => censusPrivateRuntimeArtifact(root)).toThrow(/link or special object/);
  rmSync(join(root, 'link'));
  writeFileSync(join(root, 'oversized'), '');
  truncateSync(join(root, 'oversized'), 8 * 1024 ** 3 + 1);
  expect(() => censusPrivateRuntimeArtifact(root)).toThrow(/Artifact byte ceiling/);
  expect(() => censusPrivateRuntimeArtifact(root, { deadlineMs: Date.now() - 1 })).toThrow(/time ceiling/);
});

it.skipIf(process.platform !== 'linux')('runs the private artifact census in plain Node and retains its actual preparation inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-artifact-plain-node-'));
  dirs.push(root);
  const artifact = join(root, 'artifact');
  mkdirSync(artifact);
  writeFileSync(join(artifact, 'model'), Buffer.alloc(16 * 1024 ** 2, 0xa7));
  const reader = resolve(import.meta.dirname, 'private-runtime-artifact-census.mts');
  const trace = resolve(import.meta.dirname, '../../../scripts/lib/vitest-startup-trace.mjs');
  const out = join(root, 'source.json');
  const source = [
    "import { censusPrivateRuntimeArtifact } from " + JSON.stringify(pathToFileURL(reader).href) + ";",
    "const result = censusPrivateRuntimeArtifact(process.argv[1]);",
    "console.log(JSON.stringify({ pid: process.pid, executable: process.execPath,",
    "  versions: process.versions, execArgv: process.execArgv, result }));",
  ].join('\n');
  const result = JSON.parse(execFileSync(process.execPath,
    ['--import', pathToFileURL(trace).href, '--input-type=module', '-e', source, artifact], {
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', PC_EXECUTED_SOURCE_MAP_OUT: out },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    }));
  expect(result.versions.node).toBe(process.versions.node);
  expect(result.execArgv).not.toContain('tsx');
  expect(result.result.files).toBe(1);
  expect(result.result.readAdvice[0].dependencies.scope).toBe('isolated-python-imports-and-native-maps');
  const records = readdirSync(out + '.native-processes').filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(out + '.native-processes', name), 'utf8')));
  const own = records.filter(row => row.pid === result.pid);
  expect(own.find(row => row.event === 'node-entry').executable).toBe(process.execPath);
  expect(own.find(row => row.event === 'node-exit')).toMatchObject({ code: 0, exitListenersComplete: true });
  const loads = own.filter(row => row.event === 'module-load-return');
  expect(loads.map(row => row.url)).toEqual([pathToFileURL(reader).href]);
  expect(loads[0].source).toMatchObject({ status: 'hashed',
    sha256: createHash('sha256').update(readFileSync(reader)).digest('hex') });
  expect(own.filter(row => ['module-load-error', 'module-load-limit', 'module-load-unavailable'].includes(row.event))).toEqual([]);
});

it('observes a real private Node host through an explicitly fresh trace after removing inherited test preloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-host-selected-trace-'));
  dirs.push(root);
  const bundle = join(root, 'host.mjs'), traceOut = join(root, 'host-source.json');
  const source = 'console.log(JSON.stringify({ pid: process.pid, argv: process.argv }));';
  writeFileSync(bundle, source);
  const inherited = { ...process.env, NODE_OPTIONS: '--import tsx',
    PC_EXECUTED_SOURCE_MAP_OUT: join(root, 'inherited.json') };
  const env = privateBundleRuntimeEnv(inherited, { traceOut });
  expect(env.NODE_OPTIONS).not.toContain('tsx');
  expect(inherited.NODE_OPTIONS).toBe('--import tsx');
  const startedAtMs = Date.now();
  const child = JSON.parse(execFileSync(process.execPath, [bundle], { cwd: root, env,
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 }));
  const trace = readNativeProcessTraceArtifacts(traceOut, startedAtMs, Date.now());
  expect(trace.population.complete).toBe(true);
  expect(existsSync(inherited.PC_EXECUTED_SOURCE_MAP_OUT + '.native-processes')).toBe(false);
  const own = trace.rows.map(({ row }) => row).filter(row => row.pid === child.pid);
  expect(own.filter(row => row.event === 'node-entry')).toEqual([expect.objectContaining({ cwd: root,
    argv: child.argv, reporterOut: traceOut, executable: process.execPath })]);
  expect(new Set(own.map(row => row.processIdentity)).size).toBe(1);
  expect(own.find(row => row.event === 'node-exit')).toMatchObject({ code: 0, exitListenersComplete: true });
  expect(own.filter(row => row.event === 'module-load-return')).toEqual([expect.objectContaining({
    url: pathToFileURL(bundle).href, source: expect.objectContaining({ status: 'hashed',
      scope: 'node-loader-returned-source', sha256: createHash('sha256').update(source).digest('hex') }),
  })]);
  expect(() => privateBundleRuntimeEnv(inherited, { traceOut })).toThrow('fresh channel');
  expect(() => privateBundleRuntimeEnv(inherited, { traceOut: 'relative.json' })).toThrow('absolute channel');
  const occupied = join(root, 'occupied.json');
  writeFileSync(occupied, 'existing evidence');
  expect(() => privateBundleRuntimeEnv(inherited, { traceOut: occupied })).toThrow('fresh channel');
});

it.each(['matched', 'wrong-digest', 'wrong-size', 'unrelated'] as const)(
  'streams only independently admitted large loader bytes (%s)', control => {
    const root = mkdtempSync(join(tmpdir(), 'private-large-loader-')); dirs.push(root);
    const bundle = join(root, 'host.mjs'), traceOut = join(root, 'source.json');
    // A surrogate pair crosses the producer chunk boundary. Its UTF-8 bytes
    // must remain identical to the loader return, including in retained data.
    const source = '/*' + ' '.repeat(16 * 1024 - 3) + '😀' + ' '.repeat(16 * 1024 ** 2)
      + '*/console.log("loaded");';
    const byteLength = Buffer.byteLength(source), sha256 = createHash('sha256').update(source).digest('hex');
    writeFileSync(bundle, source);
    const env = privateBundleRuntimeEnv(process.env, { traceOut, pinnedSources: [{
      path: control === 'unrelated' ? join(root, 'different.mjs') : bundle,
      sha256: control === 'wrong-digest' ? '0'.repeat(64) : sha256,
      byteLength: control === 'wrong-size' ? byteLength - 1 : byteLength,
    }] });
    const started = Date.now();
    try {
      expect(execFileSync(process.execPath, [bundle], { cwd: root, env, encoding: 'utf8', timeout: 15_000 })).toBe('loaded\n');
    } catch (error) {
      const failure = error as Error & { code?: string; status?: number; signal?: string; stdout?: string; stderr?: string };
      writeFileSync(join(root, 'launch-failure.json'), JSON.stringify({
        elapsedMs: Date.now() - started, executable: process.execPath,
        nodeOptionsSha256: createHash('sha256').update(env.NODE_OPTIONS ?? '').digest('hex'),
        code: failure.code, status: failure.status,
        signal: failure.signal, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? ''),
      }));
      throw error;
    }
    const trace = readNativeProcessTraceArtifacts(traceOut, started, Date.now());
    expect(trace.population.complete).toBe(true);
    const retained = trace.rows.find(({ row }) => row.event === 'module-load-return')!.row.source;
    if (control === 'matched') {
      expect(retained).toMatchObject({ status: 'hashed', sha256, byteLength,
        admission: 'independently-pinned-large-source-v1' });
      let bytesRead = 0;
      expect(hashNativeArtifactBytes(join(trace.sourceRoot, retained.ref), byteLength, byteLength,
        count => { bytesRead += count; })).toBe(sha256);
      expect(bytesRead).toBe(byteLength);
      expect(() => hashNativeArtifactBytes(join(trace.sourceRoot, retained.ref), byteLength, byteLength - 1))
        .toThrow('native artifact byte limit');
    } else {
      expect(retained.status).toBe(control === 'unrelated' ? 'limit' : 'unavailable');
      expect(retained.ref).toBeUndefined();
      expect(readdirSync(trace.sourceRoot).filter(name => name.endsWith('.source'))).toEqual([]);
    }
  });

it('refuses malformed or unbounded source admissions before allocating the host trace', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-source-admission-')); dirs.push(root);
  const traceOut = join(root, 'source.json');
  const pin = { path: join(root, 'host.mjs'), sha256: 'a'.repeat(64), byteLength: 81_830_447 };
  for (const pins of [[{ ...pin, byteLength: 128 * 1024 ** 2 + 1 }],
    [pin, pin], [pin, { ...pin, path: join(root, 'b') }, { ...pin, path: join(root, 'c') },
      { ...pin, path: join(root, 'd') }], [{ ...pin, path: 'relative.mjs' }],
    [{ ...pin, sha256: 'invalid' }]]) {
    expect(() => privateBundleRuntimeEnv(process.env, { traceOut, pinnedSources: pins }))
      .toThrow('Invalid bounded native loader source pins');
    expect(existsSync(traceOut + '.native-processes')).toBe(false);
  }
});

it('retains teardown signal evidence on a forced-exit timeout and removes its listeners', async () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), 'private-stop-evidence-'));
  dirs.push(directory);
  const trace = join(directory, 'host-stop.jsonl');
  // Synthetic event emitters have no kernel process. A made-up PID can belong
  // to a real host process and make teardown inspect unrelated descendants.
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, exitCode: null, signalCode: null, stdout: null, stderr: null,
    kill: vi.fn(() => false),
  }) as unknown as import('node:child_process').ChildProcess;
  const observations: unknown[] = [];
  const stopped = stopPrivateOperatorHost(child, undefined, 10, observation => {
    observations.push(observation);
    appendFileSync(trace, JSON.stringify(observation) + '\n');
  });
  const rejected = expect(stopped).rejects.toMatchObject({
    message: 'Private host forced exit did not settle',
    privateHostStop: { pid: null, phase: 'forced exit', sigtermAccepted: false,
      sigkillAccepted: false, exitObserved: false, closeObserved: false },
  });
  await Promise.all([rejected, vi.advanceTimersByTimeAsync(21)]);
  expect(observations).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: 'signal', signal: 'SIGTERM', accepted: false }),
    expect.objectContaining({ phase: 'signal', signal: 'SIGKILL', accepted: false }),
  ]));
  expect(readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual(observations);
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
});

it.skipIf(process.platform !== 'linux')('retains missing kernel-process evidence without treating it as an exit', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: Number.MAX_SAFE_INTEGER, exitCode: null, signalCode: null, stdout: null, stderr: null,
    kill: vi.fn(() => true),
  }) as unknown as import('node:child_process').ChildProcess;
  const stopped = stopPrivateOperatorHost(child, undefined, 10);
  const rejected = expect(stopped).rejects.toMatchObject({
    message: 'Private host forced exit did not settle',
    privateHostStop: {
      phase: 'forced exit', exitObserved: false, closeObserved: false,
      kernelProcess: { status: 'absent', state: null, startTicks: null, waitChannel: null },
      observations: expect.arrayContaining([
        expect.objectContaining({ phase: 'signal', signal: 'SIGKILL',
          kernelProcess: expect.objectContaining({ status: 'absent' }) }),
      ]),
    },
  });
  await Promise.all([rejected, vi.advanceTimersByTimeAsync(21)]);
});

it('observes real private-host exit before dependent cleanup and ignores diagnostic callback failures', async () => {
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
  { env: privateBundleRuntimeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout!, 'data');
    let afterExit = false;
    const observations: Array<{ phase: string; kernelProcess?: {
      status: string; state: string | null; startTicks: string | null;
    } }> = [];
    await stopPrivateOperatorHost(child, async () => {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      afterExit = true;
    }, 2000, (observation) => {
      observations.push(observation);
      if (observation.phase === 'signal') throw new Error('diagnostic sink unavailable');
    });
    expect(afterExit).toBe(true);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'exit', exitObserved: true }),
      expect.objectContaining({ phase: 'complete', closeObserved: true }),
    ]));
    expect(child.exitCode).toBe(0);
    if (process.platform === 'linux') {
      expect(observations.find(o => o.phase === 'start')?.kernelProcess).toEqual(
        expect.objectContaining({ status: 'present', state: expect.stringMatching(/^[A-Za-z]$/),
          startTicks: expect.stringMatching(/^\d+$/) }),
      );
      expect(observations.find(o => o.phase === 'complete')?.kernelProcess?.status).toBe('absent');
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});

it.skipIf(process.platform !== 'linux')('rejects a real native crash after dependent cleanup and retains its exit evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-native-crash-')); dirs.push(root);
  const child = spawn('bash', ['-c', 'ulimit -c 0; exec "$@"', 'private-native-crash', process.execPath, '-e',
    "process.on('SIGTERM',()=>process.kill(process.pid,'SIGSEGV'));process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
  { env: privateBundleRuntimeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const observations: PrivateHostStopObservation[] = [];
  const stderr: Buffer[] = [];
  child.stderr!.on('data', chunk => stderr.push(Buffer.from(chunk)));
  let dependentCleaned = false;
  try {
    const [ready] = await once(child.stdout!, 'data');
    expect(String(ready)).toBe('ready\n');
    await expect(stopPrivateOperatorHost(child, async () => { dependentCleaned = true; }, 2000,
      observation => observations.push(observation)))
      .rejects.toMatchObject({
        message: 'Private host crashed during teardown: SIGSEGV',
        privateHostStop: {
          phase: 'native process termination', signalCode: 'SIGSEGV',
          exitObserved: true, closeObserved: true,
          kernelProcess: { status: 'absent' },
          observations: expect.arrayContaining([
            expect.objectContaining({ phase: 'signal', signal: 'SIGTERM', accepted: true }),
            expect.objectContaining({ phase: 'exit', signalCode: 'SIGSEGV' }),
            expect.objectContaining({ phase: 'failed', signalCode: 'SIGSEGV' }),
          ]),
        },
      });
    expect(dependentCleaned).toBe(true);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    writeFileSync(join(root, 'termination.json'), JSON.stringify({
      exitCode: child.exitCode, signalCode: child.signalCode, dependentCleaned,
      observations, stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  }
});

it.skipIf(process.platform !== 'linux').each(['graceful', 'forced', 'foreign PGDATA'])(
  'waits for owned PostgreSQL descendants after a primary exits with redirected output (%s)', async mode => {
  const forced = mode === 'forced';
  const directory = mkdtempSync(join(tmpdir(), 'private-pg-stop-'));
  dirs.push(directory);
  // A native process tree models the lifecycle independently of SQL/startup:
  // the postmaster accepts SIGINT, finishes later than its parent, and owns a
  // worker whose descriptors do not hold the parent's pipes open.
  const binary = join(directory, 'postgres');
  copyFileSync(process.execPath, binary);
  const child = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process'),fs=require('node:fs');
    const pg=spawn(${JSON.stringify(binary)},['-e',
      ${JSON.stringify("const {spawn}=require('node:child_process');const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGINT',()=>{" + (forced ? '' : "setTimeout(()=>{worker.kill('SIGTERM');worker.once('exit',()=>process.exit(0));},200)") + "});process.stdout.write(JSON.stringify({workerPid:worker.pid}));setInterval(()=>{},1000)")},
      '--','-D',${JSON.stringify(directory)}],{stdio:['ignore','pipe','ignore']});
    pg.stdout.once('data',chunk=>{
      fs.writeFileSync(${JSON.stringify(join(directory, 'postmaster.pid'))},pg.pid+'\\n'+${JSON.stringify(directory)}+'\\n');
      process.stdout.write(JSON.stringify({pid:pg.pid,...JSON.parse(String(chunk))})+'\\n');
    });
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
  `], { env: privateBundleRuntimeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let pgPid: number | undefined;
  const fixturePins: Array<{pid:number;identity:string|null}> = [];
  try {
    const ready = JSON.parse(String((await once(child.stdout!, 'data'))[0]));
    pgPid = ready.pid;
    for (const pid of [ready.pid, ready.workerPid]) fixturePins.push({pid,identity:readProcessIdentity(pid)});
    expect(fixturePins.every(pin => pin.identity)).toBe(true);
    if (mode === 'foreign PGDATA') writeFileSync(join(directory,'postmaster.pid'), pgPid+'\n'+tmpdir()+'\n');
    const observations: PrivateHostStopObservation[] = [];
    const cleanup = vi.fn(async () => {
      try {
        const stat = readFileSync(`/proc/${pgPid}/stat`, 'utf8');
        expect(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]).toMatch(/^[ZX]$/);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
    const stopped = stopPrivateOperatorHost(child, cleanup, forced ? 100 : 2000,
      observation => observations.push(observation));
    if (mode === 'foreign PGDATA') {
      await expect(stopped).rejects.toThrow('private postmaster PGDATA mismatch');
      expect(cleanup).not.toHaveBeenCalled();
      expect(fixturePins.every(pin => readProcessIdentity(pin.pid) === pin.identity)).toBe(true);
      expect(observations.some(o => o.phase === 'complete')).toBe(false);
      return;
    } else if (forced) {
      await expect(stopped).rejects.toThrow('Private PostgreSQL required forced cleanup');
      expect(cleanup).not.toHaveBeenCalled();
      expect(observations.at(-1)).toMatchObject({ phase: 'failed', exitObserved: true });
      expect(observations.some(o => o.phase === 'complete')).toBe(false);
    } else {
      await stopped;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(observations.findIndex(o => o.phase === 'postgres stopped')).toBeLessThan(
        observations.findIndex(o => o.phase === 'complete'));
    }
    const pins = observations.find(o => o.phase === 'postgres captured')?.postgres;
    expect(pins).toHaveLength(2);
    expect(pins?.filter(p => p.postmaster)).toHaveLength(1);
    expect(observations.at(-1)?.postgres?.every(p => p.state === null || p.state === 'Z' || p.state === 'X')).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    // Both negative controls and historical mutants can leave the fixture
    // alive. Only stop the exact native processes this test measured at birth.
    for (const pin of fixturePins) if (pin.identity && readProcessIdentity(pin.pid) === pin.identity) {
      try { process.kill(pin.pid,'SIGKILL'); } catch { /* stopped */ }
    }
    await vi.waitFor(() => {
      for (const pin of fixturePins) if (readProcessIdentity(pin.pid) === pin.identity) {
        const stat = readFileSync(`/proc/${pin.pid}/stat`,'utf8');
        expect(stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[0]).toMatch(/^[ZX]$/);
      }
    });
    await closed;
  }
});

it.skipIf(process.platform !== 'linux')('distinguishes a real stopped child and observes forced exit before declaring cleanup complete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-stopped-child-'));
  dirs.push(root);
  const observations: PrivateHostStopObservation[] = [];
  const child = spawn(process.execPath, ['-e',
    "process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
  { env: privateBundleRuntimeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout!, 'data');
    expect(child.kill('SIGSTOP')).toBe(true);
    await vi.waitFor(() => {
      const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      expect(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]).toBe('T');
    });
    await stopPrivateOperatorHost(child, undefined, 2_000, observation => observations.push(observation));
    const start = observations.find(o => o.phase === 'start');
    expect(start?.kernelProcess).toMatchObject({ status: 'present', state: 'T', startTicks: expect.stringMatching(/^\d+$/) });
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'signal', signal: 'SIGTERM', accepted: true }),
      expect.objectContaining({ phase: 'signal', signal: 'SIGKILL', accepted: true }),
      expect.objectContaining({ phase: 'exit', exitObserved: true, signalCode: 'SIGKILL' }),
      expect.objectContaining({ phase: 'complete', exitObserved: true, closeObserved: true,
        kernelProcess: expect.objectContaining({ status: 'absent' }) }),
    ]));
    for (const observation of observations.filter(o => o.kernelProcess?.status === 'present')) {
      expect(observation.kernelProcess?.startTicks).toBe(start?.kernelProcess?.startTicks);
    }
    expect(child.signalCode).toBe('SIGKILL');
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    writeFileSync(join(root, 'termination.json'), JSON.stringify({
      pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, observations,
    }));
  }
}, 10_000);

it('waits for delayed exit before cleanup and separately waits for pipe closure', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, exitCode: null as number | null, signalCode: null,
    stdout: { destroyed: false, readableEnded: false }, stderr: null,
    kill: vi.fn(() => true),
  });
  const cleanup = vi.fn(async () => { expect(child.exitCode).toBe(0); });
  let settled = false;
  const stopped = stopPrivateOperatorHost(child as unknown as import('node:child_process').ChildProcess,
    cleanup, 10).then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(9);
  expect(cleanup).not.toHaveBeenCalled();
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(0);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  child.emit('close', 0, null);
  await stopped;
  expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
});

it('retains a stdio timeout after process exit and safely stops an already closed host again', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, exitCode: 0, signalCode: null,
    stdout: { destroyed: false, readableEnded: false }, stderr: null,
    kill: vi.fn(() => true),
  });
  const stopped = stopPrivateOperatorHost(child as unknown as import('node:child_process').ChildProcess,
    undefined, 10);
  const rejected = expect(stopped).rejects.toMatchObject({
    privateHostStop: { phase: 'stdio drainage', exitObserved: true, closeObserved: false,
      sigtermAccepted: null, sigkillAccepted: null },
  });
  await Promise.all([rejected, vi.advanceTimersByTimeAsync(11)]);
  expect(child.listenerCount('close')).toBe(0);
  child.stdout.destroyed = true;
  await stopPrivateOperatorHost(child as unknown as import('node:child_process').ChildProcess, undefined, 10);
  expect(child.kill).not.toHaveBeenCalled();
});

it('retains a signal exception without running dependent cleanup', async () => {
  const denied = Object.assign(new Error('signal denied'), { code: 'EPERM' });
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, exitCode: null, signalCode: null, stdout: null, stderr: null,
    kill: vi.fn(() => { throw denied; }),
  });
  const cleanup = vi.fn();
  await expect(stopPrivateOperatorHost(child as unknown as import('node:child_process').ChildProcess,
    cleanup)).rejects.toMatchObject({
      code: 'EPERM', privateHostStop: { phase: 'signal', sigtermAccepted: false,
        exitObserved: false, closeObserved: false },
    });
  expect(cleanup).not.toHaveBeenCalled();
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
});

function privateBudgetEnvironment() {
  const home = mkdtempSync(join(tmpdir(), 'private-budget-auth-'));
  dirs.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('PAPERCUSP_HOME', join(home, '.papercusp'));
  vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'test-runtime-budget-auth');
  vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', '1');
  vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '0');
  vi.stubEnv('PAPERCUSP_DBOS_ENABLE', '0');
  return home;
}

it('loads production state only after budget measurement establishes private isolation', async () => {
  const home = privateBudgetEnvironment();
  const loaded = vi.fn();
  const blocked = vi.fn(() => { throw new Error('production state import blocked'); });
  vi.resetModules();
  vi.doMock('../lib/agent-tools/coordination/presence', () => {
    loaded('presence');
    return { getPresence: blocked, setCompactionLimit: blocked, writePresence: blocked };
  });
  vi.doMock('../../../apps/operator/scripts/psu-launcher.mjs', () => {
    loaded('launcher');
    return { suWrapperExtraArgs: blocked };
  });
  try {
    const scenario = await import('./codex-budget-http-scenario');
    await scenario.prepareCodexBudgetScenario('test-runtime-budget-auth');
    expect(loaded).not.toHaveBeenCalled();
    rmSync(join(home, '.codex', 'auth.json'));
    const options = { workspace: 'test-runtime-budget-auth', base: 'http://127.0.0.1:1',
      headers: {}, evidenceDir: home };
    vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', undefined);
    await expect(scenario.measureCodexBudgetScenario(options)).rejects.toThrow();
    expect(loaded).not.toHaveBeenCalled();
    expect(existsSync(join(home, '.codex', 'auth.json'))).toBe(false);
    vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', '1');
    await expect(scenario.measureCodexBudgetScenario(options)).rejects.toThrow('production state import blocked');
    expect(loaded.mock.calls.flat()).toEqual(expect.arrayContaining(['presence', 'launcher']));
    expect(blocked).toHaveBeenCalled();
  } finally {
    vi.doUnmock('../lib/agent-tools/coordination/presence');
    vi.doUnmock('../../../apps/operator/scripts/psu-launcher.mjs');
    vi.resetModules();
  }
});

it('prepares a disposable native login for the budget bootstrap without changing the account route', async () => {
  const home = privateBudgetEnvironment();
  const { prepareCodexBudgetScenario } = await import('./codex-budget-http-scenario');
  await prepareCodexBudgetScenario('test-runtime-budget-auth');
  const authPath = join(home, '.codex', 'auth.json');
  expect(JSON.parse(readFileSync(authPath, 'utf8'))).toEqual({ auth_mode: 'chatgpt', tokens: {
    access_token: expect.stringMatching(/^private-budget-no-provider-/), account_id: 'private-budget' } });
  expect(statSync(authPath).mode & 0o777).toBe(0o600);
  expect(process.env.PAPERCUSP_WORKSPACE_ID).toBe('test-runtime-budget-auth');
});

it('refuses the budget scenario before touching auth outside its isolated runtime', async () => {
  const home = privateBudgetEnvironment();
  vi.stubEnv('PC_ISOLATED_RUNTIME_PROOF', undefined);
  const { measureCodexBudgetScenario } = await import('./codex-budget-http-scenario');
  await expect(measureCodexBudgetScenario({ workspace: 'test-runtime-budget-auth',
    base: 'http://127.0.0.1:1', headers: {}, evidenceDir: home })).rejects.toThrow();
  expect(existsSync(join(home, '.codex'))).toBe(false);
});

it('refuses to overwrite an existing login in the budget fixture', async () => {
  const home = privateBudgetEnvironment();
  const { prepareCodexBudgetScenario } = await import('./codex-budget-http-scenario');
  mkdirSync(join(home, '.codex'));
  const authPath = join(home, '.codex', 'auth.json');
  const original = JSON.stringify({ tokens: { access_token: randomUUID() } });
  writeFileSync(authPath, original, { mode: 0o600 });
  await expect(prepareCodexBudgetScenario('test-runtime-budget-auth')).rejects.toThrow(/EEXIST/);
  expect(readFileSync(authPath, 'utf8')).toBe(original);
});

function pgStartup(fields: Record<string, string>) {
  const body = Buffer.from(Object.entries(fields).flatMap(([key, value]) => [key, value]).join('\0') + '\0\0');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + body.length, 0);
  header.writeUInt32BE(196608, 4);
  return Buffer.concat([header, body]);
}

it('retains only the database and application identity from a private PG startup', () => {
  const packet = pgStartup({ user: 'private-user', database: 'other-private-db',
    application_name: 'pcusp:other-pool:p123', password: 'private-password', options: 'private-options' });
  expect(privatePgStartupIdentity(Buffer.concat([packet, Buffer.from('private query content')]))).toEqual({
    database: 'other-private-db', applicationName: 'pcusp:other-pool:p123' });
});

it('ignores SSL, cancellation and query packets in private socket evidence', () => {
  for (const code of [80877103, 80877102]) {
    const packet = Buffer.alloc(16);
    packet.writeUInt32BE(packet.length, 0);
    packet.writeUInt32BE(code, 4);
    expect(privatePgStartupIdentity(packet)).toBeNull();
  }
  expect(privatePgStartupIdentity(Buffer.from('Qprivate SQL text\0'))).toBeNull();
  expect(privatePgStartupIdentity('private text')).toBeNull();
});

it('rejects truncated, unterminated and oversized private startup packets', () => {
  const packet = pgStartup({ database: 'private-db', application_name: 'private-pool' });
  expect(privatePgStartupIdentity(packet.subarray(0, -1))).toBeNull();
  const malformed = Buffer.from(packet);
  malformed[malformed.length - 1] = 1;
  expect(privatePgStartupIdentity(malformed)).toBeNull();
  const oversized = pgStartup({ database: 'x'.repeat(16_384) });
  expect(privatePgStartupIdentity(oversized)).toBeNull();
});

it('does not retain unbounded or control-character startup identity values', () => {
  expect(privatePgStartupIdentity(pgStartup({ database: 'x'.repeat(129), application_name: 'line\nbreak' }))).toEqual({
    database: null, applicationName: null });
});

it('retires the roster worker auth listener before its shared database pools', () => {
  const file = 'roster-stop-http-fixture.ts';
  const source = ts.createSourceFile(file, readFileSync(join(import.meta.dirname, file), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const cleanup = source.statements.find((node): node is ts.TryStatement =>
    ts.isTryStatement(node) && Boolean(node.finallyBlock));
  expect(cleanup?.finallyBlock, 'worker cleanup must also run after a rejected browser assertion').toBeDefined();
  const phases: Array<{ name: string; body: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'cleanupPhase' && ts.isStringLiteral(node.arguments[0])) {
      expect(ts.isAwaitExpression(node.parent), 'worker cleanup must await owned resources').toBe(true);
      phases.push({ name: node.arguments[0].text, body: node.arguments[1].getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(cleanup!.finallyBlock!);
  const auth = phases.findIndex(phase => phase.name === 'auth-invalidation-listener-stop');
  const pools = phases.findIndex(phase => phase.name === 'db-org-pools-reset');
  expect(auth, 'lazy principal LISTEN must not keep the proof worker alive').toBeGreaterThanOrEqual(0);
  expect(pools, 'all db-org pools must retire after the listener stops').toBeGreaterThan(auth);
  expect(phases[auth].body).toContain('await _stopInvalidationListenerForTests()');
  expect(phases[pools].body).toContain('_resetForTests()');
  const census = phases.findIndex(phase => phase.name === 'database-census');
  const hub = phases.findIndex(phase => phase.name === 'listen-hub-stop');
  const closed = phases.findIndex(phase => phase.name === 'database-resources-closed');
  expect(census, 'capture actual pool labels before retiring query pools').toBeLessThan(pools);
  expect(hub, 'retain hub connection labels before closing subscriptions').toBeGreaterThan(census);
  expect(hub, 'collector LISTEN subscriptions must retire before the shared pools').toBeLessThan(pools);
  expect(phases[hub].body).toContain('await _stopHubForTests()');
  const lockListeners = phases.findIndex(phase => phase.body.includes('await _resetListenersForTests()'));
  const lockPools = phases.findIndex(phase => phase.body.includes('await resetLockPools()'));
  expect(lockListeners, 'acknowledgement opens locks listeners outside db-org').toBeGreaterThan(census);
  expect(lockPools, 'the separate su-lock-tx pool must retire after its listeners').toBeGreaterThan(lockListeners);
  expect(lockPools, 'locks teardown must precede retirement of the shared database pools').toBeLessThan(pools);
  expect(phases[lockListeners].body).toContain("import('@papercusp/locks')");
  expect(phases[lockPools].body).toContain('_resetForTests: resetLockPools');
  expect(closed, 'verify referenced private sockets after pool close callbacks').toBeGreaterThan(pools);
  expect(phases[closed].body).toContain('assert.equal(retained.length, 0');
});

it('keeps request fixtures on the bounded progress-aware builder path', () => {
  const callers: string[] = [];
  const routingProof = '../lib/blueprint/launch-blueprint-account-route.e2e.test.ts';
  const nativeProof = '../lib/external-bench/current-su-native.integration.test.ts';
  const preparationProofs = [routingProof, nativeProof, 'grading-audit-runtime-fixture.ts'];
  for (const file of [...readdirSync(import.meta.dirname).filter(name =>
    name.endsWith('-http-fixture.ts') || name === 'knowledge-native-fixture.ts'), ...preparationProofs]) {
    const source = ts.createSourceFile(file, readFileSync(join(import.meta.dirname, file), 'utf8'),
      ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync'].includes(node.expression.text)) {
        expect(node.arguments.some(argument => argument.getText(source).includes('bundle-host.sh')),
          `${file} must use the shared builder instead of launching the build script directly`).toBe(false);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && (node.expression.text === 'buildPrivateOperatorApiBundle'
          || preparationProofs.includes(file) && node.expression.text === 'preparePrivateOperatorApiBundle')) {
        callers.push(file);
        expect(ts.isAwaitExpression(node.parent), `${file} must await build completion`).toBe(true);
        let policy: ts.Expression | undefined = node.arguments[2];
        if (preparationProofs.includes(file) && policy && ts.isObjectLiteralExpression(policy))
          policy = policy.properties.find((property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(source) === 'builder')?.initializer;
        expect(policy && ts.isObjectLiteralExpression(policy), `${file} needs a bounded progress policy`).toBe(true);
        if (policy && ts.isObjectLiteralExpression(policy)) {
          const values = Object.fromEntries(policy.properties.flatMap(property =>
            ts.isPropertyAssignment(property) && ts.isNumericLiteral(property.initializer)
              ? [[property.name.getText(source), Number(property.initializer.text)]] : []));
          expect(values.timeoutMs, `${file} must retain the existing stall checkpoint`).toBe(240_000);
          expect(values.maxMs, `${file} must retain the existing absolute ceiling`).toBe(420_000);
          if (file === 'grading-audit-runtime-fixture.ts')
            expect(policy.properties.some(property => ts.isPropertyAssignment(property)
              && property.name.getText(source) === 'retainedEvidenceDir'),
            'initial and recovery grading builds must retain diagnostics outside disposable source').toBe(true);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(callers.sort()).toEqual([routingProof, nativeProof, 'blog-post-http-fixture.ts', 'consult-cascade-http-fixture.ts', 'cupboard-listing-install-http-fixture.ts',
    'customer-data-support-http-fixture.ts', 'governance-http-fixture.ts', 'grading-audit-runtime-fixture.ts', 'grading-audit-runtime-fixture.ts', 'integrations-setup-http-fixture.ts', 'knowledge-native-fixture.ts', 'liveness-alarm-http-fixture.ts',
    'roster-stop-http-fixture.ts', 'staging-first-http-fixture.ts']);
});

it('prepares every roster API bundle before the private execute phase', () => {
  const file = join(import.meta.dirname, '../lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let contracts = 0;
  let cleanupProofs = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'recordIsolatedIntegrationProof') {
      const contract = node.arguments[0];
      if (contract && ts.isObjectLiteralExpression(contract)) {
        const properties = Object.fromEntries(contract.properties.flatMap(property =>
          ts.isPropertyAssignment(property) ? [[property.name.getText(source), property.initializer]] : []));
        if (properties.sourcePaths?.getText(source).includes('roster-stop-http-fixture.ts')) {
          if (properties.execute?.getText(source).includes("'--health-cleanup-proof'")) {
            // This original worker path only seeds readers and exits through
            // cleanup; it never starts an API or needs an API bundle.
            expect(properties.prepare).toBeUndefined();
            cleanupProofs++;
            return;
          }
          contracts++;
          const line = source.getLineAndCharacterOfPosition(contract.getStart(source)).line + 1;
          const context = `roster proof at line ${line}`;
          let preparationCalls = 0;
          const inspectPreparation = (child: ts.Node) => {
            if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)
              && child.expression.text === 'preparePrivateOperatorApiBundle') {
              preparationCalls++;
              expect(ts.isAwaitExpression(child.parent), `${context} must await progress-aware preparation`).toBe(true);
              const policy = child.arguments[2];
              const builder = policy && ts.isObjectLiteralExpression(policy)
                ? policy.properties.find((property): property is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(property) && property.name.getText(source) === 'builder')?.initializer : undefined;
              expect(builder && ts.isObjectLiteralExpression(builder), `${context} needs a bounded progress policy`).toBe(true);
              if (builder && ts.isObjectLiteralExpression(builder)) {
                const values = Object.fromEntries(builder.properties.flatMap(property =>
                  ts.isPropertyAssignment(property) && ts.isNumericLiteral(property.initializer)
                    ? [[property.name.getText(source), Number(property.initializer.text)]] : []));
                expect(values.timeoutMs, `${context} must retain the existing stall checkpoint`).toBe(240_000);
                expect(values.maxMs, `${context} must retain the existing absolute ceiling`).toBe(420_000);
              }
            }
            ts.forEachChild(child, inspectPreparation);
          };
          if (properties.prepare) inspectPreparation(properties.prepare);
          expect(preparationCalls, `${context} must compile before private allocation`).toBe(1);
          for (const path of ['apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'])
            expect(properties.sourcePaths.getText(source), `${context} must pin its preparation source`).toContain(path);
          const inspectExecution = (child: ts.Node) => {
            if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'fork'
              && child.getText(source).includes('roster-stop-http-fixture.ts')) {
              const argv = child.arguments[1];
              expect(argv && ts.isArrayLiteralExpression(argv), `${context} must declare worker arguments`).toBe(true);
              if (argv && ts.isArrayLiteralExpression(argv)) expect(argv.elements.some(argument =>
                ts.isBinaryExpression(argument) && ts.isStringLiteral(argument.left)
                  && argument.left.text === '--prepared-api-sha='), `${context} must consume the prepared bundle`).toBe(true);
            }
            ts.forEachChild(child, inspectExecution);
          };
          if (properties.execute) inspectExecution(properties.execute);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(contracts).toBe(18);
  expect(cleanupProofs).toBe(1);
});

it.each(['3.0.0', '2.11.0'])('refuses a private build before spawn when SDK %s violates its declared range', installed => {
  const root = mkdtempSync(join(tmpdir(), 'private-dependency-range-')); dirs.push(root);
  const workspace = join(root, 'packages/operator-core');
  const sdk = join(workspace, 'node_modules/@opentelemetry/sdk-trace');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: {
    '@opentelemetry/sdk-trace': '^2.12.0' } }));
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ version: installed }));
  const spawned = join(root, 'spawned');
  expect(() => buildPrivateOperatorApiBundle(root, root, { command: 'bash',
    args: ['-c', 'touch "$1"', '_', spawned], timeoutMs: 1000 }))
    .toThrow(`@opentelemetry/sdk-trace: declared ^2.12.0, installed ${installed}`);
  expect(existsSync(spawned)).toBe(false);
  expect(existsSync(join(root, 'operator-api-build.log'))).toBe(false);
});

it('allows a private build with a compatible hoisted SDK', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-dependency-range-')); dirs.push(root);
  const workspace = join(root, 'packages/operator-core');
  const sdk = join(root, 'node_modules/@opentelemetry/sdk-trace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: {
    '@opentelemetry/sdk-trace': '^2.12.0' } }));
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ version: '2.12.1' }));
  const bundle = join(root, 'hono-host.mjs');
  const result = buildPrivateOperatorApiBundle(root, root, { command: 'bash',
    args: ['-c', 'echo bundle > "$1"', '_', bundle], timeoutMs: 1000 });
  expect(result.path).toBe(bundle);
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
});

it('strips unit-only controls from a private builder child without mutating its input env', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-builder-env-')); dirs.push(root);
  const workspace = join(root, 'packages/operator-core');
  const sdk = join(root, 'node_modules/@opentelemetry/sdk-trace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: {
    '@opentelemetry/sdk-trace': '^2.12.0' } }));
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ version: '2.12.1' }));
  const bundle = join(root, 'hono-host.mjs');
  const env = {
    PAPERCUSP_FORBID_REAL_PG: '1', VITEST: 'true', VITEST_WORKER_ID: '9', VITEST_POOL_ID: '2',
    PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: '/test-only-census.json', PAPERCUSP_SID: 'builder-owner',
  };
  const script = [
    'const { writeFileSync } = require("node:fs");',
    'console.log(JSON.stringify({',
    'rail: process.env.PAPERCUSP_FORBID_REAL_PG ?? null,',
    'vitest: process.env.VITEST ?? null,',
    'worker: process.env.VITEST_WORKER_ID ?? null,',
    'pool: process.env.VITEST_POOL_ID ?? null,',
    'census: process.env.PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE ?? null,',
    'owner: process.env.PAPERCUSP_SID ?? null',
    '}));',
    'writeFileSync(process.argv[1], "bundle");',
  ].join(' ');
  const result = buildPrivateOperatorApiBundle(root, root, {
    command: process.execPath, args: ['-e', script, bundle], env, timeoutMs: 1000,
  });

  expect(result.path).toBe(bundle);
  expect(JSON.parse(readFileSync(join(root, 'operator-api-build.log'), 'utf8'))).toEqual({
    rail: null, vitest: null, worker: null, pool: null, census: null, owner: 'builder-owner',
  });
  expect(env).toMatchObject({ PAPERCUSP_FORBID_REAL_PG: '1', VITEST: 'true',
    VITEST_WORKER_ID: '9', VITEST_POOL_ID: '2',
    PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: '/test-only-census.json' });
});

it('stops builder descendants on timeout and retains the original diagnostics', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const childFile = join(evidenceDir, 'descendant.pid');
  let descendant: number | undefined;
  try {
    expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
      args: ['-c', 'source "$2"; BUNDLE_HOST_STEP_LOG="$3"; bundle_host_run_step blocked-builder bash -c \'sleep 60 & echo $! > "$1"; echo CHILD_READY; wait\' _ "$1"',
        '_', childFile, common, join(evidenceDir, 'hono-host.mjs.build-steps.jsonl')],
      timeoutMs: 1000 })).toThrow(/ETIMEDOUT/);
    descendant = Number(readFileSync(childFile, 'utf8'));
    expect(readFileSync(join(evidenceDir, 'operator-api-build.log'), 'utf8')).toContain('CHILD_READY');
    const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
    expect(receipt).toMatchObject({ signal: 'SIGKILL', status: null, error: { code: 'ETIMEDOUT' }, groupStop: 'signaled' });
    expect(receipt.steps).toMatchObject({ active: 'blocked-builder', count: 1, unreadableRows: [],
      last: { step: 'blocked-builder', event: 'start', pid: expect.any(Number), at: expect.any(Number) } });
    await expect.poll(() => {
      try { return readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error; }
    }).toMatch(/^(?:gone|Z|X)$/);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

it.each(['synchronous', 'progress'] as const)('retains original %s builder failure evidence after disposable output cleanup', async mode => {
  const output = mkdtempSync(join(tmpdir(), 'private-builder-output-')); dirs.push(output);
  const retained = mkdtempSync(join(tmpdir(), 'private-builder-retained-')); dirs.push(retained);
  const journal = join(output, 'hono-host.mjs.build-steps.jsonl');
  const builder = { command: 'bash',
    args: ['-c', 'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; bundle_host_run_step source-guard bash -c "echo ORIGINAL_BUILD_REFUSAL >&2; exit 78"',
      '_', common, journal], timeoutMs: 2000, retainedEvidenceDir: retained,
    ...(mode === 'progress' ? { maxMs: 3000, pollMs: 20 } : {}) };
  await expect(Promise.resolve().then(() => buildPrivateOperatorApiBundle(output, output, builder)))
    .rejects.toThrow(/exited 78/);
  const names = ['operator-api-build.log', 'operator-api-build-result.json', 'hono-host.mjs.build-steps.jsonl'];
  const originals = names.map(name => readFileSync(join(output, name)));
  rmSync(output, { recursive: true, force: true });
  names.forEach((name, index) => expect(readFileSync(join(retained, name))).toEqual(originals[index]));
  expect(readFileSync(join(retained, names[0]), 'utf8')).toContain('ORIGINAL_BUILD_REFUSAL');
  expect(JSON.parse(readFileSync(join(retained, names[1]), 'utf8')))
    .toMatchObject({ status: 78, steps: { last: { step: 'source-guard', event: 'end', status: 78 } } });
});

it('admits the grading lifecycle diagnostic manifest through the real retention harness', async () => {
  const path = resolve(import.meta.dirname, '../lib/release/grading-audit-runtime.integration.test.ts');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const artifacts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'retainedArtifacts') {
      expect(ts.isArrayLiteralExpression(node.initializer)).toBe(true);
      if (ts.isArrayLiteralExpression(node.initializer))
        for (const element of node.initializer.elements) {
          expect(ts.isStringLiteral(element)).toBe(true);
          if (ts.isStringLiteral(element)) artifacts.push(element.text);
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(artifacts).toHaveLength(8);
  const root = mkdtempSync(join(tmpdir(), 'grading-retention-manifest-')); dirs.push(root);
  const result = await runHarness({
    contract: { name: 'grading-retention-admission', phases: [{ id: 'execute' }] },
    evidenceRoot: root, retainedArtifacts: artifacts,
    runPhase: async ({ evidenceDir }) => {
      for (const artifact of artifacts) {
        expect(artifact.startsWith('phases/execute/')).toBe(true);
        const file = join(evidenceDir, artifact.slice('phases/execute/'.length));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `original:${artifact}`);
      }
      return { ok: true };
    },
  });
  for (const artifact of artifacts)
    expect(readFileSync(join(result.evidenceDir, artifact), 'utf8')).toBe(`original:${artifact}`);
});

it('retains completed step timing and the failing command status', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; bundle_host_run_step cli-guard bash -c "exit 17"',
      '_', common, journal], timeoutMs: 1000 })).toThrow(/exited 17/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ status: 17, steps: { active: null, count: 2, unreadableRows: [],
    durationsMs: [{ step: 'cli-guard', status: 17, elapsedMs: expect.any(Number) }] } });
  expect(receipt.steps.durationsMs[0].elapsedMs).toBeGreaterThanOrEqual(0);
});

it('preserves the timeout when the final journal append is partial', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  writeFileSync(join(evidenceDir, 'hono-host.mjs.build-steps.jsonl'),
    JSON.stringify({ at: 1, pid: 1, step: 'syntax-check', event: 'start' }) + '\n{"at":');
  expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'sleep 60'], timeoutMs: 100 })).toThrow(/ETIMEDOUT/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ error: { code: 'ETIMEDOUT' }, steps: { active: 'syntax-check', unreadableRows: [2] } });
});

it('allows a progressing real build beyond its checkpoint and retains its bounded success', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  const result = await buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; for step in a b c d e; do bundle_host_run_step "$step" sleep .5; done; echo bundle > "$3"',
      '_', common, journal, join(evidenceDir, 'hono-host.mjs')], timeoutMs: 2000, maxMs: 6000, pollMs: 20 });
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ status: 0, signal: null, progress: { extensions: expect.any(Number) } });
  expect(receipt.elapsedMs).toBeGreaterThan(2000);
  expect(receipt.progress.extensions).toBeGreaterThan(0);
  expect(receipt.elapsedMs).toBeLessThan(6000);
});

it('prepares the real bundle receipt after progress renews the build checkpoint', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-prepared-builder-')); dirs.push(evidenceDir);
  const bundle = join(evidenceDir, 'hono-host.mjs');
  const result = await preparePrivateOperatorApiBundle(evidenceDir, evidenceDir, { builder: {
    command: 'bash', args: ['-c',
      'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; for step in a b c d e; do bundle_host_run_step "$step" sleep .5; done; echo bundle > "$3"',
      '_', common, `${bundle}.build-steps.jsonl`, bundle], timeoutMs: 2000, maxMs: 6000, pollMs: 20,
  } });
  const retained = readFileSync(join(evidenceDir, 'operator-api-preflight.json'));
  expect(JSON.parse(String(retained))).toEqual({ path: bundle, sha256: result.sha256 });
  expect(result.receiptSha256).toBe(createHash('sha256').update(retained).digest('hex'));
  expect(result.sha256).toBe(createHash('sha256').update(readFileSync(bundle)).digest('hex'));
  const build = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(build.elapsedMs).toBeGreaterThan(2000);
  expect(build.progress.extensions).toBeGreaterThan(0);
  expect(build.status).toBe(0);
});

it('rebuilds relocated source with a fresh journal while preserving the first build evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-relocated-build-')); dirs.push(directory);
  const source = join(directory, 'source');
  let output = join(source, 'dist-host');
  mkdirSync(output, { recursive: true });
  const build = (value: string) => preparePrivateOperatorApiBundle(directory, output, { builder: {
    command: 'bash', args: ['-c',
      'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; bundle_host_run_step compile true; printf "%s" "$4" > "$3"',
      '_', common, join(output, 'hono-host.mjs.build-steps.jsonl'), join(output, 'hono-host.mjs'), value],
    timeoutMs: 2000, maxMs: 6000, pollMs: 20,
  } });
  await build('initial');
  const names = ['hono-host.mjs', 'operator-api-preflight.json', 'operator-api-build.log',
    'operator-api-build-result.json', 'hono-host.mjs.build-steps.jsonl'];
  const original = names.map(name => readFileSync(join(output, name)));
  const relocated = join(directory, 'relocated');
  renameSync(source, relocated);
  output = join(relocated, 'dist-host');
  await expect(Promise.resolve().then(() => build('unarchived')))
    .rejects.toThrow('Progress build requires a fresh retained step journal');
  const archive = archivePrivateOperatorApiBuild(output, join(directory, 'initial-build'));
  const rebuilt = await build('recovered');
  expect(readFileSync(rebuilt.path, 'utf8')).toBe('recovered');
  expect(JSON.parse(readFileSync(join(output, 'operator-api-build-result.json'), 'utf8')).status).toBe(0);
  expect(readFileSync(join(output, 'hono-host.mjs.build-steps.jsonl'), 'utf8')).toContain('compile');
  names.forEach((name, index) => expect(readFileSync(join(archive, name))).toEqual(original[index]));
  expect(() => archivePrivateOperatorApiBuild(output, archive)).toThrow('must not be overwritten');
  expect(readFileSync(rebuilt.path, 'utf8')).toBe('recovered');
});

it('reports only distinct completed build steps to the enclosing watchdog', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-progress-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  const completed: Array<{ step: string; completedSteps: number }> = [];
  await buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', `source "$1"; BUNDLE_HOST_STEP_LOG="$2";
      bundle_host_run_step first true;
      bundle_host_run_step first true;
      (bundle_host_run_step first true);
      bundle_host_run_step failed false;
      printf '{"at":%s,"pid":%s,"step":"unpaired","event":"end","status":0}\n' "$(date +%s.%N)" "$$" >> "$2";
      bundle_host_run_step last true;
      printf '{"at":' >> "$2";
      echo bundle > "$3"`, '_', common, journal, join(evidenceDir, 'hono-host.mjs')],
    timeoutMs: 600, maxMs: 2400, pollMs: 20,
    onProgress: progress => completed.push(progress),
  });
  expect(completed).toEqual([{ step: 'first', completedSteps: 1 }, { step: 'last', completedSteps: 2 }]);
});

it('withholds a prepared receipt when the progress builder stalls', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-prepared-stall-')); dirs.push(evidenceDir);
  await expect(preparePrivateOperatorApiBundle(evidenceDir, evidenceDir, { builder: {
    command: 'bash', args: ['-c', 'sleep 60'], timeoutMs: 600, maxMs: 2400, pollMs: 20,
  } })).rejects.toThrow(/ETIMEDOUT.*progress-unknown/);
  expect(readdirSync(evidenceDir)).not.toContain('operator-api-preflight.json');
  const build = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(build.watchdog).toMatchObject({ reason: 'progress-unknown', completedSteps: 0, extensions: 0 });
});

it.each(['logs', 'repeated-step', 'repeated-step-new-pid', 'incomplete-step'])('does not renew a stalled build for %s', async noise => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  const command = noise === 'logs' ? 'echo STILL_ALIVE'
    : noise === 'repeated-step' ? 'bundle_host_run_step same true'
    : noise === 'repeated-step-new-pid' ? '(bundle_host_run_step same true)'
    : 'printf \'{"at":\' >> "$BUNDLE_HOST_STEP_LOG"';
  await expect(buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', `source "$1"; BUNDLE_HOST_STEP_LOG="$2"; bundle_host_run_step same true; while true; do ${command}; sleep .08; done`,
      '_', common, journal], timeoutMs: 600, maxMs: 2400, pollMs: 20 })).rejects.toThrow(/ETIMEDOUT.*progress-stalled/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ error: { code: 'ETIMEDOUT' }, watchdog: { completedSteps: 1, reason: 'progress-stalled' } });
  expect(receipt.elapsedMs).toBeLessThan(2400);
});

it('stops the entire async builder group when no completed progress exists', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const childFile = join(evidenceDir, 'descendant.pid');
  await expect(buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'source "$2"; BUNDLE_HOST_STEP_LOG="$3"; bundle_host_run_step stuck bash -c \'sleep 60 & echo $! > "$1"; echo CHILD_READY; wait\' _ "$1"',
      '_', childFile, common, join(evidenceDir, 'hono-host.mjs.build-steps.jsonl')],
    timeoutMs: 600, maxMs: 2400, pollMs: 20 })).rejects.toThrow(/ETIMEDOUT.*progress-unknown/);
  const descendant = Number(readFileSync(childFile, 'utf8'));
  await expect.poll(() => {
    try { return readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error; }
  }).toMatch(/^(?:gone|Z|X)$/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt.watchdog).toMatchObject({ reason: 'progress-unknown', completedSteps: 0, extensions: 0 });
  expect(readFileSync(join(evidenceDir, 'operator-api-build.log'), 'utf8')).toContain('CHILD_READY');
});

it('enforces the absolute build ceiling despite distinct successful step progress', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  // Exercise the builder's journal sampler and real child teardown while
  // controlling time and progress independently of OS sleep scheduling.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const build = buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'sleep 60'], timeoutMs: 600, maxMs: 1200, pollMs: 20 });
  const rejected = expect(build).rejects.toThrow(/ETIMEDOUT.*absolute-ceiling/);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  for (let step = 1; step <= 6; step++) {
    for (const event of ['start', 'end']) appendFileSync(journal, JSON.stringify({
      at: Date.now() / 1000, pid: process.pid, step: `step-${step}`, event, status: 0,
    }) + '\n');
    await vi.advanceTimersByTimeAsync(200);
  }
  await rejected;
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt.watchdog).toMatchObject({ reason: 'absolute-ceiling' });
  // Timers may fire just before their requested deadline and schedule one
  // additional remainder. The contract is the absolute stop, not callback count.
  expect(receipt.watchdog.extensions).toBeGreaterThan(0);
  expect(receipt.elapsedMs).toBeGreaterThanOrEqual(1200);
  expect(receipt.elapsedMs).toBeLessThan(2400);
  expect(receipt.watchdog.completedSteps).toBeGreaterThan(1);
});

it('retains and rejects an async builder launch failure without waiting for the ceiling', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  await expect(buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, {
    command: join(evidenceDir, 'missing-builder'), args: [], timeoutMs: 600, maxMs: 2400,
  })).rejects.toMatchObject({ code: 'ENOENT' });
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt.error).toMatchObject({ code: 'ENOENT' });
  expect(receipt.progress).toEqual({ extensions: 0, completedSteps: 0 });
});

it('hands a verified Git clone to the real source guard without its donor archive identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-clone-source-')); dirs.push(root);
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args],
    { encoding: 'utf8', timeout: 10_000 }).trim();
  git(['init', '--quiet']);
  git(['-c', 'user.name=Private fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '--allow-empty', '-m', 'selected source']);
  const selectedCommit = git(['rev-parse', 'HEAD']);
  const env = { VERIFY_TAURI_SOURCE_RECEIPT: '/donor/source.json', VERIFY_TAURI_SOURCE_REF: selectedCommit,
    NODE_OPTIONS: '--import=/selected/scripts/lib/committed-source-loader.mjs', OTHER: 'keep' };
  const run = (environment: NodeJS.ProcessEnv) => spawnSync('bash', ['-c',
    'source "$COMMON"; bundle_host_source_sha "$REPO_ROOT"'],
    { env: { PATH: process.env.PATH, COMMON: common, REPO_ROOT: root, ...environment }, encoding: 'utf8', timeout: 10_000 });
  expect(run(env)).toMatchObject({ status: 78,
    stderr: 'bundle-host.sh: pinned source receipt requires its archive marker\n' });
  const environment = privateGitCloneBundleEnv(root, selectedCommit, env);
  expect(environment).toEqual({ NODE_OPTIONS: env.NODE_OPTIONS, OTHER: 'keep' });
  expect(run(environment)).toMatchObject({ status: 0, stdout: git(['rev-parse', '--short', 'HEAD']) });
  expect(env.VERIFY_TAURI_SOURCE_RECEIPT).toBe('/donor/source.json');
  expect(() => privateGitCloneBundleEnv(root, '0'.repeat(40), env)).toThrow('differs from the selected commit');
  mkdirSync(join(root, 'nested'));
  expect(() => privateGitCloneBundleEnv(join(root, 'nested'), selectedCommit, env)).toThrow('own its Git source root');
  writeFileSync(join(root, '.verifier-source.json'), '{}');
  expect(() => privateGitCloneBundleEnv(root, selectedCommit, env)).toThrow('not an archive');
});

it.each(['--import=tsx', '--import "tsx"', '--loader=tsx/esm', '--require tsx/cjs',
  '--import="file:///repo/node_modules/tsx/dist/loader.mjs"'])('removes %s and preserves guarded plain Node options', preload => {
  const guard = '--import="/repo with spaces/scripts/lib/committed-source-loader.mjs"';
  const env = { NODE_OPTIONS: `${guard} ${preload} --max-old-space-size=4096 --trace-warnings`,
    OTHER: 'keep', PAPERCUSP_HARNESS_DIR: '/repo/libs/papercusp/packages/harness' };
  expect(privateBundleRuntimeEnv(env)).toEqual({ ...env,
    NODE_OPTIONS: `${guard} --max-old-space-size=4096 --trace-warnings` });
  expect(env.NODE_OPTIONS).toContain(preload);
});

it.each(['--import=/repo/scripts/lib/vitest-startup-trace.mjs',
  '--import "file:///repo%20with%20spaces/scripts/lib/vitest-startup-trace.mjs"',
  '--require=/repo/scripts/lib/vitest-startup-trace.mjs'])('removes test-owned startup trace %s while retaining source guards', preload => {
  const guard = '--import="/repo with spaces/scripts/lib/committed-source-loader.mjs"';
  const env = { NODE_OPTIONS: `${preload} ${guard} --trace-warnings`, OTHER: 'keep' };
  expect(privateBundleRuntimeEnv(env)).toEqual({ ...env, NODE_OPTIONS: `${guard} --trace-warnings` });
  expect(env.NODE_OPTIONS).toContain(preload);
});

it('preserves unrelated loaders and similarly named imports', () => {
  const env = { NODE_OPTIONS: '--import=/repo/tsx-observer.mjs --loader=other-loader --require ./guard.cjs'
    + ' --import=/repo/other/vitest-startup-trace.mjs --import=/repo/scripts/lib/vitest-startup-trace.mjs-extra' };
  expect(privateBundleRuntimeEnv(env)).toEqual(env);
});

it('boots a real confined Node descendant after removing the inaccessible test tracer and keeps its source guard', () => {
  const traceRoot = mkdtempSync(join(tmpdir(), 'private-hidden-trace-')); dirs.push(traceRoot);
  const guardRoot = mkdtempSync(join(tmpdir(), 'private-visible-guard-')); dirs.push(guardRoot);
  mkdirSync(join(traceRoot, 'scripts/lib'), { recursive: true });
  const trace = join(traceRoot, 'scripts/lib/vitest-startup-trace.mjs');
  const guard = join(guardRoot, 'committed-source-loader.mjs');
  writeFileSync(trace, 'globalThis.privateTraceLoaded = true;');
  writeFileSync(guard, 'globalThis.privateGuardLoaded = true;');
  const env = { ...process.env,
    NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(trace).href)} --import=${JSON.stringify(pathToFileURL(guard).href)} --trace-warnings` };
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--ro-bind', guardRoot, guardRoot, '--tmpfs', traceRoot, '--', process.execPath, '-e',
    'console.log(JSON.stringify({guard:globalThis.privateGuardLoaded,trace:globalThis.privateTraceLoaded??false}))'];
  const failed = spawnSync('bwrap', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  expect(failed.error).toBeUndefined();
  expect(failed.status, failed.stderr).toBe(1);
  expect(failed.stderr).toContain('ERR_MODULE_NOT_FOUND');
  expect(failed.stderr).toContain('vitest-startup-trace.mjs');
  const launched = spawnSync('bwrap', args, { env: privateBundleRuntimeEnv(env),
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  expect(launched.error).toBeUndefined();
  expect(launched.status, launched.stderr).toBe(0);
  expect(JSON.parse(launched.stdout)).toEqual({ guard: true, trace: false });
});

it.each(['signal', 'exit'] as const)('persists readiness evidence when the real child terminates by %s', async kind => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-readiness-')); dirs.push(evidenceDir);
  const child = spawn(process.execPath, ['-e', kind === 'signal'
    ? 'process.kill(process.pid,"SIGTERM")' : 'process.exit(17)'], { env: privateBundleRuntimeEnv(process.env) });
  await once(child, 'close');
  await expect(waitForPrivateOperator({ host: child, base: 'http://127.0.0.1:1', evidenceDir,
    environment: { MALLOC_ARENA_MAX: '2' }, timeoutMs: 1000 })).rejects.toThrow(/before readiness/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'readiness.json'), 'utf8'));
  expect(receipt).toMatchObject({ attempts: 0, mallocArenaMax: '2', failure: expect.stringContaining('before readiness'),
    exitCode: kind === 'exit' ? 17 : null, signalCode: kind === 'signal' ? 'SIGTERM' : null });
});

it('retains the successful health probe and actual launch options', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-readiness-')); dirs.push(evidenceDir);
  const server = createServer((_, response) => response.end(JSON.stringify({ service: 'papercusp-operator' })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: privateBundleRuntimeEnv(process.env) });
  const environment = privateBundleRuntimeEnv({ NODE_OPTIONS: '--import=tsx --trace-warnings' });
  try {
    const address = server.address() as { port: number };
    await expect(waitForPrivateOperator({ host: child, base: `http://127.0.0.1:${address.port}`, evidenceDir,
      environment, timeoutMs: 1000 })).resolves.toEqual({ service: 'papercusp-operator' });
    expect(JSON.parse(readFileSync(join(evidenceDir, 'readiness.json'), 'utf8'))).toMatchObject({
      attempts: 1, nodeOptions: '--trace-warnings', probes: [{ status: 200, service: 'papercusp-operator', elapsedMs: expect.any(Number) }] });
  } finally {
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    server.close(); await once(server, 'close');
  }
});
