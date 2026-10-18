#!/usr/bin/env node
/** Run an unchanged test command with an owned Podman API socket.
 * Startup measures HTTP liveness only. /version runs package metadata collectors
 * and is neither a cheap health check nor proof that containers can start.
 * Container capability remains the consuming test's responsibility.
 *
 * node scripts/with-private-podman.mjs --evidence-dir /tmp/fresh-evidence -- <command> [args...]
 */
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

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
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(done => child.once('close', done));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await closed; } finally { clearTimeout(timer); }
}

export async function runWithPrivatePodman(command, args, { evidenceDir, env = process.env,
  podman = 'podman', timeoutMs = 15_000, signal } = {}) {
  if (!command || !evidenceDir) throw new Error('command and fresh evidenceDir are required');
  // Never overwrite another attempt's evidence or connect to an inherited API.
  await mkdir(evidenceDir, { recursive: false });
  const runtime = await mkdtemp(join(tmpdir(), 'pc-podman-'));
  const socketPath = join(runtime, 'api.sock');
  const api = `unix://${socketPath}`;
  const probes = [];
  const receipt = { startedAt: new Date().toISOString(), api, healthPath: '/_ping', probes };
  let host, child, log;
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const interrupted = () => abort.abort(new Error('private Podman wrapper interrupted'));
  process.on('SIGTERM', interrupted);
  process.on('SIGINT', interrupted);
  try {
    log = openSync(join(evidenceDir, 'api.log'), 'wx', 0o600);
    host = spawn(podman, ['system', 'service', '--time=0', api], {
      env, stdio: ['ignore', log, log],
    });
    receipt.apiPid = host.pid;
    receipt.readiness = await waitForPrivatePodmanApi({ host, socketPath, signal: combined, timeoutMs, probes });
    combined.throwIfAborted();
    child = spawn(command, args, { env: { ...env, DOCKER_HOST: api }, stdio: 'inherit' });
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
  if (args[0] !== '--evidence-dir' || !args[1] || args[2] !== '--' || !args[3]) {
    console.error('usage: node scripts/with-private-podman.mjs --evidence-dir <fresh-dir> -- <command> [args...]');
    process.exitCode = 2;
  } else {
    try { process.exitCode = await runWithPrivatePodman(args[3], args.slice(4), { evidenceDir: resolve(args[1]) }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
