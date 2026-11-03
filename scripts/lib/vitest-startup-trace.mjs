/** Passive, bounded diagnostics for Vitest's real forks lifecycle protocol. */
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';
import { captureConfigurationSnapshot } from '../../libs/test-config/src/configuration-snapshot.ts';
import { readProcessIdentity } from '../../packages/operator-core/lib/process-identity.ts';

export const nativeSourceRetentionLimits = Object.freeze({ sourceBytes: 16 * 1024 ** 2,
  processBytes: 64 * 1024 ** 2, pinnedSourceBytes: 128 * 1024 ** 2,
  pinnedProcessBytes: 256 * 1024 ** 2, pins: 4 });
const sourcePinsEnv = 'PC_NATIVE_LOADER_SOURCE_PINS';
function validateSourcePins(pins) {
  if (!Array.isArray(pins) || pins.length > nativeSourceRetentionLimits.pins ||
      new Set(pins.map(pin => pin?.path)).size !== pins.length || pins.some(pin =>
        typeof pin?.path !== 'string' || !isAbsolute(pin.path) || pin.path.length > 1024 ||
        !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.byteLength) ||
        pin.byteLength < 0 || pin.byteLength > nativeSourceRetentionLimits.pinnedSourceBytes) ||
      pins.reduce((total, pin) => total + pin.byteLength, 0) > nativeSourceRetentionLimits.pinnedProcessBytes)
    throw new Error('Invalid bounded native loader source pins');
  return pins;
}

/** Reuse the OUT channel and this preload without enabling stderr diagnostics.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ enabled?: boolean, pinnedSources?: Array<{ path: string, sha256: string, byteLength: number }> }} [options]
 * Source-owned prediction and independent artifact pins before launch. Generic limits stay unchanged.
 */
export function nativeProcessTraceEnv(env = process.env, options = {}) {
  if (!(options.enabled ?? Boolean(env.PC_EXECUTED_SOURCE_MAP_OUT?.trim()))) return env;
  const preload = `--import=${JSON.stringify(new URL('./vitest-startup-trace.mjs', import.meta.url).href)}`;
  const nodeOptions = env.NODE_OPTIONS ?? '';
  return { ...env, NODE_OPTIONS: nodeOptions.includes(preload) ? nodeOptions : `${nodeOptions} ${preload}`.trim(),
    ...(options.pinnedSources === undefined ? {} : {
      [sourcePinsEnv]: JSON.stringify(validateSourcePins(options.pinnedSources)),
    }) };
}

