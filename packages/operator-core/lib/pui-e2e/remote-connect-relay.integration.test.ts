/**
 * `pui --connect` end to end over the Papercusp cloud transport, hermetically
 * (plan pui-first-party-public-release-2026-09-07 P-017 / D-025).
 *
 * Every hop is the real one except the cloud itself:
 *
 *   real `pui --connect=<profile>/<ws> …` (built binary, under a real PTY)
 *     → execs `psu --connect-program=pui …`; `psu` here is a shim that runs the
 *       real front controller (runPsuConnectionFrontController) from this tree
 *     → the controller's real hosted path: list workspaces, open a terminal,
 *       bridge this terminal over the connector WebSocket
 *     → a local stand-in for the portal + connector relay (node:http + ws)
 *       whose "workspace" is a real PTY shell with the built `pui` on PATH
 *     → the shell runs `exec env PAPERCUSP_PSU_CONNECTION_FORWARDED=1 pui …`
 *
 * The live counterpart against a real hosted workspace is recorded on
 * WI-10002893 (spec P017-REMOTE-LIVE).
 */
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  hostedProfileName,
  normalizeHostedProfile,
  PSU_CONNECTION_STORE_VERSION,
  savePsuConnectionStore,
} from '../../../../apps/operator/scripts/psu-connection-front-controller.mjs';
import { assertPuiBinaryUnchanged, ensurePuiBinary, REPO_ROOT, snapshotCurrentPuiBinary } from './pui-binary';

const WORKSPACE = 'ws-relay-e2e';
const TOKEN = `pct_${'r'.repeat(43)}`;
const TICKET = `ht_${'t'.repeat(43)}`;
/** Overridable so a counterexample run can put an older controller behind the psu shim. */
const CONTROLLER =
  process.env.PUI_E2E_FRONT_CONTROLLER ??
  path.join(REPO_ROOT, 'apps', 'operator', 'scripts', 'psu-connection-front-controller.mjs');

let root = '';
let pui = '';
let puiSnapshot: ReturnType<typeof snapshotCurrentPuiBinary> | undefined;
let origin = '';
let profileName = '';
let server: Server;
let relay: WebSocketServer;
/** Every line the relay's workspace shell received from the controller. */
const remoteInput: string[] = [];
const workspaceShells: IPty[] = [];

/** The workspace side of papercusp-hosted-workspace.v1, backed by a real PTY shell. */
function serveWorkspaceTerminal(socket: WebSocket) {
  const send = (message: object) => socket.send(JSON.stringify(message));
  const shell = ptySpawn('/bin/sh', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: root,
    env: {
      HOME: path.join(root, 'workspace-home'),
      PATH: `${path.join(root, 'workspace-bin')}:/usr/bin:/bin`,
      TERM: 'xterm-256color',
      PS1: '$ ',
    },
  });
  workspaceShells.push(shell);
  shell.onData((data) => send({ type: 'pty.output', data: Buffer.from(data).toString('base64') }));
  shell.onExit(({ exitCode, signal }) => {
    send({ type: 'pty.exit', code: exitCode, signal: signal ?? 0 });
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as { type: string; data?: string; cols?: number; rows?: number };
    if (message.type === 'pty.input' && message.data) {
      const text = Buffer.from(message.data, 'base64').toString('utf8');
      remoteInput.push(text);
      shell.write(text);
    }
    if (message.type === 'pty.resize' && message.cols && message.rows) shell.resize(message.cols, message.rows);
  });
  socket.on('close', () => {
    try {
      shell.kill();
    } catch {
      /* already exited */
    }
  });
  send({ type: 'session.bound', role: 'controller' });
  send({ type: 'pty.ready', role: 'controller', resumed: false });
}

