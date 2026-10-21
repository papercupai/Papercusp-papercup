#!/usr/bin/env node
/**
 * Queue a forced in-place `/mcp` reconnect for the CURRENT psu session.
 *
 * This is the native-Bash break glass for a connected-but-toolless session:
 * the MCP client cannot call the watchdog, but the session still owns its
 * psu-pty control socket. The owner id is taken from PAPERCUSP_SID and the
 * discovery record is read from that id only; there is deliberately no
 * `--owner` override that could turn this into a cross-session injector.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  lstatSync,
  readFileSync,
} from 'node:fs';
import net from 'node:net';
import { papercuspPtyPath } from '../libs/host-platform/src/home.mjs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export const DEFAULT_SERVER_NAME = 'papercusp-su';
export const DEFAULT_ACK_TIMEOUT_MS = 5_000;

/**
 * The host capability that says a `force:true` reconnect is honoured: the /mcp
 * macro re-dials even when the dialog reads `connected` (EI-26532826938565424,
 * EI-26562663214659916). A host loaded before those fixes lacks it, and an
 * interactive host never adopts newer host code while a terminal is attached
 * (psu-pty-host.mjs shouldAdoptHostCode, plan D-008). On such a host the macro
 * reads `connected` and does nothing, so a forced reconnect cannot heal a
 * connected-but-toolless session there (EI-26553022496923180).
 */
export const FORCED_RECONNECT_CAP = 'mcp-reconnect-force';

/** Exit code for a host that cannot force a reconnect (distinct from 1 = failed). */
export const EXIT_HOST_CANNOT_FORCE = 3;

/** True when the discovery record advertises that `force:true` is honoured. */
export function hostHonoursForcedReconnect(record) {
  return Array.isArray(record?.caps) && record.caps.includes(FORCED_RECONNECT_CAP);
}

/**
 * The next rung for a host that cannot force a reconnect: a carry-respawn
 * relaunches the CLI child, and a fresh child re-dials MCP. mcp-call.mjs reaches
 * the operator over HTTP or, from a netns-isolated native Bash, over the
 * agent-MCP unix socket (WI-6554700010019317), so this works when MCP is dark.
 */
export function carryRespawnCommand(ownerId) {
  const args = JSON.stringify({
    reason: 'toolless session; this psu host cannot force an /mcp reconnect',
    autoContinue: true,
  });
  return `node scripts/mcp-call.mjs session:request-compaction '${args}' --client ${ownerId}`;
}

/** Mirror of the host/discovery key contract. */
export function sanitizeKey(ownerId) {
  return String(ownerId || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200);
}

/** The only discovery record this command is allowed to read. */
export function ownDiscoveryPath(ownerId, dir = papercuspPtyPath(process.env, homedir())) {
  return join(dir, `${sanitizeKey(ownerId)}.json`);
}

function safePrivateFile(path, kind) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${kind} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${kind} is not owner-only`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${kind} is owned by another uid`);
  }
  return stat;
}

function safePrivateSocket(path) {
  const stat = lstatSync(path);
  if (!stat.isSocket()) throw new Error('discovery socket is not a Unix socket');
  if ((stat.mode & 0o077) !== 0) throw new Error('discovery socket is not owner-only');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('discovery socket is owned by another uid');
  }
  return stat;
}

/**
 * Resolve only the live host bound to this process's PAPERCUSP_SID. The
 * returned socket is validated as an owner-only Unix socket before any write.
 * `dir` is injectable for tests; production defaults to the host PTY directory.
 */
export function resolveOwnDiscovery({
  ownerId = process.env.PAPERCUSP_SID,
  dir = papercuspPtyPath(process.env, homedir()),
} = {}) {
  const sid = String(ownerId ?? '').trim();
  if (!sid) return { ok: false, reason: 'missing-PAPERCUSP_SID' };
  const metadataPath = ownDiscoveryPath(sid, dir);
  try {
    safePrivateFile(metadataPath, 'discovery record');
    const record = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (!record || record.ownerId !== sid) {
      return { ok: false, reason: 'discovery-owner-mismatch' };
    }
    if (typeof record.sock !== 'string' || record.sock.length === 0) {
      return { ok: false, reason: 'discovery-socket-missing' };
    }
    safePrivateSocket(record.sock);
    return { ok: true, ownerId: sid, metadataPath, socketPath: record.sock, record };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      metadataPath,
    };
  }
}

