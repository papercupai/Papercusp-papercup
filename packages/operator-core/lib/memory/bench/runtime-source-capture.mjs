/** Diagnostic preload: capture V8's actual parsed source bytes in the main
 * isolate and attached workers, including workers with execArgv: []. Only the
 * main thread owns the receipt; worker sources arrive through NodeWorker events.
 * This parsed-source census is not a claim about native libraries, file opens, subprocesses,
 * unexecuted branches, or the original bytes before a TS loader transforms them.
 * Run with PAPERCUSP_RUNTIME_SOURCE_CAPTURE=<new private file> node --import ...
 * A complete process-tree witness must reconcile these receipts with an
 * independently observed process population.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import inspector from 'node:inspector';
import { isMainThread } from 'node:worker_threads';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function validateRuntimeSourceCapture(rows, expectedWorkerIds = [], processTerminal) {
  const header = rows[0], terminal = rows.at(-1);
  if (header?.kind !== 'start' || header.schemaVersion !== 1 || !Number.isSafeInteger(header.processId)
    || terminal?.kind !== 'terminal' || terminal.processId !== header.processId)
    throw new Error('runtime source capture lacks process/terminal identity');
  if (terminal.exitCode !== 0 || terminal.errors !== 0 || terminal.pending !== 0)
    throw new Error('runtime source capture is incomplete or failed');
  const scripts = rows.filter(row => row.kind === 'source');
  const workers = rows.filter(row => row.kind === 'worker-attached');
  if (!scripts.length || scripts.length !== terminal.sources
    || workers.length !== terminal.workers || rows.some(row => row.kind === 'error'))
    throw new Error('runtime source capture census differs from terminal receipt');
  const identities = new Set(), workerIds = new Set(workers.map(row => row.workerId));
  for (const row of scripts) {
    const key = JSON.stringify([row.target, row.scriptId]);
    if (identities.has(key) || typeof row.scriptId !== 'string' || typeof row.target !== 'string'
      || typeof row.url !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || row.target !== 'main' && !workerIds.has(row.target))
      throw new Error('runtime source capture has invalid or duplicate source identity');
    identities.add(key);
  }
  const workersClosedByProcessExit = [];
  for (const worker of workers) {
    const detached = rows.filter(row => row.kind === 'worker-detached' && row.workerId === worker.workerId).length;
    // Node's own ESM loader has process lifetime and need not detach before the
    // main exit hook. Require the launcher's independent close/EOF receipt;
    // never apply this exception to an application worker or a pending request.
    const closedByProcess = detached === 0 && worker.url === 'node:internal/modules/esm/worker'
      && processTerminal?.processId === header.processId && processTerminal.exitCode === 0
      && processTerminal.signal === null && processTerminal.eof === true;
    if (closedByProcess) workersClosedByProcessExit.push(worker.workerId);
    if (typeof worker.workerId !== 'string' || !worker.workerId || !worker.waitingForDebugger
      || detached !== 1 && !closedByProcess
      || !scripts.some(row => row.target === worker.workerId))
      throw new Error('runtime source capture lacks a complete worker census');
  }
  if (terminal.liveWorkers !== workersClosedByProcessExit.length)
    throw new Error('runtime source capture is incomplete or failed');
  if (workerIds.size !== workers.length || expectedWorkerIds.some(id => !workerIds.has(String(id))))
    throw new Error('runtime source capture is missing an expected worker');
  return { processId: header.processId, sources: scripts.length, workerIds: [...workerIds], workersClosedByProcessExit,
    parsedSourcePopulationComplete: true, completeRuntimeClosureVerified: false,
    scope: 'V8 parsed sources in the captured main isolate and attached workers only' };
}

export function startRuntimeSourceCapture(destination) {
  const fd = fs.openSync(destination, 'wx', 0o600);
  const session = new inspector.Session();
  const targets = new Map(), errors = [];
  let sourceCount = 0, workerCount = 0, finished = false;
  const emit = row => fs.writeSync(fd, JSON.stringify(row) + '\n');
  const fail = (target, message) => {
    errors.push(message); emit({ kind: 'error', target, message });
  };
  emit({ kind: 'start', schemaVersion: 1, processId: process.pid,
    node: process.version, executable: process.execPath, startedAt: new Date().toISOString(),
    scope: 'parsed source bytes; native libraries, model files and other processes excluded' });
  session.connect();

  const main = { id: 'main', sources: new Set(), pending: new Map(), nextId: 0, live: true };
  main.post = (method, params, callback) => session.post(method, params, callback);
  targets.set(main.id, main);

  const capture = (target, parsed) => {
    if (target.sources.has(parsed.scriptId)) return;
    target.sources.add(parsed.scriptId);
    target.sourcePending = (target.sourcePending ?? 0) + 1;
    target.post('Debugger.getScriptSource', { scriptId: parsed.scriptId }, (error, result) => {
      target.sourcePending--;
      if (error) fail(target.id, 'getScriptSource: ' + error.message);
      else if (typeof result?.scriptSource !== 'string') fail(target.id, 'missing parsed source bytes');
      else {
        const bytes = parsed.scriptLanguage === 'WebAssembly'
          ? typeof result.bytecode === 'string' ? Buffer.from(result.bytecode, 'base64') : null
          : Buffer.from(result.scriptSource, 'utf8');
        if (!bytes) fail(target.id, 'missing WebAssembly bytecode');
        else {
          sourceCount++;
          emit({ kind: 'source', target: target.id, scriptId: parsed.scriptId, url: parsed.url,
            language: parsed.scriptLanguage ?? 'JavaScript', bytes: bytes.length, sha256: digest(bytes),
            ...(parsed.sourceMapURL ? { sourceMapSha256: digest(parsed.sourceMapURL) } : {}) });
        }
      }
      resume(target);
    });
  };
  const resume = target => {
    if (!target.paused || target.sourcePending || !target.live) return;
    target.paused = false;
    target.post('Debugger.resume', {}, error => { if (error) fail(target.id, 'resume: ' + error.message); });
  };
  const notification = (target, method, params) => {
    if (method === 'Debugger.scriptParsed') capture(target, params);
    else if (method === 'Debugger.scriptFailedToParse') fail(target.id, 'script failed to parse: ' + params.url);
    else if (method === 'Debugger.paused') { target.paused = true; resume(target); }
    else if (method === 'NodeWorker.attachedToWorker') attach(target, params);
    else if (method === 'NodeWorker.detachedFromWorker') {
      const child = [...targets.values()].find(item => item.parent === target && item.sessionId === params.sessionId);
      if (!child) return fail(target.id, 'detached unknown worker');
      child.live = false;
      if (child.pending.size || child.sourcePending) fail(child.id, 'worker detached with pending source/protocol requests');
      emit({ kind: 'worker-detached', workerId: child.id });
    } else if (method === 'NodeWorker.receivedMessageFromWorker') {
      const child = [...targets.values()].find(item => item.parent === target && item.sessionId === params.sessionId);
      if (!child) return fail(target.id, 'message from unknown worker');
      let message;
      try { message = JSON.parse(params.message); } catch { return fail(child.id, 'invalid worker protocol message'); }
      if (message.id !== undefined) {
        const callback = child.pending.get(message.id);
        child.pending.delete(message.id);
        if (!callback) return fail(child.id, 'unknown worker protocol response');
        callback(message.error ? new Error(message.error.message) : null, message.result);
      } else notification(child, message.method, message.params);
    }
  };
  const attach = (parent, params) => {
    const id = params.workerInfo.workerId;
    if (targets.has(id)) return fail(id, 'duplicate worker identity');
    const target = { id, parent, sessionId: params.sessionId, sources: new Set(), pending: new Map(), nextId: 0, live: true };
    targets.set(id, target); workerCount++;
    emit({ kind: 'worker-attached', workerId: id, parent: parent.id,
      waitingForDebugger: params.waitingForDebugger, url: params.workerInfo.url });
    if (!params.waitingForDebugger) fail(id, 'worker was not paused before application execution');
    target.post = (method, args, callback) => {
      const requestId = ++target.nextId;
      target.pending.set(requestId, callback);
      parent.post('NodeWorker.sendMessageToWorker', { sessionId: target.sessionId,
        message: JSON.stringify({ id: requestId, method, params: args }) }, error => {
        if (error && target.pending.delete(requestId)) callback(error);
      });
    };
    target.post('Debugger.enable', {}, error => {
      if (error) { fail(id, error.message); return; }
      // Pause before script execution so a short-lived eval/import cannot exit
      // before getScriptSource returns. Main-isolate protocol calls are local.
      target.post('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }, error => {
        if (error) fail(id, error.message);
        target.post('Runtime.runIfWaitingForDebugger', {}, error => { if (error) fail(id, error.message); });
      });
    });
  };
  session.on('inspectorNotification', message => notification(main, message.method, message.params));
  session.post('Debugger.enable', {}, error => { if (error) fail('main', error.message); });
  session.post('NodeWorker.enable', { waitForDebuggerOnStart: true }, error => { if (error) fail('main', error.message); });

  process.once('exit', code => {
    if (finished) return;
    finished = true;
    const pending = [...targets.values()].reduce((sum, target) => sum + target.pending.size + (target.sourcePending ?? 0), 0);
    const liveWorkers = [...targets.values()].filter(target => target.id !== 'main' && target.live).length;
    emit({ kind: 'terminal', processId: process.pid, exitCode: code, sources: sourceCount,
      workers: workerCount, errors: errors.length, pending, liveWorkers, finishedAt: new Date().toISOString() });
    fs.fsyncSync(fd); fs.closeSync(fd); session.disconnect();
  });
}

if (isMainThread && process.env.PAPERCUSP_RUNTIME_SOURCE_CAPTURE)
  startRuntimeSourceCapture(process.env.PAPERCUSP_RUNTIME_SOURCE_CAPTURE);
