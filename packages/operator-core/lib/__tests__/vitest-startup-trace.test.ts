import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTextCollector } from '../child-output';
import { loaderIdentity, nativeProcessTraceEnv, observeForkStartup, startupTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';
import { readPartialNativeChannelCustody, readPartialNativeCompletion,
  registerPartialNativeProducerChannels } from '../../../../scripts/lib/partial-task-resume.mjs';
import { writeRelatedFilterList } from '../../../../scripts/lib/related-tests.mjs';

describe('focused runner startup tracing', () => {
  it('predicts the exact native preload environment before OUT allocation without fabricating a channel', () => {
    const plain = { NODE_OPTIONS: '--stack-trace-limit=30' };
    const predicted = nativeProcessTraceEnv(plain, { enabled: true });
    const actual = nativeProcessTraceEnv({ ...plain, PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/native.json' });
    expect(predicted.NODE_OPTIONS).toBe(actual.NODE_OPTIONS);
    expect(predicted.PC_EXECUTED_SOURCE_MAP_OUT).toBeUndefined();
    expect(nativeProcessTraceEnv(predicted, { enabled: true }).NODE_OPTIONS).toBe(predicted.NODE_OPTIONS);
    expect(nativeProcessTraceEnv(plain, { enabled: false })).toBe(plain);
  });

  it.each(['chain', 'simple'].flatMap(route => [0, 7].map(guardExit => ({ route, guardExit }))))(
    'runs an original empty native step without enrolling a producer and preserves owed guard exit $guardExit via $route', async ({ route, guardExit }) => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'native-banked-step-')), out = join(dir, 'out.json');
    const command = 'vitest run --passWithNoTests --config vitest.config.mjs --configLoader native';
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_CHECKPOINT_', 'PAPERCUSP_MUTATION_', 'AFFECTED_']
        .some(prefix => key.startsWith(prefix))) env[key] = value;
    }
    try {
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'banked-step-fixture', scripts: {
        ...(route === 'chain' ? { test: 'npm run first && npm run owed', first: command, owed: 'node owed.cjs' }
          : { test: command, posttest: 'node owed.cjs' }),
      } }));
      writeFileSync(join(dir, 'vitest.config.mjs'),
        `import {defineVitestConfig} from ${JSON.stringify(pathToFileURL(join(root, 'libs/test-config/src/vitest-config.ts')).href)};\n` +
        `export default defineVitestConfig({layer:'unit',include:['**/*.test.ts']});\n`);
      writeFileSync(join(dir, 'a.test.ts'), "throw new Error('banked file executed again');\n");
      writeFileSync(join(dir, 'owed.cjs'), `console.log('OWED_GUARD');process.exit(${guardExit});\n`);
      const source = readFileSync(join(root, 'scripts/affected-tests.mjs'), 'utf8');
      const begin = source.indexOf('  const relatedFilterList =');
      const end = source.indexOf('  // P-008 (gate-file-level-test-reuse', begin);
      expect(begin).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(begin);
      const filter = new Function('extraArgs', 'spawnTask', 'RUN_LOG_ROOT', 'writeRelatedFilterList',
        `${source.slice(begin, end)}\nreturn relatedFilterList;`)([],
      { relatedFiles: [], qualificationSelection: {} }, dir, writeRelatedFilterList);
      expect(JSON.parse(readFileSync(filter.path, 'utf8'))).toEqual([]);
      const traced = nativeProcessTraceEnv({ ...env, PC_TEST_FILTER_LIST: filter.path,
        PC_EXECUTED_SOURCE_MAP_OUT: out, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
        PAPERCUSP_TEST_STARTUP_TRACE: '0' });
      const registered = route === 'chain' ? registerPartialNativeProducerChannels(out, { status: 'ready', channels: [{
        taskKey: 'ws :: test:step:0', script: 'first', command, step: 0, outPath: `${out}.step-0`,
        selectedSpecifications: [], bankedSpecifications: [{ testFile: 'a.test.ts', pool: 'forks',
          projectName: null, testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }],
      }] }, { attemptId: 'attempt', runGroupId: 'group', root: dir, workspaceName: 'ws',
        sourceCommit: 'a'.repeat(40), registeredAtMs: Date.now(),
        command: { cmd: 'npm', argv: ['run', '--silent', 'test'], cwd: dir } }, traced) : null;
      if (registered) expect(registered.producers).toEqual([]);
      const result = await promisify(execFile)('npm', ['run', '--silent', 'test'], {
        cwd: dir, env: traced, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      }).then(value => ({ ...value, code: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
      expect(result.code, result.stderr).toBe(guardExit);
      expect(result.stdout).toContain('OWED_GUARD');
      expect(result.stdout + result.stderr).not.toContain('banked file executed again');
      expect(existsSync(`${out}.producer.json`)).toBe(false);
      expect(existsSync(`${out}.step-0.producer.json`)).toBe(false);
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      if (route === 'chain') expect(rows.find(row => row.event === 'child-spawn' && row.nativeChannel))
        .toMatchObject({ argv: ['-c', command], nativeChannel: { step: 0, command } });
      else {
        expect(rows.find(row => row.event === 'child-spawn' && row.lifecycle?.event === 'test' &&
          ['sh', '/bin/sh'].includes(row.command)))
          .toMatchObject({ argv: ['-c', command] });
        expect(rows.some(row => row.nativeChannel)).toBe(false);
      }
      const owed = rows.find(row => row.event === 'child-spawn' && row.lifecycle?.event === (route === 'chain' ? 'owed' : 'posttest'));
      expect(owed).toBeDefined();
      expect(rows.find(row => row.event === 'child-close' && row.childIdentity === owed.childIdentity))
        .toMatchObject({ code: guardExit, signal: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  it('binds an actual native Vitest reporter through the original npm channel before reading outcomes', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const fixture = join(root, 'libs/test-config/src/__fixtures__/armed-capture');
    const config = join(fixture, 'vitest.config.ts');
    const dir = mkdtempSync(join(tmpdir(), 'native-reporter-channel-')), out = join(dir, 'out.json');
    let completed = false;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_CHECKPOINT_', 'PAPERCUSP_MUTATION_', 'AFFECTED_']
        .some(prefix => key.startsWith(prefix))) env[key] = value;
    }
    try {
      const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
      const discovery = execFileSync(process.execPath, [join(root, 'scripts/resolve-vitest-config-contracts.mjs')], {
        cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
        input: JSON.stringify({ requests: [{ root: fixture, repositoryRoot: root, config,
          enumerateFiles: true, enumerateSpecifications: true }] }),
      });
      const marker = 'PC_VITEST_CONFIG_CONTRACTS=';
      const line = discovery.split(/\r?\n/).find(value => value.startsWith(marker));
      const selected = JSON.parse(line!.slice(marker.length)).results[0];
      expect(selected.ok, discovery).toBe(true);
      expect(selected.selectedSpecifications).toHaveLength(1);
      Object.assign(env, {
        PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/native-channel-fixture',
        PC_EXECUTED_SOURCE_MAP_OUT: out, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
        PC_EXECUTED_INPUTS_DIR: join(dir, 'inputs'), PAPERCUSP_TEST_RUN_GROUP: 'native-channel-run',
        PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID: 'native-channel-attempt',
        PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/native-channel-fixture',
        PAPERCUSP_TEST_STARTUP_TRACE: '0',
      });
      const traced = nativeProcessTraceEnv(env);
      const command = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')).scripts.native;
      const enrollment = registerPartialNativeProducerChannels(out, { status: 'ready', channels: [{
        taskKey: 'fixture :: test:step:0', script: 'native', command, step: 0, outPath: `${out}.step-0`,
        selectedSpecifications: selected.selectedSpecifications,
      }] }, { attemptId: 'native-channel-attempt', runGroupId: 'native-channel-run', root,
        workspaceName: '@papercusp/native-channel-fixture', sourceCommit: candidate, registeredAtMs: Date.now(),
        command: { cmd: 'npm', argv: ['run', '--silent', 'test'], cwd: fixture } }, traced);
      await promisify(execFile)('npm', ['run', '--silent', 'test'], {
        cwd: fixture, env: traced, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      });
      const { producer, path } = enrollment.producers[0]!;
      const snapshot = JSON.parse(readFileSync(producer.outPath, 'utf8'));
      const custody = readPartialNativeChannelCustody(producer, snapshot.nativeRun);
      expect(custody, JSON.stringify(custody)).toMatchObject({ status: 'bound',
        custody: { terminal: true, reporterPid: snapshot.nativeRun.pid } });
      const expected = { attemptId: producer.attemptId, root, taskKey: producer.taskKey,
        workspaceName: producer.workspaceName, producerPath: path,
        selectedSpecifications: selected.selectedSpecifications, manifest: { schemaVersion: 1,
          units: selected.selectedSpecifications.map((spec: any) => ({
            id: `test:${spec.testFile}`, kind: 'test', path: spec.testFile })) } };
      const read = () => readPartialNativeCompletion(producer.outPath, expected, {
        requireTerminal: true, classifyReadPaths: () => ({ readPaths: [], opaqueReasons: [] }),
      });
      const completion = read();
      // A shared, unpinned install deliberately has no reusable runtime identity.
      // Physical custody still binds, but cannot supply that independent proof.
      if (snapshot.completionCheckpoint.runnerIdentity === null) {
        expect(snapshot.rows[0].opaqueReasons).toContain('worker-runtime-unavailable');
        expect(completion, JSON.stringify(completion)).toMatchObject({ status: 'refused',
          reason: 'snapshot-identity-mismatch', receipts: [], currentEvidence: [] });
      } else {
        expect(completion, JSON.stringify(completion)).toMatchObject({ status: 'ready',
          origin: { terminal: 'passed' }, receipts: [expect.objectContaining({ state: 'pass' })] });
      }
      const { completionIntegrity: _missingSeal, ...missingIdentity } = snapshot;
      missingIdentity.completionCheckpoint = { ...missingIdentity.completionCheckpoint, runnerIdentity: null };
      writeFileSync(producer.outPath, JSON.stringify({ ...missingIdentity, completionIntegrity: { schemaVersion: 1,
        sha256: createHash('sha256').update(JSON.stringify(missingIdentity)).digest('hex') } }));
      expect(read()).toMatchObject({ status: 'refused', reason: 'snapshot-identity-mismatch',
        receipts: [], currentEvidence: [] });
      const { completionIntegrity: _seal, ...foreign } = snapshot;
      foreign.nativeRun.pid += 10_000_000;
      expect(readPartialNativeChannelCustody(producer, foreign.nativeRun)).toMatchObject({ status: 'refused' });
      writeFileSync(producer.outPath, JSON.stringify({ ...foreign, completionIntegrity: { schemaVersion: 1,
        sha256: createHash('sha256').update(JSON.stringify(foreign)).digest('hex') } }));
      expect(read()).toMatchObject({ status: 'refused', receipts: [] });
      completed = true;
    } finally {
      if (completed) rmSync(dir, { recursive: true, force: true });
      else process.stderr.write(`[native-reporter-channel] retained failure evidence: ${dir}\n`);
    }
  }, 180_000);

  it.each(['clean', 'corrupt-plan', 'changed-script', 'claimed-channel'])(
    'binds original npm occurrences to distinct reporter channels, %s', async fault => {
      const dir = mkdtempSync(join(tmpdir(), 'native-npm-channels-'));
      const out = join(dir, 'sources.json');
      const command = 'node leaf.cjs';
      const scripts = { test: 'npm run first && npm run second && npm run first',
        first: command, second: command };
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'channel-fixture', scripts }));
      writeFileSync(join(dir, 'leaf.cjs'), `const fs = require('node:fs');
        const startedAtMs = Date.now(); console.log(process.env.PC_EXECUTED_SOURCE_MAP_OUT);
        fs.writeFileSync(process.env.PC_EXECUTED_SOURCE_MAP_OUT, JSON.stringify({
          schemaVersion: 'native-vitest-run-v1', scope: 'vitest-reporter-callbacks',
          pid: process.pid, ppid: process.ppid, startedAtMs, finishedAtMs: Date.now(),
          terminalHook: 'onTestRunEnd', reason: 'passed', unhandledErrorCount: 0,
          modulePopulationMatched: true, gaps: [], files: [] }));`);
      const env = nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        PAPERCUSP_TEST_STARTUP_TRACE: '0' });
      const channels = ['first', 'second', 'first'].map((script, step) => ({
        taskKey: `ws :: test:step:${step}`, script, command, step, outPath: `${out}.step-${step}`,
        selectedSpecifications: [{ testFile: `file-${step}.test.ts`, pool: 'forks', projectName: null,
          testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }],
      }));
      try {
        const enrolled = registerPartialNativeProducerChannels(out, { status: 'ready', channels }, {
          attemptId: 'attempt', runGroupId: 'group', root: dir, workspaceName: 'ws',
          sourceCommit: 'a'.repeat(40), registeredAtMs: Date.now(),
          command: { cmd: 'npm', argv: ['run', '--silent', 'test'], cwd: dir },
        }, env);
        expect(enrolled.operationalAcceptance).toBe(false);
        if (fault === 'corrupt-plan') writeFileSync(enrolled.path, '{}');
        if (fault === 'changed-script') {
          scripts.first += ' # changed';
          writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'channel-fixture', scripts }));
        }
        if (fault === 'claimed-channel') writeFileSync(`${out}.step-0.binding.json`, 'earlier-claim');
        const { stdout, stderr } = await promisify(execFile)('npm', ['run', '--silent', 'test'],
          { cwd: dir, env, timeout: 20_000 });
        const expected = fault === 'clean' ? channels.map(channel => channel.outPath) :
          fault === 'corrupt-plan' ? [out, out, out] :
          fault === 'changed-script' ? [out, channels[1]!.outPath, out] :
          [out, channels[1]!.outPath, out];
        expect(stdout.trim().split('\n')).toEqual(expected);
        expect(stderr).toBe('');
        const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json'))
          .map(name => JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
        const leaves = rows.filter(row => row.event === 'node-entry' && row.argv[1]?.endsWith('leaf.cjs'));
        expect(leaves).toHaveLength(3);
        expect(leaves.map(row => row.reporterOut).sort()).toEqual([...expected].sort());
        const routed = rows.filter(row => row.event === 'child-spawn' && row.nativeChannel);
        expect(routed).toHaveLength(fault === 'clean' ? 3 : fault === 'corrupt-plan' ? 0 : 1);
        for (const spawn of routed) {
          const binding = JSON.parse(readFileSync(`${spawn.nativeChannel.outPath}.binding.json`, 'utf8'));
          expect(binding).toMatchObject({ childIdentity: spawn.childIdentity,
            processIdentity: spawn.processIdentity, parentPid: spawn.pid });
          expect(rows.find(row => row.event === 'child-close' && row.childIdentity === spawn.childIdentity))
            .toMatchObject({ code: 0, signal: null, childPid: spawn.childPid });
          expect(leaves.some(row => row.reporterOut === binding.outPath &&
            (row.ppid === spawn.childPid || row.pid === spawn.childPid))).toBe(true);
        }
        if (fault === 'claimed-channel')
          expect(readFileSync(`${out}.step-0.binding.json`, 'utf8')).toBe('earlier-claim');
        if (fault === 'clean') {
          for (const { producer } of enrolled.producers) {
            const native = JSON.parse(readFileSync(producer.outPath, 'utf8'));
            expect(readPartialNativeChannelCustody(producer, native)).toMatchObject({ status: 'bound',
              custody: { reporterPid: native.pid, terminal: true } });
          }
          const producer = enrolled.producers[0]!.producer;
          const native = JSON.parse(readFileSync(producer.outPath, 'utf8'));
          const read = () => readPartialNativeChannelCustody(producer, native);
          const editEvent = (event: any, mutate: (row: any) => void) => {
            const original = Buffer.from(JSON.stringify(event));
            const file = join(`${out}.native-processes`, `${createHash('sha256').update(original).digest('hex')}.json`);
            const changed = structuredClone(event); mutate(changed);
            const bytes = Buffer.from(JSON.stringify(changed));
            const replacement = join(`${out}.native-processes`, `${createHash('sha256').update(bytes).digest('hex')}.json`);
            rmSync(file); writeFileSync(replacement, bytes);
            try { expect(read().status).toBe('refused'); }
            finally { rmSync(replacement); writeFileSync(file, original); }
          };
          const spawn = routed.find(row => row.nativeChannel.outPath === producer.outPath)!;
          const close = rows.find(row => row.event === 'child-close' && row.childIdentity === spawn.childIdentity)!;
          const entry = leaves.find(row => row.pid === native.pid)!;
          const exit = rows.find(row => row.event === 'node-exit' && row.pid === native.pid)!;
          editEvent(spawn, row => { row.argv[1] += ' # foreign'; });
          editEvent(spawn, row => { row.nativeChannel.step++; });
          editEvent(close, row => { row.signal = 'SIGTERM'; row.code = null; });
          editEvent(close, row => { row.atMs = native.startedAtMs - 1; });
          editEvent(entry, row => { row.reporterOut = out; });
          editEvent(entry, row => { row.ppid = 1; row.pid = 1; });
          editEvent(exit, row => { row.streams.stdout.captureComplete = false; });
          editEvent(exit, row => { row.exitListenersComplete = false; });
          const stream = join(`${out}.native-processes`, exit.streams.stdout.ref);
          const bytes = readFileSync(stream);
          writeFileSync(stream, Buffer.alloc(bytes.length, 120));
          expect(read().status).toBe('refused');
          writeFileSync(stream, bytes);
          const bindingPath = `${producer.outPath}.binding.json`, binding = readFileSync(bindingPath);
          writeFileSync(bindingPath, '{}');
          expect(read().status).toBe('refused');
          writeFileSync(bindingPath, binding);
          expect(readPartialNativeChannelCustody(producer, { ...native, pid: native.pid + 10_000_000 }).status).toBe('refused');
          expect(readPartialNativeChannelCustody({ ...producer,
            command: { ...producer.command, argv: ['run', 'foreign'] } }, native).status).toBe('refused');
          expect(read().status).toBe('bound');
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);

  it.each(['event', 'stream'])('never publishes partial %s artifacts when killed after opening the output', async kind => {
    const dir = mkdtempSync(join(tmpdir(), 'native-interrupted-write-'));
    const out = join(dir, 'sources.json');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?interrupted-write', import.meta.url).href;
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    const source = `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFileSync;
      fs.writeFileSync = function(path, bytes, ...args) {
        const content = Buffer.from(bytes).toString();
        if (String(path).startsWith(${JSON.stringify(out + '.native-processes')}) &&
            (${JSON.stringify(kind)} === 'event' ? content.startsWith('{') : content === 'fixture-body')) {
          fs.closeSync(fs.openSync(path, 'wx'));
          process.stdout.write('NATIVE_WRITE_OPEN');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return write.call(this, path, bytes, ...args);
      };
      syncBuiltinESMExports();
      process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
      await import(${JSON.stringify(preload)});
      process.stdout.write('fixture-body');`;
    try {
      let entered = false, output = '';
      await new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, ['--input-type=module', '-e', source],
          { env, timeout: 10_000, killSignal: 'SIGKILL' }, error => {
            if (entered && error?.signal === 'SIGKILL') resolve();
            else reject(error ?? new Error('interrupted writer unexpectedly returned'));
          });
        createTextCollector(child.stdout, { retainText: false, onDecodedText: text => {
          output += text;
          if (output.includes('NATIVE_WRITE_OPEN')) { entered = true; child.kill('SIGKILL'); }
        } });
      });
      expect(entered).toBe(true);
      const names = readdirSync(`${out}.native-processes`);
      if (kind === 'stream') expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const bytes = readFileSync(join(`${out}.native-processes`, name));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(name.split('.')[0]);
        if (name.endsWith('.json')) expect(JSON.parse(bytes.toString())).toHaveProperty('schemaVersion', 1);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('arms native observation only on the existing OUT channel, without changing stderr trace mode', () => {
    const plain = { NODE_OPTIONS: '--conditions=test' };
    expect(nativeProcessTraceEnv(plain)).toBe(plain);
    const armed = nativeProcessTraceEnv({ ...plain, PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/native.json' });
    expect(armed.NODE_OPTIONS).toContain(plain.NODE_OPTIONS);
    expect(armed.PAPERCUSP_TEST_STARTUP_TRACE).toBeUndefined();
    expect(nativeProcessTraceEnv(armed).NODE_OPTIONS).toBe(armed.NODE_OPTIONS);
  });

  it('distinguishes worker threads from process entries while retaining thread source bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-thread-source-'));
    const out = join(dir, 'sources.json');
    const worker = join(dir, 'worker.mjs'), main = join(dir, 'main.mjs');
    const source = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('loaded');";
    writeFileSync(worker, source);
    writeFileSync(main, `import { Worker } from 'node:worker_threads';
      const worker = new Worker(new URL('./worker.mjs', import.meta.url));
      worker.once('error', error => { throw error; });
      worker.once('message', value => { if (value !== 'loaded') process.exitCode = 1; });`);
    try {
      await promisify(execFile)(process.execPath, [main], {
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), timeout: 30_000,
      });
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const entries = rows.filter(row => row.event === 'node-entry');
      const processes = entries.filter(row => row.threadId === 0);
      const threads = entries.filter(row => row.threadId > 0);
      expect(processes).toHaveLength(1);
      expect(threads).toHaveLength(1);
      expect(threads[0].pid).toBe(processes[0].pid);
      expect(threads[0].processIdentity).not.toBe(processes[0].processIdentity);
      const loaded = rows.find(row => row.event === 'module-load-return' && row.url === pathToFileURL(worker).href);
      expect(loaded).toMatchObject({ threadId: threads[0].threadId, processIdentity: threads[0].processIdentity,
        source: { status: 'hashed', sha256: createHash('sha256').update(source).digest('hex') } });
      expect(readFileSync(join(`${out}.native-processes`, loaded.source.ref), 'utf8')).toBe(source);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 45_000);

  it.each(['string', 'view', 'array-buffer'])('fingerprints returned %s source and preserves a delegated loader error object', async representation => {
    const dir = mkdtempSync(join(tmpdir(), 'native-module-load-'));
    const out = join(dir, 'sources.json');
    const good = pathToFileURL(join(dir, 'good.mjs')).href;
    const bad = pathToFileURL(join(dir, 'bad.mjs')).href;
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?module-load-contract', import.meta.url).href;
    const returnedSource = 'export const value = 42; // λ';
    writeFileSync(join(dir, 'good.mjs'), 'export const value = -1;');
    writeFileSync(join(dir, 'bad.mjs'), 'export const unreachable = true;');
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    try {
      const source = `import { registerHooks } from 'node:module';
        const expected = Object.assign(new Error('fixture loader error'), {code:'FIXTURE_LOAD'});
        registerHooks({load(url, context, nextLoad) {
          if (url === ${JSON.stringify(bad)}) throw expected;
          if (url === ${JSON.stringify(good)}) {
            const source = ${JSON.stringify(returnedSource)};
            const padded = Buffer.from('padding' + source + 'suffix');
            return { ...nextLoad(url, context), source:
              ${JSON.stringify(representation)} === 'string' ? source :
              ${JSON.stringify(representation)} === 'view' ? padded.subarray(7, padded.length - 6) :
              new TextEncoder().encode(source).buffer };
          }
          return nextLoad(url, context);
        }});
        process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        const { value } = await import(${JSON.stringify(good)});
        let sameError = false;
        try { await import(${JSON.stringify(bad)}); } catch (error) { sameError = error === expected; }
        process.stdout.write(JSON.stringify({value,sameError}));`;
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        ['--input-type=module', '-e', source], { env, timeout: 10_000 });
      expect(JSON.parse(stdout)).toEqual({ value: 42, sameError: true });
      expect(stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const start = rows.find(row => row.event === 'module-load-start' && row.url === good);
      expect(start).toMatchObject({ scope: 'node-sync-load-hook' });
      expect(rows.find(row => row.event === 'module-load-return' && row.url === good))
        .toMatchObject({ loadId: start.loadId, processIdentity: start.processIdentity, format: 'module', elapsedMs: expect.any(Number),
          source: { scope: 'node-loader-returned-source', status: 'hashed',
            byteLength: Buffer.byteLength(returnedSource),
            sha256: createHash('sha256').update(returnedSource).digest('hex') } });
      const pin = rows.find(row => row.event === 'module-load-return' && row.url === good).source;
      expect(pin.ref).toBe(`${pin.sha256}.source`);
      expect(readFileSync(join(`${out}.native-processes`, pin.ref)).equals(Buffer.from(returnedSource))).toBe(true);
      expect(rows.find(row => row.event === 'module-load-error' && row.url === bad))
        .toMatchObject({ errorCode: 'FIXTURE_LOAD', errorName: 'Error' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('bounds per-module and per-process source hashing without changing native loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-module-source-bounds-'));
    const out = join(dir, 'sources.json');
    const urls = Array.from({ length: 6 }, (_, i) => pathToFileURL(join(dir, `${i}.mjs`)).href);
    // Resolution precedes load hooks; these bytes must exist but must not be
    // mistaken for the transformed source returned by the fixture loader.
    for (let i = 0; i < urls.length; i++) writeFileSync(join(dir, `${i}.mjs`), 'export default -1;');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?source-bounds', import.meta.url).href;
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    try {
      const source = `import { registerHooks } from 'node:module';
        const urls = ${JSON.stringify(urls)}, prefix = 'export default 42;';
        const bounded = prefix + '/*' + 'x'.repeat(16 * 1024 * 1024 - prefix.length - 4) + '*/';
        registerHooks({load(url, context, nextLoad) {
          const index = urls.indexOf(url);
          if (index < 0) return nextLoad(url, context);
          return { format:'module', shortCircuit:true,
            source: index === 0 ? bounded + ' ' : index === 5 ? prefix : bounded };
        }});
        process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        const values = [];
        for (const url of urls) values.push((await import(url)).default);
        process.stdout.write(JSON.stringify(values));`;
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        ['--input-type=module', '-e', source], { env, timeout: 15_000 });
      expect(JSON.parse(stdout)).toEqual([42, 42, 42, 42, 42, 42]);
      expect(stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const observations = urls.map(url => rows.find(row => row.event === 'module-load-return' && row.url === url).source);
      expect(observations[0]).toMatchObject({ status: 'limit', limit: 'source-byte-limit' });
      expect(observations.slice(1, 5)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({
        status: 'hashed', byteLength: 16 * 1024 * 1024, sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })));
      expect(observations[5]).toMatchObject({ status: 'limit', limit: 'process-byte-limit' });
      expect(observations.filter(row => row.status === 'limit').every(row => !('sha256' in row))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains the attempted file load when a child blocks before the loader returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-module-stall-'));
    const out = join(dir, 'sources.json');
    const target = pathToFileURL(join(dir, 'blocked.mjs')).href;
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?module-load-stall', import.meta.url).href;
    writeFileSync(join(dir, 'blocked.mjs'), 'export const unreachable = true;');
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    const source = `import { registerHooks } from 'node:module';
      registerHooks({load(url, context, nextLoad) {
        if (url === ${JSON.stringify(target)}) {
          process.stdout.write('LOAD_BLOCKED');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return nextLoad(url, context);
      }});
      process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
      await import(${JSON.stringify(preload)});
      await import(${JSON.stringify(target)});`;
    try {
      let entered = false;
      await new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, ['--input-type=module', '-e', source],
          { env, timeout: 10_000, killSignal: 'SIGKILL' }, error => {
            if (entered && error?.signal === 'SIGKILL') resolve();
            else reject(error ?? new Error('blocked loader unexpectedly returned'));
          });
        child.stdout?.on('data', chunk => {
          if (String(chunk).includes('LOAD_BLOCKED')) { entered = true; child.kill('SIGKILL'); }
        });
      });
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      expect(rows.filter(row => row.event === 'module-load-start' && row.url === target)).toHaveLength(1);
      expect(rows.filter(row => ['module-load-return', 'module-load-error'].includes(row.event) && row.url === target))
        .toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('bounds load evidence while allowing the complete module population to execute', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-module-bound-'));
    const out = join(dir, 'sources.json');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?module-load-bound', import.meta.url).href;
    const modules = Array.from({ length: 140 }, (_, index) => {
      const path = join(dir, `module-${index}.mjs`);
      writeFileSync(path, `export const value = ${index};`);
      return pathToFileURL(path).href;
    });
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    try {
      const source = `process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        let sum = 0;
        for (const url of ${JSON.stringify(modules)}) sum += (await import(url)).value;
        process.stdout.write(String(sum));`;
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        ['--input-type=module', '-e', source], { env, timeout: 10_000 });
      expect(stdout).toBe('9730');
      expect(stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const starts = rows.filter(row => row.event === 'module-load-start');
      expect(starts.length).toBeGreaterThan(0);
      expect(starts.length).toBeLessThanOrEqual(128);
      expect(rows.filter(row => row.event === 'module-load-limit')).toHaveLength(1);
      expect(rows.find(row => row.event === 'node-exit')).toMatchObject({ code: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

  it('records exit entry before a blocked listener without claiming completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-blocked-exit-'));
    const out = join(dir, 'sources.json');
    try {
      let entered = false, output = '';
      await new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, ['-e',
          "process.on('exit', () => { process.stdout.write('EXIT_LISTENER_ENTERED'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }); process.exitCode = 3;"], {
          env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
            PAPERCUSP_TEST_STARTUP_TRACE: '0' }), timeout: 10_000, killSignal: 'SIGKILL',
        }, error => {
          if (entered && error?.signal === 'SIGKILL') resolve();
          else reject(error ?? new Error('blocked exit listener unexpectedly returned'));
        });
        createTextCollector(child.stdout, { retainText: false, onDecodedText: text => {
          output += text;
          if (output.includes('EXIT_LISTENER_ENTERED')) { entered = true; child.kill('SIGKILL'); }
        } });
      });
      expect(entered).toBe(true);
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name => {
        const bytes = readFileSync(join(`${out}.native-processes`, name));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(name.slice(0, 64));
        return JSON.parse(bytes.toString('utf8'));
      });
      const entry = rows.find(row => row.event === 'node-entry');
      expect(rows.filter(row => row.event === 'node-exit-start')).toEqual([
        expect.objectContaining({ pid: entry.pid, processIdentity: entry.processIdentity, code: 3 }),
      ]);
      expect(rows.filter(row => row.event === 'node-exit')).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

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
      const exitStart = rows.find(row => row.event === 'node-exit-start');
      expect(exitStart).toMatchObject({ pid: exit.pid, processIdentity: exit.processIdentity, code: 0 });
      expect(exitStart.atMs).toBeLessThanOrEqual(exit.atMs);
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
