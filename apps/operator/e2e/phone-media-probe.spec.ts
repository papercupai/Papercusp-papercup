import { test, expect } from './_egress';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

// Real process/media evidence on a private loopback candidate. Never connects
// to the shared LiveKit/operator, provisions a carrier, or claims public audio.
test.describe.configure({ mode: 'serial' });
const repoRoot = resolve(import.meta.dirname, '../../..');
const serverBin = process.env.PHONE_TEST_LIVEKIT_BIN ?? join(homedir(), '.local/bin/livekit-server');
const cliBin = process.env.PHONE_TEST_LK_BIN ?? join(homedir(), '.local/bin/lk');
let root: string, port: number, server: ChildProcess | undefined;
const key = 'phone-e2e', secret = randomBytes(32).toString('hex');
let serverOutput = createTextCollector(undefined, { maxChars: 4000 });

async function freeTcpPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('no candidate TCP port');
  await new Promise<void>((r, reject) => socket.close(e => e ? reject(e) : r()));
  return address.port;
}
async function freeUdpPort() {
  const socket = createSocket('udp4');
  socket.bind(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  socket.close(); await once(socket, 'close');
  return port;
}
async function stopCandidate() {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  const killTimer = setTimeout(() => server?.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(killTimer); }
}

test.beforeAll(async () => {
  await Promise.all([access(serverBin, constants.X_OK), access(cliBin, constants.X_OK)]);
  root = await mkdtemp(join(tmpdir(), 'phone-media-e2e-'));
  port = await freeTcpPort();
  let tcp = await freeTcpPort();
  while (tcp === port) tcp = await freeTcpPort();
  const udp = await freeUdpPort();
  const config = join(root, 'livekit.yaml');
  await writeFile(config, `port: ${port}\nbind_addresses: [127.0.0.1]\nkeys:\n  ${key}: ${secret}\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  node_ip: 127.0.0.1\n  use_external_ip: false\n  enable_loopback_candidate: true\n  stun_servers: []\n`, { mode: 0o600 });
  server = spawn(serverBin, ['--config', config, '--dev'], { stdio: ['ignore', 'pipe', 'pipe'] });
  serverOutput = createTextCollector(undefined, { maxChars: 4000 });
  for (const output of [server.stdout, server.stderr]) serverOutput.attach(output);
  server.on('error', e => { serverOutput.append(e.message); });
  try {
    await expect.poll(async () => {
      if (server?.exitCode !== null || server?.signalCode !== null) {
        throw new Error(`isolated candidate exited: ${serverOutput.peek().replaceAll(secret, '[fixture-secret]')}`);
      }
      try { return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).ok; }
      catch { return false; }
    }, { timeout: 10_000 }).toBe(true);
  } catch (e) { await stopCandidate(); throw e; }
});

test.afterAll(async () => {
  await stopCandidate();
  if (root) await rm(root, { recursive: true, force: true });
});

async function probe(candidateSecret: string) {
  await writeFile(join(root, 'livekit.env'), `PHONE_LIVEKIT_API_KEY=${key}\nPHONE_LIVEKIT_API_SECRET=${candidateSecret}\nPHONE_LIVEKIT_URL=ws://127.0.0.1:${port}\n`, { mode: 0o600 });
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !k.startsWith('PHONE_') && !k.startsWith('LIVEKIT_')));
  return promisify(execFile)('bash', [join(repoRoot, 'infra/phone-app/verify-media-plane.sh')], {
    env: { ...base, PHONE_CONFIG_DIR: root, PHONE_LK_BIN: cliBin,
      PHONE_NODE_BIN: process.execPath, DURATION: '3s' },
    timeout: 35_000,
  }).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
}

test('measures received audio through the actual isolated LiveKit and CLI', async () => {
  const result = await probe(secret);
  expect(result.code, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout.split('\n').find((line: string) => line.startsWith('{'))!);
  expect(report.receivedPackets).toBeGreaterThan(0);
  expect(report).toMatchObject({ scope: 'single-publisher-to-subscriber',
    publicAudioVerified: false, bidirectionalAudioVerified: false });
  expect(result.stdout + result.stderr).not.toContain(secret);
});

test('refuses wrong credentials despite a healthy server and CLI zero-exit errors', async () => {
  const result = await probe('deliberately-wrong-fixture-secret');
  expect(result.code).toBe(1);
  expect(result.stdout).not.toContain('audio traffic verified');
  expect(result.stderr).toMatch(/no complete measured audio receive path|lk load-test exited non-zero/);
  expect(result.stdout + result.stderr).not.toContain('deliberately-wrong-fixture-secret');
});
