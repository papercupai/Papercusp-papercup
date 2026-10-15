import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const manager = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 5_000 });
const fixtures: Array<{ root: string; unit: string }> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    spawnSync('systemctl', ['--user', 'stop', fixture.unit], { timeout: 15_000 });
    spawnSync('systemctl', ['--user', 'reset-failed', fixture.unit], { timeout: 10_000 });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function state(unit: string): Record<string, string> {
  const result = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'Result', '-p', 'NRestarts', '-p', 'WatchdogTimestampMonotonic'], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) throw new Error(`systemd_state_failed:${result.stderr}`);
  return Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
}

async function waitFor(predicate: () => boolean, label: string, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`timeout:${label}`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no_port')));
    });
  });
}

async function startFixture(dropWatchdog = false) {
  const root = mkdtempSync(join(tmpdir(), 'portal-hosted-watchdog-'));
  const unit = `papercusp-test-portal-watchdog-${randomUUID()}.service`;
  fixtures.push({ root, unit });
  const port = await freePort();
  const launcher = join(root, 'papercusp-cloud-portal-launcher.ts');
  const resolver = join(root, 'packages/operator-core/lib/auth/hosted');
  mkdirSync(resolver, { recursive: true });
  writeFileSync(launcher, readFileSync(join(ROOT, 'apps/operator/scripts/systemd/portal-hosted-launcher.ts')));
  let transport = readFileSync(join(ROOT, 'packages/operator-core/lib/systemd-readiness.ts'), 'utf8');
  if (dropWatchdog) {
    // Negative control: report successful attempts but deliver no watchdog
    // datagrams. A log/ack-only detector passes this; the real manager must not.
    const nativeSend = "systemd.sd_notify(0, request['state'].encode('utf-8'))";
    expect(transport).toContain(nativeSend);
    transport = transport.replace(nativeSend, `(1 if request['state'].startswith('WATCHDOG=1') else ${nativeSend})`);
  }
  writeFileSync(join(root, 'packages/operator-core/lib/systemd-readiness.ts'), transport);
  writeFileSync(join(resolver, 'secret-ref.ts'), "export async function resolveHostedSecretRef() { throw new Error('unexpected_secret_lookup'); }\n");
  const blackhole = join(root, 'blackhole');
  const poisonedNotifier = join(root, 'fork-notifier-must-not-run');
  writeFileSync(poisonedNotifier, '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
  writeFileSync(join(root, 'hosted.env'), `TEST_BLACKHOLE_FILE=${blackhole}\n`);
  writeFileSync(join(root, 'operator.env'), 'HARNESS_ADMIN_DATABASE_URL=postgresql://fixture@127.0.0.1/fixture\n');
  writeFileSync(join(root, 'backend.mjs'), `
    import { createServer } from 'node:http';
    import { existsSync } from 'node:fs';
    if (process.env.NOTIFY_SOCKET || process.env.WATCHDOG_USEC || process.env.WATCHDOG_PID) throw new Error('competing_notification_owner');
    const server = createServer((_request, response) => {
      if (existsSync(process.env.TEST_BLACKHOLE_FILE)) return;
      response.end('healthy');
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  `);
  const env = {
    PAPERCUSP_PORTAL_ROOT: root, PAPERCUSP_PORTAL_START_WEB: join(root, 'backend.mjs'),
    PAPERCUSP_PORTAL_HOSTED_ENV_FILE: join(root, 'hosted.env'), PAPERCUSP_PORTAL_OPERATOR_ENV_FILE: join(root, 'operator.env'),
    PAPERCUSP_INTEGRATION_ROOT: root, PORT: String(port), SYSTEMD_NOTIFY_BIN: poisonedNotifier,
    PORTAL_READINESS_TIMEOUT_MS: '30000', PORTAL_READINESS_INTERVAL_MS: '100', PORTAL_READINESS_REQUEST_TIMEOUT_MS: '200',
    PORTAL_WATCHDOG_INTERVAL_MS: '250', PORTAL_WATCHDOG_PROBE_FAILURES: '2',
  };
  const args = ['--user', '--no-block', `--unit=${unit}`, '--property=Type=notify', '--property=NotifyAccess=all', '--property=WatchdogSec=3s', '--property=TimeoutStartSec=45s', '--property=TimeoutStopSec=5s', '--property=KillMode=control-group', '--property=Restart=no', '--property=LimitCORE=0'];
  for (const [key, value] of Object.entries(env)) args.push(`--setenv=${key}=${value}`);
  args.push(join(ROOT, 'node_modules/.bin/tsx'), launcher);
  const started = spawnSync('systemd-run', args, { encoding: 'utf8', timeout: 10_000 });
  expect(started.status, started.stderr).toBe(0);
  await waitFor(() => state(unit).ActiveState === 'active', `ready:${unit}`);
  return { root, unit, port, blackhole };
}

describe.skipIf(process.platform !== 'linux' || manager.status !== 0)('hosted Portal real systemd notification credit', () => {
  it('receives real credited heartbeats beyond the watchdog window with no fork-per-ping notifier', async () => {
    const fixture = await startFixture();
    const first = Number(state(fixture.unit).WatchdogTimestampMonotonic);
    await new Promise((done) => setTimeout(done, 4_000));
    const after = state(fixture.unit);
    expect(after.ActiveState).toBe('active');
    expect(after.NRestarts).toBe('0');
    expect(Number(after.WatchdogTimestampMonotonic)).toBeGreaterThan(first);
    expect(await fetch(`http://127.0.0.1:${fixture.port}/`).then((response) => response.status)).toBe(200);
  }, 60_000);

  it('withdraws an actually blackholed backend instead of feeding a false healthy watchdog', async () => {
    const fixture = await startFixture();
    writeFileSync(fixture.blackhole, 'blackhole');
    await waitFor(() => state(fixture.unit).ActiveState === 'failed', `withdraw:${fixture.unit}`, 10_000);
    expect(state(fixture.unit).Result).toBe('exit-code');
  }, 60_000);

  it('detects successful-looking notification attempts that systemd never credits', async () => {
    const fixture = await startFixture(true);
    expect(await fetch(`http://127.0.0.1:${fixture.port}/`).then((response) => response.status)).toBe(200);
    await waitFor(() => state(fixture.unit).ActiveState === 'failed', `missing-credit:${fixture.unit}`, 10_000);
    expect(state(fixture.unit).Result).toBe('watchdog');
  }, 60_000);
});
