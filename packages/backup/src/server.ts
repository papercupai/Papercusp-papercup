/**
 * Per-workspace kopia server lifecycle (the kopia web UI we iframe into
 * the /dev Backups tab).
 *
 * `kopia server start` runs a long-lived HTTP server with a web UI on a
 * loopback port. One server per workspace; we cache the spawned child
 * keyed by workspaceId and reuse across requests.
 *
 * The browser gets a read-only loopback proxy. Its private Kopia backend
 * requires an ephemeral password that never reaches the browser: Kopia's
 * --readonly option alone still allows HTML UI snapshot deletion.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { backupHost } from './config';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { deriveRepoPassword } from './password';

const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';

export interface KopiaServerInfo {
  workspaceId: string;
  port: number;
  url: string;
  startedAt: string;
}

interface ServerHandle {
  info: KopiaServerInfo;
  child: ChildProcess;
  explorer: Server;
}

const RUNNING = new Map<string, ServerHandle>();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error('failed to allocate port')));
      }
    });
  });
}

export async function startKopiaServer(workspaceId: string): Promise<KopiaServerInfo> {
  const existing = RUNNING.get(workspaceId);
  if (existing && !existing.child.killed) return existing.info;

  const workspaceRoot = join(backupHost().workspacesRoot(), workspaceId);
  const backupsDir = join(workspaceRoot, 'backups');
  await mkdir(backupsDir, { recursive: true });

  const password = await deriveRepoPassword(workspaceId);
  const kopiaPort = await freePort();
  const serverPassword = randomUUID();
  const authorization = `Basic ${Buffer.from(`kopia:${serverPassword}`).toString('base64')}`;
  let explorer: Server | undefined;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KOPIA_PASSWORD: password,
    KOPIA_CONFIG_PATH: join(backupsDir, 'repository.config'),
    KOPIA_LOG_DIR: join(backupsDir, 'logs'),
    KOPIA_CACHE_DIRECTORY: join(backupsDir, 'cache'),
  };

  const child = spawn(KOPIA_BIN, [
    'server', 'start',
    '--insecure',
    `--server-password=${serverPassword}`,
    // Capture and expiry must use the host's legal-hold retention lease.
    // The embedded explorer cannot mutate the repository outside that seam.
    '--readonly',
    '--no-control-api',
    `--address=127.0.0.1:${kopiaPort}`,
    '--disable-csrf-token-checks',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  // An unhandled ChildProcess 'error' (spawn ENOENT when the kopia binary
  // is absent from the runtime) is an UNCAUGHT EXCEPTION that kills the
  // whole operator — took serve down live on Windows 2026-06-11 when the
  // Setup Wizard reached the Backups step. Capture and surface as a
  // normal rejection instead.
  let spawnError: NodeJS.ErrnoException | null = null;
  child.on('error', (e) => {
    spawnError = e;
    RUNNING.delete(workspaceId);
  });
  child.stdout.on('data', () => { /* drain */ });
  child.stderr.on('data', () => { /* drain */ });
  child.on('exit', () => { explorer?.close(); RUNNING.delete(workspaceId); });

  // A fixed delay can hand the iframe an unbound port. Wait for the actual
  // listener, with a bounded deadline and child-failure checks on every probe.
  const deadline = Date.now() + 10_000;
  let listening = false;
  while (!spawnError && child.exitCode === null && !child.killed && Date.now() < deadline) {
    listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: kopiaPort });
      socket.setTimeout(200);
      const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
    if (listening) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (spawnError) {
    RUNNING.delete(workspaceId);
    const failed: NodeJS.ErrnoException = spawnError;
    throw new Error(
      failed.code === 'ENOENT'
        ? `kopia binary not found (${KOPIA_BIN}) — backups are unavailable in this runtime`
        : `kopia server failed to spawn: ${failed.message}`,
    );
  }
  if (child.exitCode !== null) {
    RUNNING.delete(workspaceId);
    throw new Error(`kopia server failed to start (exit ${child.exitCode})`);
  }
  if (!listening || child.killed) {
    child.kill('SIGTERM');
    RUNNING.delete(workspaceId);
    throw new Error('kopia server did not become ready');
  }
  // Kopia's readonly option suppresses uploads, but its HTML UI API still
  // accepts deletes. Expose only reads; the private server requires a secret
  // that the browser never receives, so it cannot bypass this boundary.
  explorer = createHttpServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'This backup explorer is read-only.' }));
      return;
    }
    const upstream = httpRequest({ host: '127.0.0.1', port: kopiaPort,
      method: req.method, path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${kopiaPort}`, authorization } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    explorer!.once('error', reject);
    explorer!.listen(0, '127.0.0.1', resolve);
  }).catch((error) => { child.kill('SIGTERM'); throw error; });
  const address = explorer.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate explorer port');
  const info: KopiaServerInfo = { workspaceId, port: address.port,
    url: `http://127.0.0.1:${address.port}/`, startedAt: new Date().toISOString() };
  RUNNING.set(workspaceId, { info, child, explorer });
  return info;
}

export function stopKopiaServer(workspaceId: string): boolean {
  const h = RUNNING.get(workspaceId);
  if (!h) return false;
  h.child.kill('SIGTERM');
  h.explorer.close();
  RUNNING.delete(workspaceId);
  return true;
}

export function kopiaServerStatus(workspaceId: string): KopiaServerInfo | null {
  const h = RUNNING.get(workspaceId);
  return h && !h.child.killed ? h.info : null;
}