beforeAll(async () => {
  // Both endpoints execute a private, measured copy, even if another build
  // replaces the shared cargo output while this relay run is in progress.
  puiSnapshot = snapshotCurrentPuiBinary(ensurePuiBinary());
  pui = puiSnapshot.binary;
  console.log('PUI_RELAY_BINARY_IDENTITY', JSON.stringify({ phase: 'before', ...puiSnapshot }));
  root = mkdtempSync(path.join(tmpdir(), 'pui-remote-relay-'));
  for (const dir of ['local-bin', 'workspace-bin', 'workspace-home', 'home']) mkdirSync(path.join(root, dir));
  // The "workspace host" ships the same pui, like a real Papercusp release.
  symlinkSync(pui, path.join(root, 'workspace-bin', 'pui'));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay.test');
    const json = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { ok: false, error: { code: 'cli_token_invalid' } });
    if (url.pathname === '/api/hosted/cli/workspaces') {
      return json(200, { ok: true, workspaces: [{ id: WORKSPACE, displayName: 'relay-e2e', state: 'active', reachable: true }] });
    }
    if (url.pathname === `/api/hosted/cli/workspaces/${WORKSPACE}/terminal` && req.method === 'POST') {
      return json(200, { ok: true, session: 'relay-session', socketUrl: `wss://portal.invalid/api/hosted/connectors/socket?ticket=${TICKET}` });
    }
    return json(404, { ok: false, error: { code: 'not_found' } });
  });
  relay = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay.test');
    if (url.pathname !== '/api/hosted/connectors/socket' || url.searchParams.get('ticket') !== TICKET) {
      socket.destroy();
      return;
    }
    relay.handleUpgrade(req, socket, head, (ws) => serveWorkspaceTerminal(ws));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profileName = hostedProfileName(origin);

  const storePath = path.join(root, 'home', '.papercusp', 'psu-connections.json');
  mkdirSync(path.dirname(storePath), { recursive: true });
  savePsuConnectionStore(
    {
      version: PSU_CONNECTION_STORE_VERSION,
      profiles: [
        normalizeHostedProfile({
          origin,
          accessToken: TOKEN,
          tokenId: 'hct_relay-e2e',
          organizationId: 'e91577da-655b-4b24-b122-ab57b4f9d211',
          userId: 'user_relay_e2e',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      ],
    },
    storePath,
  );

  // `psu` on this computer: the real front controller, nothing else of psu's launcher.
  const driver = path.join(root, 'psu-front-controller.mts');
  writeFileSync(
    driver,
    [
      `import { runPsuConnectionFrontController } from ${JSON.stringify(CONTROLLER)};`,
      `const result = await runPsuConnectionFrontController(process.argv.slice(2), { storePath: ${JSON.stringify(storePath)} });`,
      `process.exitCode = result.handled ? (result.exitCode ?? 0) : 64;`,
    ].join('\n'),
  );
  const shim = path.join(root, 'local-bin', 'psu');
  writeFileSync(
    shim,
    `#!/bin/sh\ncd ${JSON.stringify(REPO_ROOT)} && exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(driver)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
}, 900_000);

afterAll(async () => {
  for (const shell of workspaceShells) {
    try {
      shell.kill();
    } catch {
      /* already exited */
    }
  }
  relay?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
  if (puiSnapshot) {
    try {
      assertPuiBinaryUnchanged(puiSnapshot.binary, puiSnapshot.sha256);
      console.log('PUI_RELAY_BINARY_IDENTITY', JSON.stringify({ phase: 'after', ...puiSnapshot }));
    } finally {
      rmSync(puiSnapshot.directory, { recursive: true, force: true });
    }
  }
});

/** Run the LOCAL pui under a real PTY until it exits; returns its output and status. */
function runLocalPui(args: string[]): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const term = ptySpawn(pui, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: root,
      env: {
        HOME: path.join(root, 'home'),
        PATH: `${path.join(root, 'local-bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        TERM: 'xterm-256color',
      },
    });
    let output = '';
    term.onData((data) => {
      output += data;
    });
    const timer = setTimeout(() => {
      term.kill();
      reject(new Error(`pui ${args.join(' ')} did not exit within 90 s:\n${output.slice(-2000)}`));
    }, 90_000);
    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ output, exitCode });
    });
  });
}

describe('pui --connect over the cloud workspace transport (P-017)', () => {
  test('runs pui on the workspace, prints its output here and returns its exit status', async () => {
    remoteInput.length = 0;
    const run = await runLocalPui([`--connect=${profileName}/${WORKSPACE}`, '--version']);
    // Check the forwarded command independently of its screen-clear and
    // missing-program shell fallback wrapper; the real PTY proves the result.
    expect(remoteInput[0]).toContain(`exec env PAPERCUSP_PSU_CONNECTION_FORWARDED=1 pui '--version'`);
    expect(run.output).toContain(`psu: connected to ${profileName}/${WORKSPACE}`);
    expect(run.output).toMatch(/pui \d+\.\d+\.\d+/);
    expect(run.exitCode).toBe(0);
  }, 120_000);

  test('a remote pui that fails returns its error and non-zero status here', async () => {
    remoteInput.length = 0;
    // `--fleet=` is forwarded untouched (it is not a transport flag) and the
    // REMOTE pui rejects it; the refusal and its status must come back.
    const run = await runLocalPui([`--connect=${profileName}/${WORKSPACE}`, '--fleet=']);
    expect(remoteInput[0]).toContain(`exec env PAPERCUSP_PSU_CONNECTION_FORWARDED=1 pui '--fleet='`);
    expect(run.output).toContain('--fleet requires a non-empty value');
    expect(run.exitCode).toBe(1);
  }, 120_000);
});
