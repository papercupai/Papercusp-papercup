/** E2E: real OpenSSH between the test client and an isolated private-network computer.
 * The remote psu/HTTP fixtures observe transport behavior; this is not release GUI proof. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { startDockerAllocationOwner } from '../../../../scripts/with-documenso-sandbox.mjs';
import {
  defaultPsuConnectionStorePath, normalizeSshProfile, PSU_CONNECTION_STORE_VERSION,
  runPsuConnectionFrontController, savePsuConnectionStore,
} from '../../../../apps/operator/scripts/psu-connection-front-controller.mjs';

describe.skipIf(inject('papercuspTestLayer') !== 'e2e')('private personal-machine transport', () => {
let root = '';
let container = '';
let config = '';
const masters = new Set<string>();
let allocations: Awaited<ReturnType<typeof startDockerAllocationOwner>> | undefined;
// `docker start` acknowledges the daemon request before the container's
// entrypoint finishes installing OpenSSH/python/tmux. Keep the readiness
// window separate from Vitest's hook budget so slow dpkg setup is measured as
// fixture startup rather than reported as an opaque hook timeout.
const FIXTURE_READY_TIMEOUT_MS = 300_000;
const FIXTURE_HOOK_TIMEOUT_MS = 420_000;
// Headless runners may provide no usable terminal. Both SSH entrypoints
// exercise an interactive tmux session, so give them the same terminal contract.
const FIXTURE_TERM = 'xterm-256color';
const REMOTE_INTERACTIVE_TERM = 'tmux-256color';
// Killing the Docker CLI does not cancel the daemon's create/start/stop/rm.
// The external owner survives the runner's cgroup kill and joins each daemon
// outcome before removing the exact labelled container and its private keys.
const docker = (args: string[]): Promise<string> => allocations!.run(args, {}, {
  pendingAfterMs: 20_000,
  onPending: () => {},
  onProgress: (receipt: { operation: string; resource?: string; status: string; elapsedMs: number }) => {
    process.stderr.write(`PERSONAL_SSH_FIXTURE ${JSON.stringify(receipt)}\n`);
  },
});

async function ssh(command: string, args: string[]) {
  expect(command).toBe('ssh');
  const socket = args.indexOf('-S');
  if (socket >= 0) masters.add(args[socket + 1]);
  return new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
    const child = spawn(command, ['-F', config, ...args], {
      env: { ...process.env, TERM: FIXTURE_TERM },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { output += data; });
    child.stderr.on('data', (data: string) => { output += data; });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output }); });
  });
}

// Reuse the installed-PUI selection contract for exact packaged-psu acceptance.
// Resolve the binary before selecting its sibling: installed launchers may be symlinks.
// Without PUI_BIN this continues to exercise the production source entrypoint.
// Only OpenSSH configuration is supplied by the fixture; no controller,
// command runner, PTY implementation or connection dependency is injected.
async function nativePsu(args: string[], input?: string) {
  const installedPui = process.env.PUI_BIN?.trim();
  const command = installedPui ? join(dirname(realpathSync(installedPui)), 'psu') : process.execPath;
  const entryArgs = installedPui ? [] : [fileURLToPath(new URL(
    '../../../../apps/operator/scripts/psu-launcher.mjs', import.meta.url))];
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, [...entryArgs, ...args], {
      cwd: root,
      env: {
        HOME: root, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        TERM: FIXTURE_TERM, LANG: 'C.UTF-8',
        PERSONAL_SSH_FIXTURE_CONFIG: config,
        // Preserve the suite's source-identity enforcement in the native child.
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
        ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
          key.startsWith('PAPERCUSP_COMMITTED_SOURCE_') && value != null)),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let sent = false;
    const capture = (data: Buffer) => {
      output += data.toString('utf8');
      if (input != null && !sent && output.includes('PERSONAL_SSH_INPUT_READY')) {
        sent = true;
        child.stdin.write(`${input}\n`);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.stdin.on('error', () => { /* refusal can close stdin before input */ });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`Native psu ended on ${signal}: ${output}`));
      else resolve({ code, output });
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pc-personal-ssh-'));
  container = `pc-personal-ssh-${randomUUID()}`;
  allocations = await startDockerAllocationOwner({ name: container, root,
    onProgress: (receipt: unknown) => process.stderr.write(`PERSONAL_SSH_FIXTURE ${JSON.stringify(receipt)}\n`),
  });
  // Fail before allocating keys/container state if Docker or its cached image
  // is unavailable. A network pull is never hidden inside the start budget.
  await docker(['version', '--format', '{{.Server.Version}}']);
  const image = (await docker(['image', 'inspect', '--format', '{{.Id}}', 'debian:stable-slim'])).trim();
  expect(image).toMatch(/^sha256:[a-f0-9]{64}$/);
  for (const name of ['client', 'host']) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)], { timeout: 10_000 });
  }
  writeFileSync(join(root, 'psu'), `#!/usr/bin/python3\nimport json,os,socket,sys,time\nprint(json.dumps({'argv':sys.argv[1:],'forwarded':os.environ.get('PAPERCUSP_PSU_CONNECTION_FORWARDED'),'cwd':os.getcwd(),'hostname':socket.gethostname(),'term':os.environ.get('TERM')}),flush=True)\nif '--transport-stdin' in sys.argv:\n print('PERSONAL_SSH_INPUT_READY',flush=True)\n print(json.dumps({'stdin':sys.stdin.readline()}),flush=True)\ntime.sleep(0.2)\n`);
  writeFileSync(join(root, 'gui.py'), `from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'personal-computer-gui')\nHTTPServer(('127.0.0.1',3070),H).serve_forever()\n`);
  process.stderr.write(`PERSONAL_SSH_FIXTURE ${JSON.stringify({ status: 'ownership', resource: container, mount: root })}\n`);
  // The external allocation owner performs the stop/remove and verifies that
  // the labeled container is gone. Docker's --rm would race that owner-side
  // rm --force when stopping this running fixture.
  await docker(['create', '--name', container, '--label', `papercusp.test.owner=${container}`, '-p', '127.0.0.1::22',
    '--mount', `type=bind,source=${root},target=/fixture,readonly`, image, 'sh', '-ec',
    'set -eu; apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server tmux python3; '
    + 'mkdir -p /run/sshd /root/.ssh; cp /fixture/client.pub /root/.ssh/authorized_keys; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; '
    + 'cp /fixture/host /etc/ssh/ssh_host_ed25519_key; chmod 600 /etc/ssh/ssh_host_ed25519_key; '
    + 'cp /fixture/psu /usr/local/bin/psu; chmod 755 /usr/local/bin/psu; '
    + 'python3 /fixture/gui.py >/tmp/gui.log 2>&1 & exec /usr/sbin/sshd -D -e -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no']);
  try { await docker(['start', container]); }
  catch (error) {
    const state = await docker(['inspect', '--format', '{{json .State}}', container]).catch(String);
    throw new Error(`Personal SSH container start failed; state=${state}`, { cause: error });
  }
  const address = (await docker(['port', container, '22/tcp'])).trim();
  expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
  const port = address.split(':').at(-1)!;
  // Pin the independently generated fixture host key, never trust ssh-keyscan.
  writeFileSync(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${readFileSync(join(root, 'host.pub'), 'utf8')}`);
  config = join(root, 'ssh_config');
  writeFileSync(config, `Host personal-fixture\n HostName 127.0.0.1\n Port ${port}\n User root\n IdentityFile ${root}/client\n IdentitiesOnly yes\n StrictHostKeyChecking yes\n UserKnownHostsFile ${root}/known_hosts\n GlobalKnownHostsFile /dev/null\n`);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'ssh'), '#!/bin/sh\nexec /usr/bin/ssh -F "$PERSONAL_SSH_FIXTURE_CONFIG" "$@"\n', { mode: 0o700 });
  let ready = false;
  let containerState = 'unknown';
  let stateCheckedAt = 0;
  const deadline = Date.now() + FIXTURE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (Date.now() - stateCheckedAt >= 5_000) {
      stateCheckedAt = Date.now();
      containerState = await docker(['inspect', '--format', '{{.State.Running}}', container]).catch(() => 'unavailable');
      if (containerState.trim() !== 'true') break;
    }
    const result = await ssh('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=1', 'personal-fixture', 'true']);
    if (result.code === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const failureLog = ready ? '' : await docker(['logs', '--tail', '30', container]).catch(String);
  expect(ready, `isolated sshd did not become ready (container state=${containerState.trim()}): ${failureLog}`).toBe(true);
}, FIXTURE_HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (config) for (const socket of masters) {
    try { execFileSync('ssh', ['-F', config, '-S', socket, '-O', 'exit', '--', 'personal-fixture'], { stdio: 'ignore', timeout: 5_000 }); } catch { /* already gone */ }
  }
  if (allocations) expect(await allocations.close()).toBe('cleanup-verified');
}, FIXTURE_HOOK_TIMEOUT_MS);

test('native psu entrypoint selects the saved machine and preserves remote host identity, argv, stdin/stdout and cwd over pinned SSH', async () => {
  savePsuConnectionStore({ version: PSU_CONNECTION_STORE_VERSION,
    profiles: [normalizeSshProfile({ name: 'native-desktop', host: 'personal-fixture' })],
  }, defaultPsuConnectionStorePath(root));
  const help = await nativePsu(['--help']);
  expect(help.code, help.output).toBe(0);
  expect(help.output).toContain('Run on a saved remote host');
  const guide = readFileSync(new URL(
    '../../../../apps/operator-docs/src/content/docs/harness/remote-access-guide.mdx', import.meta.url), 'utf8');
  expect(guide).toContain('Context and tool calls belong to the selected remote workspace');
  // Docker's configured UTS identity is independent of the command under test.
  // A local fallback must fail even when it preserves the forwarded arguments.
  const remoteHostname = (await docker(['inspect', '--format', '{{.Config.Hostname}}', container])).trim();
  expect(remoteHostname).not.toBe('');
  expect(remoteHostname).not.toBe(hostname());
  const result = await nativePsu(['--connect=native-desktop', '--resume=native session',
    '--label=quoted $value', '--transport-stdin'], 'native input $value');
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('native-desktop');
  expect(result.output).toContain('"argv": ["--resume=native session", "--label=quoted $value", "--transport-stdin"]');
  expect(result.output).toContain('"forwarded": "1"');
  expect(result.output).toContain('"cwd": "/root"');
  expect(result.output).toContain(`"hostname": ${JSON.stringify(remoteHostname)}`);
  expect(result.output).toContain(`"term": ${JSON.stringify(REMOTE_INTERACTIVE_TERM)}`);
  expect(result.output).toContain('"stdin": "native input $value\\n"');
}, 40_000);

test('runs remote psu, serves the private GUI and refuses a revoked or offline computer', async () => {
  savePsuConnectionStore({ version: PSU_CONNECTION_STORE_VERSION,
    profiles: [normalizeSshProfile({ name: 'desktop', host: 'personal-fixture' })],
  }, defaultPsuConnectionStorePath(root));
  let terminalOutput = '';
  const deps = {
    home: root, interactive: true, commandAvailable: () => true, notice: () => {},
    runCommand: ssh,
    runInteractive: async (command: string, args: string[]) => {
      const result = await ssh(command, args); terminalOutput += result.output; return result;
    },
  };
  const terminal = await runPsuConnectionFrontController(['--connect=desktop', '--resume=session 1', '--label=quoted value'], deps);
  expect(terminal.exitCode, `Remote psu failed; captured SSH/PTY output:\n${terminalOutput}`).toBe(0);
  expect(terminalOutput).toContain('"argv": ["--resume=session 1", "--label=quoted value"]');
  expect(terminalOutput).toContain('"forwarded": "1"');
  expect(terminalOutput).toContain('"cwd": "/root"');
  expect(terminalOutput).toContain(`"term": ${JSON.stringify(REMOTE_INTERACTIVE_TERM)}`);

  let browserUrl = '';
  const browser = { ...deps, openBrowser: (url: string) => { browserUrl = url; },
    waitForGuiClose: async () => {
      expect(new URL(browserUrl).hostname).toBe('127.0.0.1');
      expect(await (await fetch(browserUrl)).text()).toBe('personal-computer-gui');
    },
  };
  expect((await runPsuConnectionFrontController(['--connect=desktop', '--connect-gui'], browser)).exitCode).toBe(0);
  await expect(fetch(browserUrl)).rejects.toThrow();

  // Revocation includes closing existing SSH connections, not just deleting a key.
  await docker(['exec', container, 'sh', '-c', ': > /root/.ssh/authorized_keys']);
  for (const socket of masters) await ssh('ssh', ['-S', socket, '-O', 'exit', '--', 'personal-fixture']);
  const revoked = await nativePsu(['--connect=desktop', '--resume=revoked-native']);
  expect(revoked.code, revoked.output).not.toBe(0);
  expect(revoked.output).toContain('OpenSSH host-key and authentication policy');
  expect(revoked.output).not.toContain('"forwarded": "1"');
  browserUrl = '';
  await expect(runPsuConnectionFrontController(['--connect=desktop', '--connect-gui'], browser)).rejects.toThrow(/OpenSSH host-key and authentication policy/);
  expect(browserUrl).toBe('');
  await docker(['stop', container]);
  await expect(runPsuConnectionFrontController(['--connect=desktop'], deps)).rejects.toThrow(/OpenSSH host-key and authentication policy/);
}, 90_000);
});
