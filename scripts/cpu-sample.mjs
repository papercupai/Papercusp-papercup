#!/usr/bin/env node
// Attach to a running node process's inspector (opened via SIGUSR1), run the V8
// CPU profiler for a window, and print the top self-time call-sites. Companion to
// leak-sample.mjs (heap allocation) — this one is for CPU/event-loop attribution.
// Mirrors the manual method in the agent-insight
// "attributing-loop-saturation-via-cpuprofiles": subtracts the profiler's own
// observer-effect (node:inspector / (idle) / (program) frames) before ranking.
//
// Usage: node scripts/cpu-sample.mjs <pid> [durationMs] [inspectorPort] [--save <path>]
import { setTimeout as sleep } from 'node:timers/promises';
import { closeSync, fchmodSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { parseArgs } from 'node:util';
import {
  closeInspector,
  createCdpClient,
  discoverInspector,
  redactDiagnosticUrl,
} from './cdp-inspector.mjs';
import { aggregateCpuProfile } from './lib/cpu-profile.mjs';
import { listProcesses, parseArgv } from './proc-guard.mjs';

// Startup may not yet service Runtime.evaluate. On Linux, bind the loopback
// listener to its owning process and exact OS argv instead; never trust a port
// or matching filename alone. The start tick also detects PID reuse.
/** @param {{ pid: number, port: number, expectedEntry: string, expectedArg?: string }} options */
export function readInspectorProcessIdentity({ pid, port, expectedEntry, expectedArg }) {
  const inodes = new Set();
  const loopback = new Set(['0100007F', '00000000',
    '00000000000000000000000000000000', '0000000000000000FFFF00000100007F']);
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = readFileSync(table, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, hexPort] = (fields[1] ?? '').split(':');
      if (fields[3] === '0A' && Number.parseInt(hexPort, 16) === port
          && loopback.has(address) && fields[9] && fields[9] !== '0') inodes.add(fields[9]);
    }
  }
  if (inodes.size !== 1) throw new Error('inspector target identity mismatch: listener ownership unavailable or ambiguous');
  const [listenerInode] = inodes;
  const candidates = pid ? [{ pid }] : listProcesses().map(row => ({ pid: row.pid }));
  const matches = [];
  for (const candidate of candidates) {
    try {
      const root = '/proc/' + candidate.pid;
      const argv = parseArgv(readFileSync(root + '/cmdline'));
      const entryIndex = argv.indexOf(expectedEntry);
      if (entryIndex < 1 || argv.lastIndexOf(expectedEntry) !== entryIndex
          || (expectedArg && !argv.slice(entryIndex + 1).includes(expectedArg))) continue;
      if (!readdirSync(root + '/fd').some(fd => {
        try { return readlinkSync(root + '/fd/' + fd) === 'socket:[' + listenerInode + ']'; }
        catch { return false; }
      })) continue;
      const stat = readFileSync(root + '/stat', 'utf8');
      const startTicks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(startTicks ?? '')) continue;
      matches.push({ pid: candidate.pid, entry: expectedEntry, argv: argv.slice(entryIndex + 1),
        execArgv: argv.slice(1, entryIndex),
        startTicks, listenerInode, identity: 'proc' });
    } catch { /* Exited or unreadable processes cannot supply identity proof. */ }
  }
  if (matches.length !== 1) throw new Error('inspector target identity mismatch: exact process does not own listener');
  return matches[0];
}

/**
 * Collect before a startup probe's deadline kills its child. --cpu-prof alone
 * writes at normal exit and loses the profile on spawnSync's default SIGTERM.
 * Existing-inspector mode pins one port and checks entry/arguments before sampling;
 * it disconnects its own socket without closing the target's pre-opened inspector.
 * @param {{ pid: number, durationMs?: number, startPort?: number, attachExisting?: boolean,
 *   expectedEntry?: string, expectedArg?: string, deadlineMs?: number, procIdentity?: boolean,
 *   resumeStartup?: boolean, requestTimeoutMs?: number }} options
 */