/** Build the additive forced-reconnect v1 control envelope. */
export function forcedReconnectEnvelope(serverName = DEFAULT_SERVER_NAME, ownerId) {
  const server = String(serverName || DEFAULT_SERVER_NAME).trim() || DEFAULT_SERVER_NAME;
  return JSON.stringify({
    v: 1,
    mode: 'mcp-reconnect',
    data: server,
    force: true,
    ownerId,
  });
}

/**
 * Send one owner-bound envelope and wait for the host's application ACK. A
 * close without an ACK is accepted for an older rolling-upgrade host, matching
 * injectIntoHost's backward-compatible assumed-close behavior.
 */
export function sendForcedReconnect(
  socketPath,
  { ownerId, serverName = DEFAULT_SERVER_NAME, timeoutMs = DEFAULT_ACK_TIMEOUT_MS } = {},
) {
  const payload = `${forcedReconnectEnvelope(serverName, ownerId)}\n`;
  return new Promise((resolve) => {
    let settled = false;
    let ackText = '';
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const socket = net.createConnection(socketPath);
    timer = setTimeout(() => {
      socket.destroy();
      finish({ ok: false, confirmation: 'timeout', reason: 'host-ack-timeout' });
    }, timeoutMs);
    socket.on('connect', () => socket.end(payload));
    socket.on('data', (chunk) => {
      ackText += chunk.toString('utf8');
      for (const line of ackText.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ack = JSON.parse(line);
          if (ack?.v === 1 && typeof ack.ok === 'boolean') {
            finish({
              ok: ack.ok,
              confirmation: 'acked',
              ...(ack.reason !== undefined ? { reason: String(ack.reason) } : {}),
            });
            socket.destroy();
            return;
          }
        } catch {
          // Keep buffering until the host closes or sends a complete JSON line.
        }
      }
      if (ackText.length > 16_384) ackText = ackText.slice(-16_384);
    });
    socket.on('error', (error) => {
      finish({ ok: false, confirmation: 'error', reason: error?.code || error?.message || 'socket-error' });
    });
    socket.on('close', () => {
      if (!settled) finish({ ok: true, confirmation: 'assumed-close', reason: 'host-accepted-without-ack' });
    });
  });
}

export async function reconnectCurrentSession({
  ownerId = process.env.PAPERCUSP_SID,
  serverName = process.env.PAPERCUSP_MCP_SERVER || DEFAULT_SERVER_NAME,
  dir = papercuspPtyPath(process.env, homedir()),
  timeoutMs = DEFAULT_ACK_TIMEOUT_MS,
} = {}) {
  const discovery = resolveOwnDiscovery({ ownerId, dir });
  if (!discovery.ok) return discovery;
  // Nothing is sent to a host that cannot honour force: its macro would read
  // `connected` and return, and the caller would end its turn waiting on a heal
  // that never runs. Hand back the rung that does work instead.
  if (!hostHonoursForcedReconnect(discovery.record)) {
    return {
      ok: false,
      reason: 'host-cannot-force-reconnect',
      ownerId: discovery.ownerId,
      socketPath: discovery.socketPath,
      hostCodeVersion: discovery.record?.hostCodeVersion ?? null,
      next: carryRespawnCommand(discovery.ownerId),
    };
  }
  const sent = await sendForcedReconnect(discovery.socketPath, {
    ownerId: discovery.ownerId,
    serverName,
    timeoutMs,
  });
  return { ...sent, ownerId: discovery.ownerId, socketPath: discovery.socketPath };
}

function printUsage() {
  process.stdout.write(
    'Usage: node scripts/mcp-reconnect.mjs [server-name]\n' +
      'Uses PAPERCUSP_SID to queue a forced reconnect on this session\'s own psu host.\n' +
      `Exits ${EXIT_HOST_CANNOT_FORCE} without sending when the host cannot force one; run the printed carry-respawn command then.\n`,
  );
}

// Bundle- and symlink-safe entry check (lint:no-hand-rolled-cli-entry): the raw
// `file://${argv[1]}` comparison misses a symlinked or relative invocation path.
if (isCliEntry(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exitCode = 0;
  } else {
    const serverName = process.argv.slice(2).find((arg) => !arg.startsWith('-')) || undefined;
    const result = await reconnectCurrentSession({ serverName });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.reason === 'host-cannot-force-reconnect') {
      process.stderr.write(
        'mcp-reconnect: this psu host predates the forced reconnect and does not adopt newer host code while a ' +
          'terminal is attached, so a reconnect here reads "connected" and changes nothing. Request a ' +
          `carry-respawn instead (a fresh CLI re-dials MCP):\n  ${result.next}\n`,
      );
      process.exitCode = EXIT_HOST_CANNOT_FORCE;
    } else {
      process.exitCode = result.ok ? 0 : 1;
    }
  }
}
