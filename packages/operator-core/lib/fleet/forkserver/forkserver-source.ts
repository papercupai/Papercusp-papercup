/**
 * The forkserver program, as source text.
 *
 * WHY THIS EXISTS (WI-6554700010019379, plan sidecar-forkserver-2026-10-21): the
 * bg-host spawner sidecar is a ~500MB Node process, and Node forks children with a
 * plain fork() on the calling thread. Measured 2026-10-21 by strace of the sidecar's
 * main thread: clone() ~11.5ms plus libuv's exec-wait ~12ms per spawn, ~24 spawns/s
 * under git-sync, so the event loop that also runs governed-admission Postgres round
 * trips was blocked 35-59% of the time and admission took ~5s. This tiny process
 * does the forking instead; its fork is cheap because its address space is small,
 * and its exec-wait blocks only its own loop.
 *
 * WHY A STRING: packaged builds bundle every module into one serve.mjs, so a
 * separate entry file would not ship. The program is started with `node -e` and
 * imports only node built-ins. Keep it plain CommonJS JavaScript.
 *
 * Wire protocol (Node IPC, advanced serialization), parent -> forkserver:
 *   { t:'spawn', id, command, args, cwd, env, stdinPath, stdoutPath, detached }
 * forkserver -> parent, in the order the child's events happen:
 *   { t:'spawned', id, pid }            spawn() returned (pid null when it failed)
 *   { t:'spawned', id, pid:null, error } a handoff file or spawn() itself failed
 *   { t:'spawn' | 'error' | 'exit' | 'close' | 'out' | 'err' | 'out-end' | 'err-end', id, ... }
 * The child is spawned with `detached` so it leads its own process group; the parent
 * signals that group directly with process.kill(-pgid), exactly as for a direct spawn.
 */
export const FORKSERVER_SOURCE = String.raw`'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const live = new Map();
function send(m) { try { if (process.connected) process.send(m); } catch (e) { /* parent gone */ } }
function info(e) {
  return { name: e && e.name, message: String(e && e.message !== undefined ? e.message : e), code: e && e.code,
    errno: e && e.errno, syscall: e && e.syscall, path: e && e.path, spawnargs: e && e.spawnargs };
}
function start(m) {
  const id = m.id;
  let inFd = null;
  let outFd = null;
  const closeFds = () => {
    for (const fd of [inFd, outFd]) if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* already closed */ } }
  };
  try {
    if (m.stdinPath) inFd = fs.openSync(m.stdinPath, 'r');
    if (m.stdoutPath) outFd = fs.openSync(m.stdoutPath, 'w');
  } catch (e) {
    closeFds();
    send({ t: 'spawned', id, pid: null, error: info(e) });
    return;
  }
  let child;
  try {
    child = spawn(m.command, m.args, {
      cwd: m.cwd, env: m.env, detached: m.detached,
      stdio: [inFd === null ? 'ignore' : inFd, outFd === null ? 'pipe' : outFd, 'pipe'],
    });
  } catch (e) {
    closeFds();
    send({ t: 'spawned', id, pid: null, error: info(e) });
    return;
  }
  closeFds();
  live.set(id, child);
  send({ t: 'spawned', id, pid: child.pid === undefined ? null : child.pid });
  child.once('spawn', () => send({ t: 'spawn', id }));
  child.on('error', (e) => send({ t: 'error', id, error: info(e) }));
  if (child.stdout) {
    child.stdout.on('data', (d) => send({ t: 'out', id, d }));
    child.stdout.on('end', () => send({ t: 'out-end', id }));
  }
  if (child.stderr) {
    child.stderr.on('data', (d) => send({ t: 'err', id, d }));
    child.stderr.on('end', () => send({ t: 'err-end', id }));
  }
  child.on('exit', (code, signal) => send({ t: 'exit', id, code, signal }));
  child.on('close', (code, signal) => { live.delete(id); send({ t: 'close', id, code, signal }); });
}
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'spawn') start(m);
  else if (m.t === 'ping') send({ t: 'pong', n: m.n });
});
// The parent owns every child's lifetime. If the parent dies, kill each live
// child's process group so nothing outlives it, then exit.
process.on('disconnect', () => {
  for (const child of live.values()) {
    if (child.pid === undefined) continue;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* gone */ } }
  }
  process.exit(0);
});
send({ t: 'ready', pid: process.pid });
`;