export async function captureCpuProfile({ pid, durationMs = 30000, startPort = 9229,
  attachExisting = false, expectedEntry, expectedArg, deadlineMs = 50000, procIdentity = false,
  resumeStartup = false, requestTimeoutMs = 2000 }) {
  if (!Number.isInteger(pid) || pid < 0 || (!attachExisting && pid === 0))
    throw new TypeError('a positive target pid is required unless attaching by exact entry');
  // The inspector answers CDP requests on the target's MAIN thread, so a busy target
  // (the very host this script exists to diagnose) can need several seconds to answer
  // Profiler.start. A fixed 2s budget refused bg-host at loop p95 ~300ms (WI-10008237).
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 500 || requestTimeoutMs > 60000)
    throw new TypeError('requestTimeoutMs must be an integer between 500 and 60000');
  if (!Number.isInteger(durationMs) || durationMs <= 0 || !Number.isInteger(deadlineMs) || deadlineMs <= 5000)
    throw new TypeError('positive duration and a deadline above 5000ms are required');
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535)
    throw new TypeError('invalid inspector port');
  if (attachExisting && (typeof expectedEntry !== 'string' || !expectedEntry))
    throw new TypeError('existing inspector capture requires an exact expected entry');
  if (procIdentity && (!attachExisting || process.platform !== 'linux' || !isAbsolute(expectedEntry ?? '')))
    throw new TypeError('proc identity requires an existing Linux inspector and absolute expected entry');
  if (resumeStartup && !procIdentity)
    throw new TypeError('startup resume requires kernel process identity');

  const deadline = Date.now() + deadlineMs;
  if (!attachExisting) {
    process.kill(pid, 'SIGUSR1');
    await sleep(1200);
  }
  let inspector;
  const discoveryDeadline = Math.min(deadline - 5000, Date.now() + 10000);
  do {
    inspector = await discoverInspector({ startPort, portCount: attachExisting ? 1 : 6,
      requestTimeoutMs: 500 });
    if (inspector) break;
    await sleep(100);
  } while (Date.now() < discoveryDeadline);
  if (!inspector) throw new Error('could not find inspector within the capture deadline');

  let target;
  if (procIdentity) {
    const endpoint = new URL(inspector.wsUrl);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== inspector.port)
      throw new Error('inspector target identity mismatch: nonlocal endpoint');
    target = readInspectorProcessIdentity({ pid, port: inspector.port, expectedEntry, expectedArg });
    if (resumeStartup && !target.execArgv.some(arg =>
      arg === '--inspect-wait=127.0.0.1:0' || arg === '--inspect-wait=127.0.0.1:' + inspector.port))
      throw new Error('startup resume requires an exact loopback --inspect-wait target');
  }

  const client = createCdpClient(inspector.wsUrl, {
    requestTimeoutMs,
    webSocketOptions: { handshakeTimeout: 2000, maxPayload: 64 * 1024 * 1024 },
  });
  let startupResumed = false;
  try {
    await client.connect();
    // --inspect starts listening before Node has initialized process.argv.
    // Wait for that measured startup boundary before comparing the identity.
    if (!procIdentity) {
      const identityDeadline = Math.min(deadline - 5000, Date.now() + 5000);
      do {
        const evaluated = await client.evaluate('({pid:process.pid, entry:process.argv?.[1], argv:process.argv?.slice(2)})',
          { returnByValue: true });
        target = evaluated.result?.value;
        if (typeof target?.entry === 'string') break;
        await sleep(100);
      } while (Date.now() < identityDeadline);
    }
    if (!Number.isInteger(target?.pid) || (pid && target.pid !== pid)
        || (expectedEntry && target.entry !== expectedEntry)
        || (expectedArg && !target.argv?.includes(expectedArg)))
      throw new Error('inspector target identity mismatch');
    await client.send('Profiler.enable');
    await client.send('Profiler.setSamplingInterval', { interval: attachExisting ? 1000 : 200 });
    await client.send('Profiler.start');
    // Configure profiling while Node services inspector requests at its startup
    // wait, before synchronous compilation/initialization can stall the protocol.
    if (resumeStartup) {
      await client.send('Runtime.runIfWaitingForDebugger');
      startupResumed = true;
    }
    const captureMs = Math.min(durationMs, deadline - Date.now() - 5000);
    if (captureMs <= 0) throw new Error('no capture window remains before the deadline');
    await sleep(captureMs);
    const { profile } = await client.send('Profiler.stop');
    if (!profile?.nodes?.length || !profile.samples?.length)
      throw new Error('inspector returned an empty CPU profile');
    if (procIdentity) {
      const after = readInspectorProcessIdentity({ pid: target.pid, port: inspector.port, expectedEntry, expectedArg });
      if (after.startTicks !== target.startTicks || after.listenerInode !== target.listenerInode)
        throw new Error('inspector target identity mismatch: process changed during capture');
    }
    return { profile, target, captureMs, startupResumed, inspector: redactDiagnosticUrl(inspector.wsUrl) };
  } finally {
    try {
      // A failed profiler setup must not strand the owned child at Node's wait.
      // Preserve a failed release as an error; the caller still owns termination.
      if (resumeStartup && !startupResumed) {
        const after = readInspectorProcessIdentity({ pid: target.pid, port: inspector.port, expectedEntry, expectedArg });
        if (after.startTicks !== target.startTicks || after.listenerInode !== target.listenerInode)
          throw new Error('inspector target identity mismatch: process changed before startup resume');
        await client.send('Runtime.runIfWaitingForDebugger');
      }
    } finally {
      if (attachExisting) client.close();
      else await closeInspector(client, inspector.port);
    }
  }
}

