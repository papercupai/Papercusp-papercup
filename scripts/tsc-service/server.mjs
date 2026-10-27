#!/usr/bin/env node
// WI-10003404 / plan host-memory-reduction-2026-09-27 P-004 — the shared typecheck service.
//
// One tsgo API server keeps each requested project's program loaded and answers the gate's scoped
// `lint:tsc --files` requests (protocol and scoping live in scripts/lib/tsc-service.mjs). Run by
// the socket-activated user unit apps/operator/scripts/systemd/papercup-tsc-service.{socket,service}:
// systemd holds the socket, starts this on the first connection, and this exits after
// PAPERCUSP_TSC_SERVICE_IDLE_SEC without a request so the memory goes back to the host.
//
// Freshness is by construction, not by watching: requests are served in batches, and every batch
// first takes a new snapshot with `invalidateAll` (re-reads and re-resolves every file, ~1 s), so
// every answer reflects the tree as it stood after the request arrived.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  TSC_SERVICE_MAX_CHECKED_FILES,
  TSC_SERVICE_TIMEOUT_MS,
  checkedSetForCooperatively,
  namedSetFor,
  refreshProjectRootFiles,
  renderDiagnostics,
  tscServiceRequestId,
  tscServiceIdentity,
  assertTscCompilerIdentityCurrent,
  closeTscServiceCompiler,
  takeTscServiceProjectBatch,
  tscServiceSocketPath,
} from '../lib/tsc-service.mjs';

const ROOT = resolve(process.env.PAPERCUSP_TSC_SERVICE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '../..'));
const IDLE_MS = (Number(process.env.PAPERCUSP_TSC_SERVICE_IDLE_SEC) || 20 * 60) * 1000;
// A single current operator program can approach MemoryHigh. Never retain another
// project's program while opening it, including projects coalesced in one queue batch.
// Past this the tsgo child is restarted between batches (the next request reloads, ~2.5 s).
const RSS_RESET_BYTES = (Number(process.env.PAPERCUSP_TSC_SERVICE_RSS_RESET_GIB) || 12) * 1024 ** 3;
const MAX_REQUEST_FILES = 500;

// The compiler comes from THIS checkout (the gate pins the same package), the files from ROOT.
const nativeDir = dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json'));
const { API } = await import(pathToFileURL(join(nativeDir, 'dist/api/async/api.js')).href);

const log = (line) => console.log(`[tsc-service] ${line}`);
const startedAt = Date.now();

/** @type {{ api: any, snapshot: any, snapshotAt: number, open: string[] }} */
const state = { api: null, snapshot: null, snapshotAt: 0, open: [] };
// A reverse-module census is shared only by requests on the same refreshed snapshot.
/** @type {Map<string, Map<string, Set<string>>>} */
const dependencyCache = new Map();
/** @type {{ request: any, reply: (response: object) => void, arrivedAt: number, cancelled: boolean, trace: (phase: string) => void }[]} */
const queue = [];
let draining = false;

/**
 * The native API runs tsgo in a child process. A client timeout closes its socket, but an
 * in-flight compiler RPC does not observe that cancellation and can otherwise hold the
 * single-flight queue long after every caller has fallen back to the CLI. Stop that orphaned
 * operation when no request still needs it. Independently bound the batch by the existing service
 * timeout: a connected or suspended caller cannot leave this queue awaiting an RPC indefinitely.
 * Queued requests are not in this batch and get a fresh API after the failed operation is reset.
 */
