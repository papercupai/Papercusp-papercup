#!/usr/bin/env node
/** Run an unchanged test command with an owned Podman API socket.
 * Startup measures HTTP liveness only. /version runs package metadata collectors
 * and is neither a cheap health check nor proof that containers can start.
 * Container capability remains the consuming test's responsibility.
 *
 * node scripts/with-private-podman.mjs --evidence-dir /tmp/fresh-evidence
 *   [--run-timeout-ms 2700000] [--storage-root /tmp/owned-storage] -- <command> [args...]
 * An explicit storage root uses <root>/store and <root>/run with vfs. Seed
 * images using those same Podman flags; storage remains owned by the caller.
 * Keep the absolute <root>/run path at most 50 characters (Podman's limit).
 */
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { killSpawnedProcessTree } from './lib/batch-watchdog.mjs';

function ping(socketPath, timeoutMs, signal) {
  return new Promise((done) => {
    let result = { ok: false, error: 'request closed before response completed' };
    const req = request({ socketPath, path: '/_ping', method: 'GET', signal,
      agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('error', error => { result = { ok: false, error: error.message }; });
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 64) req.destroy(new Error('unexpected ping response body'));
      });
      response.on('end', () => {
        result = { ok: response.statusCode === 200 && body.trim() === 'OK',
          status: response.statusCode, body: body.slice(0, 64) };
      });
    });
    // Total request/body deadline, rather than an inactivity timeout. Wait for
    // close before retrying so a timeout cannot leave overlapping client probes.
    const timer = setTimeout(() => req.destroy(new Error('ping deadline exceeded')), timeoutMs);
    req.on('error', error => { result = { ok: false, error: error.message }; });
    req.once('close', () => { clearTimeout(timer); done(result); });
    req.end();
  });
}

export async function waitForPrivatePodmanApi({ host, socketPath, signal,
  timeoutMs = 15_000, requestTimeoutMs = 1_000, retryMs = 100, probes = [] }) {
  const started = performance.now();
  const abort = new AbortController();
  let hostFailure;
  const exited = (code, exitSignal) => {
    hostFailure = new Error(`private Podman exited before readiness (${code ?? exitSignal})`);
    abort.abort(hostFailure);
  };
  const failed = error => { hostFailure = error; abort.abort(error); };
  host.once('exit', exited);
  host.once('error', failed);
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  try {
    while (performance.now() - started < timeoutMs) {
      if (host.exitCode !== null || host.signalCode !== null) exited(host.exitCode, host.signalCode);
      if (hostFailure) throw hostFailure;
      combined.throwIfAborted();
      const remaining = timeoutMs - (performance.now() - started);
      const result = await ping(socketPath, Math.max(1, Math.min(requestTimeoutMs, remaining)), combined);
      probes.push({ ...result, elapsedMs: Math.round(performance.now() - started) });
      if (hostFailure) throw hostFailure;
      combined.throwIfAborted();
      if (result.ok) return { elapsedMs: Math.round(performance.now() - started), attempts: probes.length };
      await pause(Math.min(retryMs, Math.max(0, timeoutMs - (performance.now() - started))), undefined,
        { signal: combined });
    }
    throw new Error('private Podman did not answer /_ping within the startup deadline');
  } finally {
    host.off('exit', exited);
    host.off('error', failed);
  }
}

async function stop(child) {
  if (!child?.pid) return;
  // A shell can exit before its descendants. Its owned process group still
  // needs cleanup even when the direct child's close event already arrived.
  if (child.exitCode !== null || child.signalCode !== null) {
    killSpawnedProcessTree(child, 'SIGKILL');
    return;
  }
  const closed = new Promise(done => child.once('close', done));
  killSpawnedProcessTree(child, 'SIGTERM');
  const timer = setTimeout(() => killSpawnedProcessTree(child, 'SIGKILL'), 5_000);
  try { await closed; } finally {
    clearTimeout(timer);
    killSpawnedProcessTree(child, 'SIGKILL');
  }
}