// These are observations, not a shell parser or a complete execution census.
// Preserve each Node entry/exit and npm's actual exported spawn calls, including
// lifecycle scripts. Missing preloads, shell builtins, signals and private spawn
// implementations remain gaps in the parent receipt. Never alter stdio/options.
function installNativeProcessTrace(out) {
  const identity = randomUUID();
  // A trace channel has its own UUID (including worker threads). The kernel
  // identity independently pins the OS process; neither can stand in for the other.
  const kernelProcessIdentity = readProcessIdentity(process.pid);
  let root;
  try {
    const path = `${out}.native-processes`;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return;
    root = realpathSync(path);
  } catch { return; }
  const lifecycle = env => ({ event: env.npm_lifecycle_event ?? null,
    script: env.npm_lifecycle_script ?? null });
  // An interrupted direct write leaves a final hash-named file empty or partial.
  // Publish completed bytes by a no-replace hard link; interrupted staging files
  // stay outside the trusted event directory and are removed with the run root.
  const publish = (path, bytes) => {
    const temporary = `${root}.pending-${identity}-${randomUUID()}`;
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      try { linkSync(temporary, path); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    } finally {
      try { unlinkSync(temporary); } catch { /* A killed writer may leave only staging evidence. */ }
    }
  };
  let remaining = 512;
  const emit = (event, fields = {}, terminal = false) => {
    if (!terminal && remaining-- < 0) return;
    try {
      let row = { schemaVersion: 1, kind: 'native-node-process-event', event,
        processIdentity: identity, kernelProcessIdentity,
        pid: process.pid, ppid: process.ppid, atMs: Date.now(), ...fields, threadId };
      if (!terminal && remaining === -1) row = { ...row, event: 'trace-limit' };
      let bytes = Buffer.from(JSON.stringify(row));
      if (bytes.length > 128 * 1024) {
        bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: row.kind,
          event: 'trace-event-too-large', processIdentity: identity, kernelProcessIdentity, pid: process.pid,
          ppid: process.ppid, atMs: row.atMs, omittedEvent: event, threadId }));
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const path = join(root, `${sha256}.json`);
      publish(path, bytes);
      // Do not replace redirected or changed evidence on a repeated write.
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() ||
          !readFileSync(path).equals(bytes)) return;
    } catch { /* Observation failures never change the native command. */ }
  };
  // Record inputs accepted by each process's Writable API, without adding data
  // listeners, changing its stdio, or replacing callbacks/return/error values.
  // Direct fd/native writes and inherited child output remain outside this scope.
  const streams = {};
  for (const role of ['stdout', 'stderr']) {
    const stream = process[role], originalWrite = stream.write;
    const state = streams[role] = { chunks: [], observedByteLength: 0, capturedBytes: 0,
      captureComplete: true, sequence: 0 };
    stream.write = function(chunk, ...args) {
      let bytes = null;
      const order = state.sequence++;
      try {
        if (this === stream) bytes = typeof chunk === 'string' ? Buffer.from(chunk,
          typeof args[0] === 'string' ? args[0] : stream._writableState?.defaultEncoding ?? 'utf8') :
          ArrayBuffer.isView(chunk) ? Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)) : null;
      } catch { /* The original write owns validation and errors. */ }
      const result = originalWrite.call(this, chunk, ...args);
      try {
        if (this === stream) {
          if (bytes === null) state.captureComplete = false;
          else {
            state.observedByteLength += bytes.length;
            const available = Math.max(0, 16 * 1024 * 1024 - state.capturedBytes);
            if (bytes.length > available || state.chunks.length >= 16384) state.captureComplete = false;
            if (available > 0 && bytes.length > 0 && state.chunks.length < 16384) {
              const retained = bytes.subarray(0, available);
              state.chunks.push({ order, bytes: retained });
              state.capturedBytes += retained.length;
            }
          }
        }
      } catch { state.captureComplete = false; }
      return result;
    };
  }
  const retainStreams = () => Object.fromEntries(Object.entries(streams).map(([role, state]) => {
    const scope = 'node-writable-call-inputs';
    try {
      const bytes = Buffer.concat(state.chunks.sort((a, b) => a.order - b.order).map(row => row.bytes));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const ref = `${sha256}.stream`, path = join(root, ref);
      publish(path, bytes);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(bytes))
        throw new Error('redirected or changed stream artifact');
      return [role, { scope, ref, sha256, byteLength: bytes.length,
        observedByteLength: state.observedByteLength, captureComplete: state.captureComplete }];
    } catch { return [role, { scope, captureComplete: false, artifactUnavailable: true }]; }
  }));
  try {
    emit('node-entry', { executable: process.execPath, argv: process.argv.slice(),
      execArgv: process.execArgv.slice(), cwd: process.cwd(), lifecycle: lifecycle(process.env),
      nodeOptions: loaderIdentity(process.env.NODE_OPTIONS), reporterOut: process.env.PC_EXECUTED_SOURCE_MAP_OUT ?? null,
      runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
      // Reuse the ledger's hashed configuration-input contract. This is the
      // original process at entry, not resolved config or later mutations.
      configuration: captureConfigurationSnapshot(process.env) });
  } catch { /* Even an unavailable cwd must not prevent the native entry. */ }
  // A preload's exit listener would run before the program's later listeners
  // and silently lose their writes. Delegate the original emission first and
  // retain bytes after its synchronous listeners, preserving its return/throw.
  const originalEmit = process.emit;
  process.emit = function(event, ...args) {
    if (this !== process || event !== 'exit') return originalEmit.call(this, event, ...args);
    // The program's own exit listeners can block. Preserve entry before calling
    // them so a killed process is distinguishable from one that never emitted
    // exit. This does not assert that shutdown or stream retention completed.
    emit('node-exit-start', { code: args[0] }, true);
    let listenersComplete = false;
    try {
      const result = originalEmit.call(this, event, ...args);
      listenersComplete = true;
      return result;
    } finally {
      if (!listenersComplete) for (const state of Object.values(streams)) state.captureComplete = false;
      emit('node-exit', { code: args[0], exitListenersComplete: listenersComplete, streams: retainStreams() }, true);
    }
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(command, ...args) {
    const childIdentity = randomUUID();
    let nativeChannel;
    try {
      const argv = Array.isArray(args[0]) ? args[0] : [];
      const optionsIndex = Array.isArray(args[0]) ? 1 : 0;
      const options = args[optionsIndex] ?? {};
      const env = options.env ?? process.env;
      const plan = readNativeEnrollment(`${out}.native-channels.json`);
      if (plan?.kind === 'qualification-native-channels' && plan.outPath === out &&
          plan.cwd === String(options.cwd ?? process.cwd()) &&
          Array.isArray(plan.channels) && plan.channels.length <= 64 &&
          ['sh', '/bin/sh'].includes(command) && argv.length === 2 && argv[0] === '-c' && !options.shell) {
        for (const channel of plan.channels) {
          if (channel.script !== env.npm_lifecycle_event || channel.command !== env.npm_lifecycle_script ||
              channel.command !== argv[1] || !Number.isSafeInteger(channel.step) || channel.step < 0 ||
              channel.outPath !== `${out}.step-${channel.step}`) continue;
          const claim = { schemaVersion: 1, kind: 'native-channel-binding', traceOut: out,
            outPath: channel.outPath, processIdentity: identity, childIdentity,
            parentPid: process.pid, script: channel.script, command: channel.command, step: channel.step };
          const bytes = Buffer.from(JSON.stringify(claim));
          const path = `${channel.outPath}.binding.json`;
          publish(path, bytes);
          // A repeated invocation takes the next unused matching occurrence.
          if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() ||
              lstatSync(path).size > 16 * 1024) throw new Error('native-channel-binding-unreadable');
          const retained = readFileSync(path);
          if (!retained.equals(bytes)) {
            const previous = JSON.parse(retained.toString('utf8'));
            if (previous.kind !== claim.kind || previous.schemaVersion !== 1 ||
                previous.traceOut !== out || previous.outPath !== channel.outPath ||
                previous.script !== channel.script || previous.command !== channel.command ||
                previous.step !== channel.step || !Number.isSafeInteger(previous.parentPid) ||
                typeof previous.processIdentity !== 'string' || typeof previous.childIdentity !== 'string')
              throw new Error('native-channel-binding-conflict');
            continue;
          }
          nativeChannel = claim;
          args[optionsIndex] = { ...options, env: { ...env, PC_EXECUTED_SOURCE_MAP_OUT: channel.outPath } };
          break;
        }
      }
    } catch {
      emit('native-channel-unavailable', { childIdentity });
      // Observation failures preserve the original command and cannot settle a channel.
    }
    let child;
    try { child = originalSpawn.call(this, command, ...args); }
    catch (error) {
      emit('child-spawn-error', { childIdentity, errorCode: error?.code ?? null });
      throw error;
    }
    try {
      const argv = Array.isArray(args[0]) ? args[0].slice() : [];
      const options = (Array.isArray(args[0]) ? args[1] : args[0]) ?? {};
      emit('child-spawn', { childIdentity, childPid: child.pid ?? null, command, argv,
        cwd: options.cwd == null ? process.cwd() : String(options.cwd),
        shell: options.shell ?? false, lifecycle: lifecycle(options.env ?? process.env),
        stdioAccessible: { stdout: Boolean(child.stdout), stderr: Boolean(child.stderr) },
        ...(nativeChannel ? { nativeChannel } : {}) });
      child.once('close', (code, signal) => emit('child-close', {
        childIdentity, childPid: child.pid ?? null, code, signal }));
    } catch { /* Return the exact native child even if observation fails. */ }
    return child;
  };
  // Synchronous probes bypass spawn's exported wrapper. Retain their call
  // boundary even when a preload never reaches our node-entry observation.
  // An absent child entry remains unknown; only the native result supplies
  // its PID, exit/signal and transport error. Never alter arguments or result.
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function(command, ...args) {
    const childIdentity = randomUUID(), started = performance.now();
    try {
      const argv = Array.isArray(args[0]) ? args[0].slice() : [];
      const options = (Array.isArray(args[0]) ? args[1] : args[0]) ?? {};
      emit('child-spawn-sync-start', { childIdentity, command, argv,
        cwd: options.cwd == null ? process.cwd() : String(options.cwd),
        shell: options.shell ?? false, timeout: options.timeout ?? null,
        lifecycle: lifecycle(options.env ?? process.env) });
    } catch { /* Observation cannot prevent the native call. */ }
    let result;
    try { result = originalSpawnSync.call(this, command, ...args); }
    catch (error) {
      // A diagnostic must not invoke a user error's getter or replace the
      // original exception if inspecting it throws (including a Proxy trap).
      let errorCode = null;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(error ?? {}, 'code');
        if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') errorCode = descriptor.value;
      } catch { /* The native thrown value is still authoritative. */ }
      emit('child-spawn-sync-error', { childIdentity, errorCode,
        elapsedMs: performance.now() - started });
      throw error;
    }
    try {
      emit('child-spawn-sync-return', { childIdentity, childPid: result.pid ?? null,
        code: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
        elapsedMs: performance.now() - started });
    } catch { /* Return the exact native result despite observation failure. */ }
    return result;
  };
  syncBuiltinESMExports();

  // Process entry alone cannot distinguish a loader wait from Vitest startup.
  // A synchronous hook observes the call into the remaining loader chain,
  // including async hooks on Node's loader thread. Persist the attempt before
  // delegation so a killed/stuck child still names its last file boundary.
  // These are load observations, never claims that a module was evaluated.
  let loadSequence = 0;
  const sourceByteLimit = nativeSourceRetentionLimits.sourceBytes;
  const sourceTotalByteLimit = nativeSourceRetentionLimits.processBytes;
  let sourceBytesHashed = 0, pinnedBytesHashed = 0;
  let sourcePins = [];
  try {
    const encoded = process.env[sourcePinsEnv] ?? '[]';
    if (encoded.length > 8192) throw new Error('source pin enrollment too large');
    sourcePins = validateSourcePins(JSON.parse(encoded));
  } catch { emit('module-source-pins-invalid'); }
  // Retain loader-returned bytes in bounded chunks. In particular, do not make
  // another full UTF-8 copy of the product bundle already owned by the loader.
  function* chunks(source) {
    if (typeof source === 'string') {
      for (let offset = 0; offset < source.length;) {
        let end = Math.min(source.length, offset + 16 * 1024);
        if (end < source.length && source.charCodeAt(end - 1) >= 0xd800 &&
            source.charCodeAt(end - 1) <= 0xdbff) end--;
        yield Buffer.from(source.slice(offset, end));
        offset = end;
      }
    } else {
      const bytes = ArrayBuffer.isView(source) ?
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
        yield bytes.subarray(offset, offset + 64 * 1024);
    }
  }
  const fingerprintSource = (result, url) => {
    const observation = { scope: 'node-loader-returned-source', byteLimit: sourceByteLimit,
      totalByteLimit: sourceTotalByteLimit };
    try {
      // Hash the loader's returned bytes, which may differ from the file on disk.
      // Missing source is an explicit gap; never re-read the URL as a substitute.
      const source = result.source, text = typeof source === 'string';
      if (source == null) return { ...observation, status: 'unavailable' };
      const view = ArrayBuffer.isView(source);
      if (!text && !view && !(source instanceof ArrayBuffer))
        return { ...observation, status: 'unsupported' };
      const expected = sourcePins.find(pin => fileURLToPath(url) === pin.path);
      if (expected && expected.byteLength > sourceByteLimit) {
        const pin = { ...observation, admission: 'independently-pinned-large-source-v1',
          byteLimit: nativeSourceRetentionLimits.pinnedSourceBytes,
          totalByteLimit: nativeSourceRetentionLimits.pinnedProcessBytes };
        if ((text ? source.length : source.byteLength) > pin.byteLimit)
          return { ...pin, status: 'limit', limit: 'pinned-source-byte-limit' };
        const byteLength = text ? Buffer.byteLength(source) : source.byteLength;
        if (byteLength > pin.byteLimit || byteLength > pin.totalByteLimit - pinnedBytesHashed)
          return { ...pin, status: 'limit', byteLength, limit: 'pinned-source-byte-limit' };
        pinnedBytesHashed += byteLength; // Failed attempts consume their budget too.
        if (byteLength !== expected.byteLength)
          return { ...pin, status: 'unavailable', reason: 'pinned-source-length-mismatch' };
        const temporary = `${root}.pending-${identity}-${randomUUID()}`;
        let fd;
        try {
          fd = openSync(temporary, 'wx', 0o600);
          const hash = createHash('sha256');
          for (const chunk of chunks(source)) {
            hash.update(chunk);
            for (let offset = 0; offset < chunk.length;)
              offset += writeSync(fd, chunk, offset, chunk.length - offset);
          }
          closeSync(fd); fd = undefined;
          const sha256 = hash.digest('hex');
          if (sha256 !== expected.sha256)
            return { ...pin, status: 'unavailable', reason: 'pinned-source-digest-mismatch' };
          const ref = `${sha256}.source`;
          try { linkSync(temporary, join(root, ref)); }
          catch (error) { if (error?.code !== 'EEXIST') throw error; }
          return { ...pin, status: 'hashed', sha256, byteLength, ref };
        } finally {
          if (fd !== undefined) closeSync(fd);
          try { unlinkSync(temporary); } catch { /* Unfinished captures remain untrusted. */ }
        }
      }
      const remaining = sourceTotalByteLimit - sourceBytesHashed;
      // UTF-8 is at least as long as a string's UTF-16 code-unit count. Bound
      // even the byte-length scan before touching a very large returned string.
      const minimumByteLength = text ? source.length : source.byteLength;
      const limit = minimumByteLength > sourceByteLimit ? 'source-byte-limit' :
        minimumByteLength > remaining ? 'process-byte-limit' : null;
      if (limit) return { ...observation, status: 'limit', limit, minimumByteLength };
      const byteLength = text ? Buffer.byteLength(source) : source.byteLength;
      if (byteLength > sourceByteLimit || byteLength > remaining)
        return { ...observation, status: 'limit', byteLength,
          limit: byteLength > sourceByteLimit ? 'source-byte-limit' : 'process-byte-limit' };
      const bytes = text ? source : view ?
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
      sourceBytesHashed += byteLength; // Failed hashing attempts consume the same budget.
      const pin = { ...observation, status: 'hashed', byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex') };
      // The reader authenticates this reference before archival. A collision
      // never overwrites an existing artifact or changes the native load.
      const ref = `${pin.sha256}.source`;
      try {
        publish(join(root, ref), text ? Buffer.from(source) :
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        return { ...pin, ref };
      } catch { return { ...pin, artifactUnavailable: true }; }
    } catch {
      // Observation must not convert a successful loader return into a failure.
      return { ...observation, status: 'unavailable', reason: 'source-fingerprint-failed' };
    }
  };
  try {
    registerHooks({ load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      if (loadSequence >= 128) {
        if (loadSequence++ === 128) emit('module-load-limit', { limit: 128 });
        return nextLoad(url, context);
      }
      const loadId = ++loadSequence;
      const started = performance.now();
      const fields = { loadId, url, scope: 'node-sync-load-hook' };
      emit('module-load-start', fields);
      try {
        const result = nextLoad(url, context);
        emit('module-load-return', { ...fields, elapsedMs: performance.now() - started,
          format: result.format ?? null, source: fingerprintSource(result, url) });
        return result;
      } catch (error) {
        emit('module-load-error', { ...fields, elapsedMs: performance.now() - started,
          errorCode: typeof error?.code === 'string' ? error.code : null,
          errorName: typeof error?.name === 'string' ? error.name : typeof error });
        throw error;
      }
    } });
  } catch (error) {
    emit('module-load-unavailable', { errorCode: error?.code ?? null });
  }
}

