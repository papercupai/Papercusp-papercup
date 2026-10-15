import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loaderIdentity, nativeProcessTraceEnv, observeForkStartup, startupTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';

describe('focused runner startup tracing', () => {
  it('arms native observation only on the existing OUT channel, without changing stderr trace mode', () => {
    const plain = { NODE_OPTIONS: '--conditions=test' };
    expect(nativeProcessTraceEnv(plain)).toBe(plain);
    const armed = nativeProcessTraceEnv({ ...plain, PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/native.json' });
    expect(armed.NODE_OPTIONS).toContain(plain.NODE_OPTIONS);
    expect(armed.PAPERCUSP_TEST_STARTUP_TRACE).toBeUndefined();
    expect(nativeProcessTraceEnv(armed).NODE_OPTIONS).toBe(armed.NODE_OPTIONS);
  });

  it.each([false, true])('retains actual npm lifecycle and compound-script Node entries, failure=%s', async fail => {
    const dir = mkdtempSync(join(tmpdir(), 'native-npm-process-'));
    const out = join(dir, 'sources.json');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'native-process-fixture', scripts: {
      pretest: 'node pre.cjs', test: 'node first.cjs && node second.cjs', posttest: 'node post.cjs',
    } }));
    for (const name of ['pre', 'first', 'second', 'post']) {
      writeFileSync(join(dir, `${name}.cjs`), `process.stdout.write(${JSON.stringify(name + '\n')});` +
        (fail && name === 'second' ? 'process.exitCode = 7;' : ''));
    }
    try {
      const env = nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        PAPERCUSP_TEST_STARTUP_TRACE: '0' });
      let stdout = '', stderr = '', code = 0;
      try { ({ stdout, stderr } = await promisify(execFile)('npm', ['run', '--silent', 'test'], {
        cwd: dir, env, timeout: 15_000,
      })); } catch (error: any) { stdout = error.stdout; stderr = error.stderr; code = error.code; }
      expect(code).toBe(fail ? 7 : 0);
      expect(stdout).toBe(fail ? 'pre\nfirst\nsecond\n' : 'pre\nfirst\nsecond\npost\n');
      expect(stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const leaves = rows.filter(row => row.event === 'node-entry' && row.argv[1]?.endsWith('.cjs'))
        .sort((a, b) => a.atMs - b.atMs);
      expect(leaves.map(row => row.argv[1].slice(dir.length + 1))).toEqual(
        fail ? ['pre.cjs', 'first.cjs', 'second.cjs'] : ['pre.cjs', 'first.cjs', 'second.cjs', 'post.cjs']);
      expect(leaves.map(row => row.lifecycle.event)).toEqual(fail ? ['pretest', 'test', 'test'] :
        ['pretest', 'test', 'test', 'posttest']);
      for (const leaf of leaves) {
        const exit = rows.find(row => row.event === 'node-exit' && row.processIdentity === leaf.processIdentity);
        expect(exit).toMatchObject({ code: fail && leaf.argv[1].endsWith('second.cjs') ? 7 : 0 });
        const expected = leaf.argv[1].slice(dir.length + 1).replace('.cjs', '\n');
        expect(exit.streams.stdout).toMatchObject({ scope: 'node-writable-call-inputs',
          byteLength: Buffer.byteLength(expected), captureComplete: true });
        expect(readFileSync(join(`${out}.native-processes`, exit.streams.stdout.ref), 'utf8')).toBe(expected);
        expect(exit.streams.stderr).toMatchObject({ byteLength: 0, captureComplete: true });
      }
      expect(rows.filter(row => row.event === 'child-spawn').map(row => row.lifecycle.script))
        .toEqual(expect.arrayContaining(['node pre.cjs', 'node first.cjs && node second.cjs']));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 25_000);

  it('retains binary and encoded Writable inputs without changing native output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-binary-streams-'));
    const out = join(dir, 'sources.json');
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e',
        "process.stdout.write(Buffer.from([0,255,10])); process.stdout.write('ff00','hex'); process.stderr.write(new Uint8Array([254,13,10])); process.on('exit',()=>process.stdout.write('late'));"], {
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), encoding: 'buffer', timeout: 10_000,
      });
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const exit = rows.find(row => row.event === 'node-exit');
      expect(stdout).toEqual(Buffer.from([0,255,10,255,0,108,97,116,101]));
      expect(stderr).toEqual(Buffer.from([254,13,10]));
      for (const role of ['stdout','stderr']) expect(readFileSync(join(`${out}.native-processes`,
        exit.streams[role].ref))).toEqual(role === 'stdout' ? stdout : stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('delegates write receiver, callback, return and thrown error unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-write-contract-'));
    const out = join(dir, 'sources.json');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?native-write-contract', import.meta.url).href;
    try {
      const source = `const native = process.stdout.write; const callback = () => {}; const error = new Error('original');
        const calls = []; process.stdout.write = function(...args) {
          calls.push({receiver:this === process.stdout, chunk:args[0], encoding:args[1], callback:args[2] === callback});
          if (args[0] === 'throw') throw error; return false;
        };
        process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        const returned = process.stdout.write('accepted','utf8',callback) === false;
        process.stdout.write.call({},'other','utf8',callback);
        let sameError = false; try { process.stdout.write('throw','utf8',callback); } catch (caught) { sameError = caught === error; }
        native.call(process.stdout,JSON.stringify({returned,sameError,calls}));`;
      const env: Record<string, string> = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' } as Record<string, string>;
      delete env.PC_EXECUTED_SOURCE_MAP_OUT;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
        env, timeout: 10_000,
      });
      expect(JSON.parse(stdout)).toEqual({ returned: true, sameError: true, calls: [
        {receiver:true,chunk:'accepted',encoding:'utf8',callback:true},
        {receiver:false,chunk:'other',encoding:'utf8',callback:true},
        {receiver:true,chunk:'throw',encoding:'utf8',callback:true},
      ] });
      const exits = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8'))).filter(row => row.event === 'node-exit');
      expect(exits).toHaveLength(1);
      expect(readFileSync(join(`${out}.native-processes`, exits[0].streams.stdout.ref), 'utf8')).toBe('accepted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('marks the stream bound explicitly while leaving the full native write intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-write-bound-'));
    const out = join(dir, 'sources.json');
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['-e',
        'process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 65));'], {
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 10_000,
      });
      expect(stdout.length).toBe(16 * 1024 * 1024 + 1);
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const pin = rows.find(row => row.event === 'node-exit').streams.stdout;
      expect(pin).toMatchObject({ captureComplete: false, observedByteLength: stdout.length, byteLength: 16 * 1024 * 1024 });
      // Compare bytes directly: generic deep equality enumerates a 16 MiB Buffer
      // as millions of properties and can exhaust the test's own deadline.
      expect(readFileSync(join(`${out}.native-processes`, pin.ref)).equals(stdout.subarray(0, pin.byteLength))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps native output and exit status when the evidence directory is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-process-unavailable-'));
    const out = join(dir, 'sources.json');
    writeFileSync(`${out}.native-processes`, 'not a directory');
    try {
      const env = nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        PAPERCUSP_TEST_STARTUP_TRACE: '0' });
      const result = await promisify(execFile)(process.execPath, ['-e',
        "process.stdout.write('native stdout'); process.stderr.write('native stderr');"], {
        env, timeout: 10_000,
      });
      expect(result).toMatchObject({ stdout: 'native stdout', stderr: 'native stderr' });
      expect(readFileSync(`${out}.native-processes`, 'utf8')).toBe('not a directory');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains diagnostics by default and preserves inherited options without exposing values', () => {
    const env = { NODE_OPTIONS: '--import=https://secret:password@example.test/private --require=/private/key' };
    const enabled = startupTraceEnv(env);
    expect(enabled.PAPERCUSP_TEST_STARTUP_TRACE).toBe('1');
    expect(enabled.NODE_OPTIONS).toContain(env.NODE_OPTIONS);
    expect(enabled.NODE_OPTIONS).toContain('vitest-startup-trace.mjs');
    expect(startupTraceEnv(enabled).NODE_OPTIONS).toBe(enabled.NODE_OPTIONS);
    const disabled = { ...env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    expect(startupTraceEnv(disabled)).toBe(disabled);
    const identity = loaderIdentity(env.NODE_OPTIONS);
    expect(identity.switches).toEqual(['--import', '--require']);
    expect(identity.sha256).toHaveLength(64);
    expect(JSON.stringify(identity)).not.toMatch(/secret|password|private|example/);
  });

  it('leaves ordinary inherited Node children and grandchildren output untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-ordinary-child-'));
    const ordinary = join(dir, 'ordinary.cjs');
    const leaf = "process.stdout.write('abc'); process.stderr.write('xyz');";
    writeFileSync(ordinary, leaf);
    const branch = `const { spawnSync } = require('node:child_process');
      const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(leaf)}], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ stdout: child.stdout, stderr: child.stderr, status: child.status }));`;
    const root = `const { spawnSync } = require('node:child_process');
      const direct = spawnSync(process.execPath, [${JSON.stringify(ordinary)}], { encoding: 'utf8' });
      const branch = spawnSync(process.execPath, ['-e', ${JSON.stringify(branch)}], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({
        direct: { stdout: direct.stdout, stderr: direct.stderr, status: direct.status },
        nested: JSON.parse(branch.stdout), branchStderr: branch.stderr, branchStatus: branch.status,
      }));`;
    const env = startupTraceEnv({ ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: undefined });
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', root], { env, timeout: 10_000 });
      expect(JSON.parse(stdout)).toEqual({
        direct: { stdout: 'abc', stderr: 'xyz', status: 0 },
        nested: { stdout: 'abc', stderr: 'xyz', status: 0 },
        branchStderr: '', branchStatus: 0,
      });
      expect(stderr).toContain('TEST_FILE_STARTUP_TRACE ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures the real preload and fork handshake without an opt-in switch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-startup-preload-'));
    const worker = join(dir, 'vitest', 'dist', 'workers', 'forks.js');
    mkdirSync(join(dir, 'vitest', 'dist', 'workers'), { recursive: true });
    const parent = join(dir, 'parent.cjs');
    writeFileSync(worker, `process.on('message', message => {
      if (message.type === 'start') process.send({ type: 'started' });
      if (message.type === 'stop') process.send({ type: 'stopped' }, () => process.disconnect());
    });`);
    writeFileSync(parent, `const { fork } = require('node:child_process');
      const child = fork(${JSON.stringify(worker)}, { execArgv: [] });
      child.on('message', message => {
        if (message.type === 'started') child.send({ type: 'stop' });
      });
      child.send({ type: 'start', config: { secret: 'never-log' } });`);
    try {
      const env = startupTraceEnv({ ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: undefined });
      const { stderr } = await promisify(execFile)(process.execPath, [parent], { env, timeout: 10_000 });
      const rows = stderr.split('\n').filter(line => line.startsWith('TEST_FILE_STARTUP_TRACE '))
        .map(line => JSON.parse(line.slice('TEST_FILE_STARTUP_TRACE '.length)));
      expect(rows.map(row => row.event)).toEqual(expect.arrayContaining([
        'node-loaded', 'worker-forked', 'start-sent', 'started-received',
        'stop-sent', 'stopped-received', 'worker-exit', 'worker-close',
      ]));
      const workerPid = rows.find(row => row.event === 'worker-forked')?.childPid;
      expect(rows.filter(row => row.event === 'node-loaded')).toHaveLength(2);
      expect(rows.some(row => row.event === 'node-loaded' && row.pid === workerPid)).toBe(true);
      expect(rows.find(row => row.event === 'started-received')).toMatchObject({ error: false });
      expect(stderr).not.toContain('never-log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('observes the real start/started exchange without changing send semantics', () => {
    const child = new EventEmitter() as any;
    child.pid = 42;
    const calls: unknown[] = [];
    const rows: any[] = [];
    let clock = 100;
    const original = child.send = function(...args: unknown[]) { calls.push(args); return false; };
    observeForkStartup(child, row => rows.push(row), () => clock);
    const payload = { type: 'start', config: { secret: 'never-log' } };
    expect(child.send(payload, 'callback-placeholder')).toBe(false);
    clock = 279;
    child.emit('message', { type: 'rpc', secret: 'never-log' });
    child.emit('message', { type: 'started', error: null });
    child.emit('message', { type: 'started', error: null });
    child.emit('exit', 0, null);
    child.emit('close');
    expect(calls).toEqual([[payload, 'callback-placeholder']]);
    expect(rows.map(row => row.event)).toEqual(['start-sent', 'started-received', 'worker-exit', 'worker-close']);
    expect(rows[1]).toMatchObject({ childPid: 42, startupMs: 179, error: false });
    expect(rows.every(row => row.childPid === 42)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('never-log');
    expect(child.send).toBe(original);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('reports a worker exit before the handshake and cleans up idempotently', () => {
    const child = new EventEmitter() as any;
    child.pid = 43;
    child.send = () => true;
    const rows: any[] = [];
    const stop = observeForkStartup(child, row => rows.push(row), () => 0);
    child.emit('exit', 1, null);
    expect(rows).toEqual([{ event: 'worker-exit', childPid: 43, elapsedMs: 0, code: 1, signal: null, started: false }]);
    stop(); stop();
    expect(child.eventNames()).toEqual([]);
  });

  it('distinguishes an unacknowledged stop from an acknowledged stop awaiting process exit', () => {
    const child = new EventEmitter() as any;
    child.pid = 44;
    const payloads: unknown[] = [];
    const signals: unknown[] = [];
    const originalSend = child.send = (payload: unknown) => { payloads.push(payload); return false; };
    const originalKill = child.kill = (signal: unknown) => { signals.push(signal); return true; };
    const rows: any[] = [];
    let clock = 0;
    const detach = observeForkStartup(child, row => rows.push(row), () => clock);
    const payload = { type: 'stop', otelCarrier: { secret: 'never-log' } };
    expect(child.send(payload)).toBe(false);
    expect(rows.map(row => row.event)).toEqual(['stop-sent']);
    clock = 37;
    child.emit('message', { type: 'stopped', error: { secret: 'never-log' } });
    child.emit('message', { type: 'stopped' });
    expect(rows[1]).toMatchObject({ event: 'stopped-received', stopMs: 37, error: true });
    expect(rows.some(row => row.event === 'worker-exit')).toBe(false);
    expect(child.kill('SIGTERM')).toBe(true);
    expect(signals).toEqual(['SIGTERM']);
    expect(payloads).toEqual([payload]);
    expect(rows[2]).toMatchObject({ event: 'worker-signal', signal: 'SIGTERM', sent: true });
    expect(JSON.stringify(rows)).not.toContain('never-log');
    detach();
    expect(child.send).toBe(originalSend);
    expect(child.kill).toBe(originalKill);
    expect(child.eventNames()).toEqual([]);
  });

  it('keeps IPC and termination semantics when diagnostic output throws', () => {
    const child = new EventEmitter() as any;
    child.send = () => false;
    child.kill = () => true;
    const detach = observeForkStartup(child, () => { throw new Error('unavailable output'); });
    expect(child.send({ type: 'stop' })).toBe(false);
    expect(() => child.emit('message', { type: 'stopped' })).not.toThrow();
    expect(child.kill()).toBe(true);
    detach();
  });

  it('captures the stop acknowledgement, IPC disconnect, exit and close of a real fork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-lifecycle-'));
    const fixture = join(dir, 'worker.cjs');
    writeFileSync(fixture, `process.on('message', message => {
      if (message.type === 'stop') process.send({ type: 'stopped' }, () => process.disconnect());
    });`);
    const child = fork(fixture, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const rows: any[] = [];
    observeForkStartup(child, row => rows.push(row));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
        child.send({ type: 'stop' });
      });
      expect(rows.map(row => row.event)).toEqual([
        'stop-sent', 'stopped-received', 'worker-disconnect', 'worker-exit', 'worker-close',
      ]);
      expect(rows[1]).toMatchObject({ error: false });
    } finally {
      if (child.exitCode === null) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