function abortRefreshIfUnobserved(batch) {
  let abortRequested = false;
  const abort = () => {
    if (abortRequested || batch.some((item) => !item.cancelled && !item.completed)) return;
    const child = state.api?.client?.process;
    if (!child || child.exitCode !== null || child.signalCode !== null || child.killed) return;
    abortRequested = true;
    for (const item of batch) item.trace('refresh-abort-no-clients');
    log(`terminating tsgo work with no pending observers in its ${batch.length}-request batch`);
    try {
      // Reject the pending JSON-RPC request immediately so drain() can reset the dead API and
      // continue with queued work instead of waiting for a response from the terminated child.
      state.api?.client?.connection?.dispose();
    } catch (error) {
      log(`could not dispose unobserved tsgo connection: ${error?.message ?? error}`);
    }
    try {
      child.kill('SIGTERM');
    } catch (error) {
      log(`could not terminate unobserved tsgo refresh: ${error?.message ?? error}`);
    }
  };
  const deadline = setTimeout(() => {
    const pending = batch.filter((item) => !item.cancelled && !item.completed);
    if (pending.length === 0) return;
    for (const item of pending) {
      item.trace('request-deadline-exceeded');
      item.reply({ ok: false, reason: 'request-deadline-exceeded',
        detail: `compiler batch exceeded ${TSC_SERVICE_TIMEOUT_MS} ms` });
    }
    // Replying releases observers even if their own foreground timers are suspended.
    // Reuse the same owned-child disposal/reset path as caller cancellation.
    abort();
  }, TSC_SERVICE_TIMEOUT_MS);
  for (const item of batch) item.abortRefreshIfUnobserved = abort;
  return () => {
    clearTimeout(deadline);
    for (const item of batch) delete item.abortRefreshIfUnobserved;
  };
}