/**
 * Preserve raw profile bytes across guest/host ownership boundaries. A guest may
 * already have saved the capture before it exits; verifying those same bytes
 * needs read access, not permission to reopen its file for writing.
 * @param {string} file
 * @param {string | Buffer} raw
 * @param {{ mode?: 384 | 420 }} [options] Private by default; shared guest outputs opt into 0644.
 * @returns {{ created: boolean, bytes: number }}
 */
export function persistCpuProfile(file, raw, { mode = 0o600 } = {}) {
  if (mode !== 0o600 && mode !== 0o644)
    throw new TypeError('CPU profile creation mode must be 0600 or 0644');
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  try {
    const fd = openSync(file, 'wx', mode);
    try {
      writeFileSync(fd, bytes);
      // An explicit cross-UID output contract must survive a restrictive umask.
      // Apply it only to the descriptor we created, never to an existing capture.
      fchmodSync(fd, mode);
    } finally { closeSync(fd); }
    return { created: true, bytes: bytes.length };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!readFileSync(file).equals(bytes))
      throw new Error('CPU profile output already contains different bytes: ' + file);
    return { created: false, bytes: bytes.length };
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    save: { type: 'string' }, 'attach-existing': { type: 'boolean' },
    'expect-entry': { type: 'string' }, 'expect-arg': { type: 'string' },
    'proc-identity': { type: 'boolean' },
    'resume-startup': { type: 'boolean' },
    'request-timeout-ms': { type: 'string' },
  } });
  const pid = Number(positionals[0]);
  const requestTimeoutMs = values['request-timeout-ms'] === undefined ? 2000 : Number(values['request-timeout-ms']);
  const durationMs = Number(positionals[1] || 30000);
  const startPort = Number(positionals[2] || 9229);
  const { profile, captureMs, target } = await captureCpuProfile({ pid, durationMs, startPort,
    attachExisting: values['attach-existing'] ?? false,
    expectedEntry: values['expect-entry'], expectedArg: values['expect-arg'],
    procIdentity: values['proc-identity'] ?? false,
    resumeStartup: values['resume-startup'] ?? false, requestTimeoutMs,
    deadlineMs: values['attach-existing'] ? 50000 : durationMs + 20000 + requestTimeoutMs });
  if (values.save) {
    const saved = persistCpuProfile(values.save, JSON.stringify(profile));
    console.error(`${saved.created ? 'saved' : 'verified existing'} raw profile at ${values.save}`);
  }
  console.error(JSON.stringify({ target, captureMs }));
  const { totalUs, excludedUs, realUs, frames } = aggregateCpuProfile(profile);
  const excludedPct = totalUs ? ((excludedUs / totalUs) * 100).toFixed(1) : '0.0';
  console.log(`\n=== TOP CPU SELF-TIME (sampled ${(captureMs / 1000).toFixed(1)}s, total ${(totalUs / 1e6).toFixed(1)}s, observer/non-work excluded ${(excludedUs / 1e6).toFixed(1)}s [${excludedPct}%], real workload ${(realUs / 1e6).toFixed(1)}s) ===`);
  for (const [site, us] of frames.slice(0, 30)) {
    const seconds = (us / 1e6).toFixed(2);
    const pct = ((us / (realUs || 1)) * 100).toFixed(1);
    console.log(`${seconds.padStart(7)}s  ${pct.padStart(5)}%  ${site}`);
  }
}

if (isCliEntry(import.meta.url)) await main();