// Channel children keep their reporter output separate while their native
// process observations stay with the original npm tree. The enrollment is
// published before spawn; no race against a parent's post-spawn write is needed.
function readNativeEnrollment(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return null;
    const { integrity, ...value } = JSON.parse(readFileSync(path, 'utf8'));
    return integrity?.schemaVersion === 1 && integrity.sha256 ===
      createHash('sha256').update(JSON.stringify(value)).digest('hex') ? value : null;
  } catch { return null; }
}

if (process.env.PC_EXECUTED_SOURCE_MAP_OUT?.trim()) {
  const reporterOut = process.env.PC_EXECUTED_SOURCE_MAP_OUT.trim();
  const producer = readNativeEnrollment(`${reporterOut}.producer.json`);
  const channel = producer?.nativeChannel;
  const traceOut = producer?.outPath === reporterOut && isAbsolute(channel?.traceOut ?? '') &&
    Number.isSafeInteger(channel.step) && reporterOut === `${channel.traceOut}.step-${channel.step}` &&
    channel.script === process.env.npm_lifecycle_event && channel.command === process.env.npm_lifecycle_script
    ? channel.traceOut : reporterOut;
  installNativeProcessTrace(traceOut);
}

export function loaderIdentity(value = '') {
  const text = String(value);
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    // Never print option values: paths/URLs can contain credentials.
    switches: [...new Set(text.match(/--(?:import|loader|experimental-loader|require|conditions)(?=[=\s]|$)|(?:^|\s)-r(?=[=\s]|$)/g) ?? [])].map(s => s.trim()),
  };
}

