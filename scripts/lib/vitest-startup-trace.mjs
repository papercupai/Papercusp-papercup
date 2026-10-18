/** Passive, bounded diagnostics for Vitest's real forks lifecycle protocol. */
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reuse the OUT channel and this preload without enabling stderr diagnostics. */
export function nativeProcessTraceEnv(env = process.env) {
  if (!env.PC_EXECUTED_SOURCE_MAP_OUT?.trim()) return env;
  const preload = `--import=${JSON.stringify(new URL('./vitest-startup-trace.mjs', import.meta.url).href)}`;
  const options = env.NODE_OPTIONS ?? '';
  return { ...env, NODE_OPTIONS: options.includes(preload) ? options : `${options} ${preload}`.trim() };
}

// These are observations, not a shell parser or a complete execution census.
// Preserve each Node entry/exit and npm's actual exported spawn calls, including
// lifecycle scripts. Missing preloads, shell builtins, signals and private spawn
// implementations remain gaps in the parent receipt. Never alter stdio/options.
function installNativeProcessTrace(out) {
  const identity = randomUUID();
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
        processIdentity: identity, pid: process.pid, ppid: process.ppid, atMs: Date.now(), ...fields };
      if (!terminal && remaining === -1) row = { ...row, event: 'trace-limit' };
      let bytes = Buffer.from(JSON.stringify(row));
      if (bytes.length > 128 * 1024) {
        bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: row.kind,
          event: 'trace-event-too-large', processIdentity: identity, pid: process.pid,
          ppid: process.ppid, atMs: row.atMs, omittedEvent: event }));
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
      nodeOptions: loaderIdentity(process.env.NODE_OPTIONS) });
  } catch { /* Even an unavailable cwd must not prevent the native entry. */ }
  // A preload's exit listener would run before the program's later listeners
  // and silently lose their writes. Delegate the original emission first and
  // retain bytes after its synchronous listeners, preserving its return/throw.
  const originalEmit = process.emit;
  process.emit = function(event, ...args) {
    if (this !== process || event !== 'exit') return originalEmit.call(this, event, ...args);
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
        stdioAccessible: { stdout: Boolean(child.stdout), stderr: Boolean(child.stderr) } });
      child.once('close', (code, signal) => emit('child-close', {
        childIdentity, childPid: child.pid ?? null, code, signal }));
    } catch { /* Return the exact native child even if observation fails. */ }
    return child;
  };
  syncBuiltinESMExports();

  // Process entry alone cannot distinguish a loader wait from Vitest startup.
  // A synchronous hook observes the call into the remaining loader chain,
  // including async hooks on Node's loader thread. Persist the attempt before
  // delegation so a killed/stuck child still names its last file boundary.
  // These are load observations, never claims that a module was evaluated.
  let loadSequence = 0;
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
          format: result.format ?? null });
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

if (process.env.PC_EXECUTED_SOURCE_MAP_OUT?.trim()) {
  installNativeProcessTrace(process.env.PC_EXECUTED_SOURCE_MAP_OUT.trim());
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