// mtime-keyed text cache: the checked-set scan reads every in-repo program file per request, and
// almost none of them change between requests.
/** @type {Map<string, { mtimeMs: number, size: number, text: string }>} */
const textCache = new Map();
function cachedText(absFile) {
  let stat;
  try {
    stat = statSync(absFile);
  } catch {
    textCache.delete(absFile);
    return null;
  }
  const hit = textCache.get(absFile);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
  try {
    const text = readFileSync(absFile, 'utf8');
    textCache.set(absFile, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return text;
  } catch {
    return null;
  }
}

function tsgoRssBytes() {
  let total = 0;
  try {
    for (const tid of readdirSync(`/proc/${process.pid}/task`)) {
      const kids = readFileSync(`/proc/${process.pid}/task/${tid}/children`, 'utf8').trim();
      for (const pid of kids ? kids.split(/\s+/) : []) {
        const rss = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
        if (rss) total += Number(rss[1]) * 1024;
      }
    }
  } catch {
    // A child that exited mid-read is simply not counted.
  }
  return total;
}

async function resetApi(why) {
  log(`resetting tsgo (${why})`);
  const { api } = state;
  // Never clear the owning handle and admit another compiler while its
  // predecessor is still alive, even if snapshot disposal would reject.
  await closeTscServiceCompiler(api);
  state.api = null;
  state.snapshot = null;
  state.open = [];
  dependencyCache.clear();
}

/** Take a fresh snapshot covering `projects`, opening and evicting projects as needed. */
async function refresh(projects, trace) {
  assertTscCompilerIdentityCurrent();
  if (state.open.some(project => !projects.includes(project)))
    await resetApi('switching compiler project');
  if (!state.api) state.api = new API({ cwd: ROOT });
  const toOpen = projects.filter((p) => !state.open.includes(p));
  state.open = projects;

  // updateSnapshot also initializes/spawns the compiler. Trace that boundary
  // separately so a stalled startup is not reported as native snapshot work.
  trace('compiler-initialize');
  await state.api.ensureInitialized();
  trace('compiler-initialized');

  const previous = state.snapshot;
  // release is asynchronous native RPC. Waiting before updateSnapshot prevents
  // two complete snapshots (and queued releases) from accumulating during refresh.
  if (previous) {
    trace('snapshot-release');
    await previous.dispose();
    state.snapshot = null;
  }
  trace('snapshot-update');
  let snapshot = await state.api.updateSnapshot({
    ...(toOpen.length > 0 ? { openProjects: toOpen } : {}),
    ...(previous ? { fileChanges: { invalidateAll: true } } : {}),
  });
  assertTscCompilerIdentityCurrent();
  trace('snapshot-updated');
  // invalidateAll does not re-evaluate a tsconfig's include globs. Re-parse each config and tell
  // the API about both added and removed roots; otherwise deleted roots remain in the loaded program
  // and tsc reports TS6053 for a path that no longer exists.
  trace('project-roots-refresh');
  snapshot = await refreshProjectRootFiles({ api: state.api, snapshot, projects });
  trace('project-roots-refreshed');
  state.snapshot = snapshot;
  state.snapshotAt = Date.now();
  dependencyCache.clear();
}

async function serve({ request, arrivedAt, trace, isCancelled }) {
  const started = Date.now();
  if (isCancelled()) return null;
  trace('program-files');
  const project = state.snapshot.getProject(request.project);
  if (!project) return { ok: false, reason: 'project-not-loaded', detail: request.project };
  const options = project.compilerOptions ?? {};
  // Under --noEmit the CLI's handling of declaration diagnostics is not verified against the API,
  // so a declaration-emitting project (agent-mcp today) keeps the CLI rather than risk a diff.
  if (options.declaration || options.composite) {
    return { ok: false, reason: 'declaration-emit-project', detail: 'service parity unverified for declaration diagnostics' };
  }
  const program = project.program;
  const programFiles = await program.getSourceFileNames();
  if (isCancelled()) return null;
  trace('scope');
  const scope = request.scope === 'named'
    ? namedSetFor({ root: ROOT, named: request.files, programFiles })
    : await checkedSetForCooperatively({
        root: ROOT,
        named: request.files,
        programFiles,
        configFile: request.project,
        readText: cachedText,
        dependencyCache,
        maxFiles: TSC_SERVICE_MAX_CHECKED_FILES,
      }, { isCancelled });
  if (!scope || isCancelled()) return null;
  if (scope.files.length > TSC_SERVICE_MAX_CHECKED_FILES) {
    return {
      ok: false,
      reason: 'scope-too-wide',
      detail: `at least ${scope.files.length} files (limit ${TSC_SERVICE_MAX_CHECKED_FILES}); a full compile is cheaper`,
    };
  }

  trace(`program-diagnostics checked=${scope.files.length}`);
  const diagnostics = await program.getConfigFileParsingDiagnostics();
  if (isCancelled()) return null;
  diagnostics.push(...(await program.getProgramDiagnostics()));
  if (isCancelled()) return null;
  trace(`file-diagnostics checked=${scope.files.length}`);
  for (const file of scope.files) {
    if (isCancelled()) return null;
    diagnostics.push(...(await program.getSyntacticDiagnostics(file)));
    if (isCancelled()) return null;
    diagnostics.push(...(await program.getSemanticDiagnostics(file)));
    if (isCancelled()) return null;
  }
  // Deliberately NO getGlobalDiagnostics(): it checks the WHOLE program first (measured on
  // operator-core: 75 s and 3.7 -> 10 GB, against 30 ms for one file). Global diagnostics are
  // file-less and project-wide, not a scoped verdict; the bare run reports them.

  const seen = new Set();
  const errors = diagnostics
    .filter((d) => d.category === 1)
    .filter((d) => {
      const key = `${d.fileName ?? ''}\0${d.pos}\0${d.code}\0${d.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.fileName ?? '').localeCompare(b.fileName ?? '') || a.pos - b.pos);

  // Line/column come from the snapshot's own text, so a peer's edit since the refresh cannot
  // shift them.
  const texts = new Map();
  trace(`render-diagnostics errors=${errors.length}`);
  for (const fileName of new Set(errors.map((d) => d.fileName).filter(Boolean))) {
    if (isCancelled()) return null;
    const sourceFile = await program.getSourceFile(fileName);
    if (isCancelled()) return null;
    texts.set(fileName, typeof sourceFile?.text === 'string' ? sourceFile.text : cachedText(fileName));
  }
  if (isCancelled()) return null;
  const output = renderDiagnostics(errors, { root: ROOT, textFor: (fileName) => texts.get(fileName) ?? null });

  const judged = new Set(scope.files.map((abs) => relative(ROOT, abs)));
  for (const d of errors) if (d.fileName) judged.add(relative(ROOT, d.fileName));
  const now = Date.now();
  if (isCancelled()) return null;
  assertTscCompilerIdentityCurrent();
  return {
    ok: true,
    output,
    errorCount: errors.length,
    checked: [...judged].sort(),
    counts: { named: scope.named, typeReferencing: scope.typeReferencing, importers: scope.importers },
    namedNotInProgram: scope.namedNotInProgram,
    snapshotAgeMs: now - state.snapshotAt,
    queuedMs: started - arrivedAt,
    checkMs: now - started,
  };
}

function validate(request) {
  if (!request || request.v !== 2) return 'unsupported protocol version';
  if (request.operation !== undefined && request.operation !== 'identity') return 'unsupported operation';
  if (typeof request.root !== 'string' || resolve(request.root) !== ROOT) return `this service serves ${ROOT}`;
  if (typeof request.project !== 'string' || !isAbsolute(request.project) || !request.project.endsWith('.json')) {
    return 'project must be an absolute tsconfig path';
  }
  if (!request.project.startsWith(`${ROOT}/`)) return 'project is outside the served checkout';
  if (!Array.isArray(request.files) || request.files.length === 0 || request.files.length > MAX_REQUEST_FILES) {
    return `files must be 1..${MAX_REQUEST_FILES} paths`;
  }
  if (!request.files.every((f) => typeof f === 'string')) return 'files must be strings';
  if (request.scope !== undefined && request.scope !== 'dependencies' && request.scope !== 'named') {
    return 'scope must be dependencies or named';
  }
  return null;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      // Everything queued now arrived before the refresh below starts, so one snapshot is fresh
      // for the whole batch.
      const batch = takeTscServiceProjectBatch(queue);
      if (batch.length === 0) continue;
      const projects = [...new Set(batch.map((item) => item.request.project))];
      const detachRefreshAbort = abortRefreshIfUnobserved(batch);
      try {
      let refreshFailed = false;
      let refreshError;
      try {
        for (const item of batch) item.trace('refresh');
        await refresh(projects, (phase) => {
          for (const item of batch) item.trace(phase);
        });
        for (const item of batch) item.trace('refreshed');
      } catch (error) {
        refreshFailed = true;
        refreshError = error;
      }
      if (refreshFailed) {
        for (const item of batch) item.reply({ ok: false, reason: 'refresh-failed', detail: String(refreshError?.message ?? refreshError) });
        await resetApi(`refresh failed: ${refreshError?.message ?? refreshError}`);
        continue;
      }
      for (let i = 0; i < batch.length; i += 1) {
        const item = batch[i];
        if (item.cancelled) continue;
        try {
          const response = await serve({ ...item, isCancelled: () => item.cancelled });
          if (!response || item.cancelled) {
            item.trace('cancelled');
            continue;
          }
          item.reply(response);
          item.trace(response.ok ? 'complete' : `declined reason=${response.reason}`);
          log(
            response.ok
              ? `served ${relative(ROOT, item.request.project)} named=${item.request.files.length} checked=${response.checked.length} ` +
                  `errors=${response.errorCount} queuedMs=${response.queuedMs} checkMs=${response.checkMs} ` +
                  `tsgoRssGiB=${(tsgoRssBytes() / 1024 ** 3).toFixed(2)}`
              : `declined ${relative(ROOT, item.request.project)}: ${response.reason} ${response.detail ?? ''}`,
          );
        } catch (error) {
          item.trace('check-failed');
          item.reply({ ok: false, reason: 'check-failed', detail: String(error?.message ?? error) });
          await resetApi(`check failed: ${error?.message ?? error}`);
          // The rest of this batch goes back to the front of the queue for a fresh tsgo.
          queue.unshift(...batch.slice(i + 1));
          break;
        }
      }
      const rss = tsgoRssBytes();
      if (rss > RSS_RESET_BYTES) await resetApi(`tsgo RSS ${(rss / 1024 ** 3).toFixed(1)} GiB`);
      } finally {
        detachRefreshAbort();
      }
    }
  } finally {
    draining = false;
    armIdleExit();
  }
}

let idleTimer = null;
function armIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (draining || queue.length > 0) return armIdleExit();
    void shutdown(`idle ${IDLE_MS / 1000}s`);
  }, IDLE_MS);
}

async function shutdown(why) {
  log(`exiting (${why})`);
  server.close();
  await resetApi(why);
  process.exit(0);
}

const server = createServer((socket) => {
  let buffer = '';
  let item = null;
  let replied = false;
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('close', () => {
    // A peer FIN also sets writableEnded under net.Server's default allowHalfOpen=false.
    // Only our reply establishes completion; a disconnected caller no longer needs a check.
    if (item && !replied) {
      item.cancelled = true;
      item.trace('client-disconnected');
      item.abortRefreshIfUnobserved?.();
    }
  });
  socket.on('data', (chunk) => {
    if (item) return;
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      if (buffer.length > 1024 * 1024) socket.destroy();
      return;
    }
    let requestId = tscServiceRequestId();
    let request;
    const reply = (response) => {
      if (!socket.destroyed && !replied) {
        replied = true;
        if (item) item.completed = true;
        const identity = tscServiceIdentity(request ?? {});
        if (response.ok && JSON.stringify(identity) !== JSON.stringify(request.identity)) {
          response = { ok: false, reason: 'identity-mismatch', detail: 'source or config changed during the request' };
        }
        socket.end(`${JSON.stringify({ ...response, kind: 'result', requestId, identity,
          runtime: { pid: process.pid, startedAt } })}\n`);
      }
    };
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      reply({ ok: false, reason: 'bad-request', detail: 'not JSON' });
      return;
    }
    requestId = tscServiceRequestId(request?.requestId);
    const invalid = validate(request);
    if (invalid) {
      const reason = Array.isArray(request?.files) && request.files.length > MAX_REQUEST_FILES ? 'scope-too-wide'
        : invalid.startsWith('scope must') ? 'unsupported-scope' : 'bad-request';
      reply({ ok: false, reason, detail: invalid });
      return;
    }
    const identity = tscServiceIdentity(request);
    if (JSON.stringify(request.identity) !== JSON.stringify(identity)) {
      reply({ ok: false, reason: 'identity-mismatch', detail: 'request source/compiler/config identity differs from this service' });
      return;
    }
    if (identity.projectConfigSha256 === null || identity.namedSources.some(source => source.sha256 === null)) {
      reply({ ok: false, reason: 'source-unavailable', detail: 'requested config or source cannot be read' });
      return;
    }
    // Runtime witnesses must remain observable while a compiler request is
    // queued or stalled. This path never loads or refreshes a compiler program.
    if (request.operation === 'identity') {
      try { assertTscCompilerIdentityCurrent(); }
      catch (error) { reply({ ok: false, reason: error.code, detail: error.message }); return; }
      reply({ ok: true, identityOnly: true, output: '', errorCount: 0, checked: [],
        namedNotInProgram: [], counts: {} });
      return;
    }
    socket.write(`${JSON.stringify({ kind: 'progress', requestId, identity, phase: draining ? 'queued' : 'accepted' })}\n`);
    const arrivedAt = Date.now();
    const trace = (phase) => log(
      `requestId=${requestId} project=${relative(ROOT, request.project)} named=${request.files.length} ` +
        `phase=${phase} elapsedMs=${Date.now() - arrivedAt}`,
    );
    item = { request, reply, arrivedAt, cancelled: false, trace };
    queue.push(item);
    trace('queued');
    armIdleExit();
    void drain();
  });
});

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// systemd socket activation passes the bound socket as fd 3; run by hand, bind the path ourselves.
if (process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid) {
  server.listen({ fd: 3 }, () => log(`listening on the systemd socket for ${ROOT}`));
} else {
  const socketPath = tscServiceSocketPath();
  mkdirSync(dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true });
  server.listen(socketPath, () => log(`listening on ${socketPath} for ${ROOT}`));
}
armIdleExit();