export function startupTraceEnv(env = process.env) {
  // A timeout cannot enable a preload retroactively. Keep the bounded lifecycle
  // trace in the router's existing captured stderr unless explicitly disabled.
  if (env.PAPERCUSP_TEST_STARTUP_TRACE === '0') return env;
  const preload = `--import=${JSON.stringify(new URL('./vitest-startup-trace.mjs', import.meta.url).href)}`;
  const options = env.NODE_OPTIONS ?? '';
  return { ...env, PAPERCUSP_TEST_STARTUP_TRACE: '1',
    NODE_OPTIONS: options.includes(preload) ? options : `${options} ${preload}`.trim() };
}

/**
 * @param {any} child - a forked child process (its `send` is wrapped in place).
 * @param {(row: Record<string, unknown>) => void} emit - receives one diagnostic row per startup event.
 * @param {() => number} [now]
 * @returns {() => void} stops observing.
 */
export function observeForkStartup(child, emit, now = () => performance.now()) {
  const origin = now();
  const originalSend = child.send;
  const originalKill = child.kill;
  let closed = false;
  let start = null;
  let stop = null;
  let seenStarted = false;
  let seenStopped = false;
  const record = (event, fields = {}) => {
    try { emit({ event, childPid: child.pid, elapsedMs: Math.round(now() - origin), ...fields }); }
    catch { /* A passive observer must not change the runner's IPC or signals. */ }
  };
  child.send = function(message, ...args) {
    if (message?.type === 'start' && start === null) {
      start = now();
      record('start-sent');
    }
    if (message?.type === 'stop' && stop === null) {
      stop = now();
      record('stop-sent');
    }
    return originalSend.call(this, message, ...args);
  };
  if (typeof originalKill === 'function') {
    child.kill = function(signal, ...args) {
      const sent = originalKill.call(this, signal, ...args);
      record('worker-signal', { signal: signal ?? 'SIGTERM', sent });
      return sent;
    };
  }
  const onMessage = message => {
    if (message?.type === 'started' && !seenStarted) {
      seenStarted = true;
      record('started-received', { startupMs: start === null ? null : Math.round(now() - start), error: Boolean(message.error) });
    }
    if (message?.type === 'stopped' && !seenStopped) {
      seenStopped = true;
      record('stopped-received', { stopMs: stop === null ? null : Math.round(now() - stop), error: Boolean(message.error) });
    }
  };
  const onExit = (code, signal) => record('worker-exit', { code, signal, started: seenStarted });
  const onDisconnect = () => record('worker-disconnect');
  const cleanup = () => {
    if (closed) return;
    closed = true;
    child.send = originalSend;
    if (typeof originalKill === 'function') child.kill = originalKill;
    child.removeListener('message', onMessage);
    child.removeListener('exit', onExit);
    child.removeListener('disconnect', onDisconnect);
    child.removeListener('close', onClose);
  };
  const onClose = (code, signal) => { record('worker-close', { code, signal }); cleanup(); };
  child.on('message', onMessage);
  child.once('exit', onExit);
  child.once('disconnect', onDisconnect);
  child.once('close', onClose);
  return cleanup;
}