export async function runWithPrivatePodman(command, args, { evidenceDir, env = process.env,
  podman = 'podman', storageRoot, timeoutMs = 15_000, runTimeoutMs = 45 * 60_000, signal } = {}) {
  if (!command || !evidenceDir) throw new Error('command and fresh evidenceDir are required');
  if (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs <= 0 || runTimeoutMs > 2_147_483_647) {
    throw new Error('runTimeoutMs must be an integer between 1 and 2147483647');
  }
  // In rootless Podman, graphroot/runroot in storage.conf can resolve to the
  // user's existing store instead. CLI flags take precedence over that config
  // and its database, so a private socket cannot silently use the shared store.
  const storage = storageRoot ? { graphRoot: resolve(storageRoot, 'store'),
    runRoot: resolve(storageRoot, 'run'), driver: 'vfs' } : undefined;
  if (storage && storage.runRoot.length > 50) {
    throw new Error('Podman runroot must be at most 50 characters; choose a shorter storageRoot');
  }
  // Never overwrite another attempt's evidence or connect to an inherited API.
  await mkdir(evidenceDir, { recursive: false });
  const runtime = await mkdtemp(join(tmpdir(), 'pc-podman-'));
  const socketPath = join(runtime, 'api.sock');
  const api = `unix://${socketPath}`;
  const storageArgs = storage ? ['--root', storage.graphRoot, '--runroot', storage.runRoot,
    '--storage-driver', storage.driver] : [];
  const probes = [];
  const receipt = { startedAt: new Date().toISOString(), api, healthPath: '/_ping', probes, runTimeoutMs,
    deadlineAt: new Date(Date.now() + runTimeoutMs).toISOString(), ...(storage ? { storage } : {}) };
  let host, child, log;
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  // This bound belongs to the workload owner, so it survives a CLI observer's
  // exit. It covers API startup and immutable dependency preparation as well as
  // the test command; a timeout receipt is never a product acceptance verdict.
  const deadline = setTimeout(() => {
    receipt.deadlineExceededAt = new Date().toISOString();
    abort.abort(new Error('private Podman run deadline exceeded'));
  }, runTimeoutMs);
  const interrupted = () => abort.abort(new Error('private Podman wrapper interrupted'));
  process.on('SIGTERM', interrupted);
  process.on('SIGINT', interrupted);
  try {
    log = openSync(join(evidenceDir, 'api.log'), 'wx', 0o600);
    host = spawn(podman, [...storageArgs, 'system', 'service', '--time=0', api], {
      env, stdio: ['ignore', log, log], detached: process.platform !== 'win32',
    });
    receipt.apiPid = host.pid;
    receipt.readiness = await waitForPrivatePodmanApi({ host, socketPath, signal: combined, timeoutMs, probes });
    combined.throwIfAborted();
    child = spawn(command, args, { env: { ...env, DOCKER_HOST: api }, stdio: 'inherit',
      detached: process.platform !== 'win32' });
    receipt.commandPid = child.pid;
    let onAbort;
    try {
      receipt.command = await new Promise((done, reject) => {
        onAbort = () => reject(combined.reason);
        combined.addEventListener('abort', onAbort, { once: true });
        child.once('error', reject);
        child.once('close', (code, exitSignal) => done({ code, signal: exitSignal }));
        if (combined.aborted) onAbort();
      });
    } finally { combined.removeEventListener('abort', onAbort); }
    combined.throwIfAborted();
    return receipt.command.code ?? 1;
  } catch (error) {
    receipt.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearTimeout(deadline);
    try { await stop(child); await stop(host); }
    finally {
      if (log !== undefined) closeSync(log);
      process.off('SIGTERM', interrupted);
      process.off('SIGINT', interrupted);
      receipt.cleanup = { apiStopped: !host || host.exitCode !== null || host.signalCode !== null,
        commandStopped: !child || child.exitCode !== null || child.signalCode !== null };
      await rm(runtime, { recursive: true, force: true });
      receipt.finishedAt = new Date().toISOString();
      await writeFile(join(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    }
  }
}

if (isCliEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const options = {};
  const names = { '--evidence-dir': 'evidenceDir', '--run-timeout-ms': 'runTimeoutMs',
    '--storage-root': 'storageRoot' };
  let valid = separator > 0 && separator % 2 === 0;
  for (let i = 0; valid && i < separator; i += 2) {
    const key = names[args[i]];
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) valid = false;
    else options[key] = key === 'runTimeoutMs' ? Number(args[i + 1]) : resolve(args[i + 1]);
  }
  if (!valid || !options.evidenceDir || !args[separator + 1]) {
    console.error('usage: node scripts/with-private-podman.mjs --evidence-dir <fresh-dir> [--run-timeout-ms <ms>] [--storage-root <owned-dir>] -- <command> [args...]');
    process.exitCode = 2;
  } else {
    try { process.exitCode = await runWithPrivatePodman(args[separator + 1], args.slice(separator + 2),
      options); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