/** An active control, deliberately separate from the passive observer above.
 * Only attach to an identified Vitest forks transport. Start/stop retain their
 * exact native arguments, receiver, return value and errors. Execution refusal
 * uses the native pool's error path, never a fabricated test completion.
 * @param {any} child
 * @param {(row: Record<string, any>) => void} emit
 */
export function controlForkStartupOnly(child, emit) {
  const originalSend = child.send;
  const record = row => { try { emit(row); } catch { /* Diagnostics cannot disable the fence. */ } };
  const send = function(message, ...args) {
    if (message?.__vitest_worker_request__ === true && ['start', 'stop'].includes(message.type)) {
      let inputSha256 = null;
      try { inputSha256 = createHash('sha256').update(JSON.stringify(message)).digest('hex'); }
      catch { /* Native advanced serialization, not JSON, owns the actual payload. */ }
      record({ event: 'lifecycle-request', childPid: child.pid, type: message.type,
        inputSha256 });
      return originalSend.call(this, message, ...args);
    }
    record({ event: 'execution-request-refused', childPid: child.pid,
      request: ['run', 'collect'].includes(message?.type) ? message.type : 'unknown' });
    const error = Object.assign(new Error('Vitest startup-only diagnostic refused execution'),
      { code: 'VITEST_STARTUP_ONLY_EXECUTION_REFUSED' });
    // PoolRunner subscribes before sending start/run. An error rejects its real
    // resolver and lets its native stop/signal/500ms-kill cleanup run normally.
    if (!child.listenerCount('error')) throw error;
    child.emit('error', error);
    return false;
  };
  child.send = send;
  const detach = () => {
    if (child.send === send) child.send = originalSend;
    child.removeListener('close', detach);
  };
  child.once('close', detach);
  return detach;
}

/** Run the installed Vitest pipeline with its resolved options, fencing only
 * its identified forks transport. The router owns the external timeout/scope.
 * No list/collect, copied worker options, pool override, or general Worker hook.
 * @param {string[]} argv Native Vitest run arguments (including selected files).
 * @param {(row: Record<string, any>) => void} emit
 * @param {{ control?: typeof controlForkStartupOnly }} [options] Narrow negative-control seam; the CLI always uses the fence.
 */
export async function diagnoseVitestStartup(argv, emit, { control = controlForkStartupOnly } = {}) {
  const record = row => { try { emit(row); } catch { /* Fail closed independently of the sink. */ } };
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const require = createRequire(join(process.cwd(), 'package.json'));
  const nodeEntry = require.resolve('vitest/node');
  const workerEntry = realpathSync(join(dirname(nodeEntry), 'workers/forks.js'));
  const packagePath = require.resolve('vitest/package.json');
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!installed.version.startsWith('4.')) throw new Error('Unsupported Vitest startup protocol');
  const { createVitest, parseCLI } = await import(pathToFileURL(nodeEntry).href);
  const parsed = parseCLI(['vitest', 'run', ...argv]);
  if (!parsed.filter.length || parsed.options.watch || parsed.options.browser?.enabled || parsed.options.poolRunner)
    throw new Error('Unsupported startup-only command');
  const originalFork = childProcess.fork;
  const workers = [];
  const closedWorkers = [];
  let context;
  let forkControl;
  try {
    context = await createVitest('test', parsed.options);
    const specifications = await context.globTestSpecifications(parsed.filter);
    const requested = new Set(parsed.filter.map(file => resolve(file)));
    if (!specifications.length || specifications.some(spec => spec.pool !== 'forks' ||
        spec.project.config.poolRunner || !requested.has(resolve(spec.moduleId))) ||
        [...requested].some(file => !specifications.some(spec => resolve(spec.moduleId) === file)))
      throw new Error('Unsupported or ambiguous startup-only specification; verified forks required');
    record({ event: 'startup-only-contract', mode: 'native-vitest-forks-execution-fence',
      vitestVersion: installed.version, nodeVersion: process.version,
      runtime: [packagePath, nodeEntry, workerEntry].map(path => ({ path, sha256: sha(readFileSync(path)) })),
      config: context.vite.config.configFile ? { path: context.vite.config.configFile,
        sha256: sha(readFileSync(context.vite.config.configFile)) } : null,
      argvSha256: sha(JSON.stringify(argv)), specifications: specifications.map(spec => ({
        file: spec.moduleId, pool: spec.pool, project: spec.project.name ?? null,
        sha256: sha(readFileSync(spec.moduleId)), configSha256: sha(JSON.stringify(spec.project.serializedConfig)),
      })) });
    forkControl = function(modulePath, ...args) {
      // Match the actual installed entrypoint, not a filename substring. Native
      // utility workers and every unrelated child retain their normal behavior.
      let selected = false;
      try { selected = realpathSync(modulePath instanceof URL ? fileURLToPath(modulePath) : modulePath) === workerEntry; }
      catch { /* The original fork owns validation and errors. */ }
      const child = originalFork.call(this, modulePath, ...args);
      if (!selected) return child;
      const options = (Array.isArray(args[0]) ? args[1] : args[0]) ?? {};
      const state = { childPid: child.pid, started: false, closed: false, refused: 0 };
      workers.push(state);
      closedWorkers.push(new Promise(resolve => child.once('close', resolve)));
      record({ event: 'controlled-worker-forked', childPid: child.pid, entrypoint: workerEntry,
        execArgv: loaderIdentity((options.execArgv ?? process.execArgv).join(' ')),
        envSha256: sha(JSON.stringify(options.env ?? process.env)),
        optionsSha256: sha(JSON.stringify(options)) });
      const detachObservation = observeForkStartup(child, row => {
        if (row.event === 'started-received' && !row.error) state.started = true;
        if (row.event === 'worker-close') state.closed = true;
        record(row);
      });
      const detachControl = control(child, row => {
        if (row.event === 'execution-request-refused') state.refused++;
        record(row);
      });
      child.once('close', () => { detachControl(); detachObservation(); });
      return child;
    };
    childProcess.fork = forkControl;
    syncBuiltinESMExports();
    await context.start(parsed.filter);
  } finally {
    // Leave observation/fencing installed through native stop and owned cleanup.
    try { await context?.close(); await Promise.all(closedWorkers); }
    finally {
      if (childProcess.fork === forkControl) childProcess.fork = originalFork;
      syncBuiltinESMExports();
    }
  }
  const outcome = { event: 'startup-only-outcome', testVerdict: 'not-measured', workers,
    status: workers.length > 0 && workers.every(row => row.started && row.closed && row.refused > 0)
      ? 'startup-observed' : 'startup-incomplete' };
  record(outcome);
  return outcome;
}

// No clients, intervals, or extra processes: existing runner shutdown owns the
// process group. This preload only observes IPC; it never changes the payload.
function isVitestEntry(value) {
  const entry = String(value ?? '').replaceAll('\\', '/');
  return /(?:^|\/)(?:vitest\/(?:vitest\.mjs|dist\/(?:workers\/[^/]+|worker)\.[cm]?js)|\.bin\/vitest)$/.test(entry);
}

const traceMode = process.env.PAPERCUSP_TEST_STARTUP_TRACE;
if (traceMode === '1' || (traceMode === 'vitest-descendant'
    && isVitestEntry(process.argv[1]))) {
  // startupTraceEnv explicitly selects a root (including generic diagnostic
  // fixtures). Its descendants retain the preload and all source/admission
  // guards, but ordinary Node payloads must not receive diagnostic stderr.
  process.env.PAPERCUSP_TEST_STARTUP_TRACE = 'vitest-descendant';
  let remainingStartup = 24;
  let remainingShutdown = 24;
  const emit = row => {
    // Startup traffic cannot exhaust the evidence needed for a later stop hang.
    const shutdown = ['stop-sent', 'stopped-received', 'worker-signal',
      'worker-exit', 'worker-disconnect', 'worker-close'].includes(row.event);
    if (shutdown ? remainingShutdown-- <= 0 : remainingStartup-- <= 0) return;
    try { process.stderr.write(`TEST_FILE_STARTUP_TRACE ${JSON.stringify({ pid: process.pid, ...row })}\n`); } catch { /* diagnostics cannot break execution */ }
  };
  emit({ event: 'node-loaded', nodeOptions: loaderIdentity(process.env.NODE_OPTIONS), execArgv: loaderIdentity(process.execArgv.join(' ')) });
  const originalFork = childProcess.fork;
  childProcess.fork = function(modulePath, ...args) {
    const child = originalFork.call(this, modulePath, ...args);
    if (isVitestEntry(modulePath)) {
      emit({ event: 'worker-forked', childPid: child.pid });
      observeForkStartup(child, emit);
    }
    return child;
  };
  syncBuiltinESMExports();
}
