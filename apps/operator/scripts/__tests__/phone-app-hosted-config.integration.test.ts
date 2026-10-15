import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mediaConfig, validateCertificate, checkTlsEndpoint } from '../../../../infra/phone-app/media-config.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const deploy = join(repoRoot, 'infra/phone-app/deploy.sh');
let root: string, certPath: string, keyPath: string, shortCert: string, otherKey: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'phone-media-contract-'));
  certPath = join(root, 'turn certificate.pem'); keyPath = join(root, 'turn private.pem');
  shortCert = join(root, 'short.pem'); otherKey = join(root, 'other.pem');
  for (const [cert, key, days] of [[certPath, keyPath, '30'], [shortCert, otherKey, '1']]) {
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', days, '-subj', '/CN=turn.example.com',
      '-addext', 'subjectAltName=DNS:turn.example.com'], { encoding: 'utf8' });
    expect(result.status, 'generate isolated test certificate').toBe(0);
  }
});

describe('Phone smoke-test process verdict (fixture evidence only)', () => {
  it('rejects a successful CLI process with only zero-traffic keywords', async () => {
    const server = createHttpServer((_req, res) => res.end('OK'));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture listener');
    const conf = join(root, 'smoke-zero'); mkdirSync(conf);
    writeFileSync(join(conf, 'livekit.env'), `PHONE_LIVEKIT_API_KEY=fixture-key\nPHONE_LIVEKIT_API_SECRET=fixture-secret-withheld\nPHONE_LIVEKIT_URL=ws://127.0.0.1:${address.port}\n`, { mode: 0o600 });
    const cli = join(conf, 'lk');
    writeFileSync(cli, '#!/bin/sh\nprintf "received 0 packets, bitrate 0bps\\n"\n', { mode: 0o700 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PHONE_')));
    try {
      const outcome = await promisify(execFile)('bash', [join(repoRoot, 'infra/phone-app/verify-media-plane.sh')], {
        env: { ...env, PHONE_CONFIG_DIR: conf, PHONE_LK_BIN: cli, PHONE_NODE_BIN: process.execPath },
        timeout: 10_000,
      }).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain('no complete measured audio receive path');
      expect(outcome.stdout).not.toContain('verified');
      expect(outcome.stdout + outcome.stderr).not.toContain('fixture-secret-withheld');
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string) {
  const conf = join(root, name); mkdirSync(conf);
  const original = 'PHONE_LIVEKIT_API_KEY=test-key\nPHONE_LIVEKIT_API_SECRET=test-secret-withheld\n' +
    'PHONE_LIVEKIT_URL=ws://127.0.0.1:7890\nPHONE_WORKER_SECRET=test-worker-retained\n';
  writeFileSync(join(conf, 'livekit.env'), original, { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PHONE_')));
  return { conf, original, env: { ...env, PHONE_CONFIG_DIR: conf,
    PHONE_NODE_BIN: process.execPath, PHONE_LAN_IFACE: 'test0',
    PHONE_LIVEKIT_PUBLIC_URL: 'wss://voice.example.com', PHONE_TURN_DOMAIN: 'turn.example.com',
    PHONE_TURN_CERT_FILE: certPath, PHONE_TURN_KEY_FILE: keyPath } };
}
function run(env: NodeJS.ProcessEnv, args = ['--hosted', '--render-only']) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PHONE_')));
  return spawnSync('bash', [deploy, ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 15_000 });
}

describe('Phone existing deployer public media preparation', () => {
  it('renders valid TURN TLS YAML, preserves credentials/control and repeats from persisted input', () => {
    const f = fixture('persist');
    const first = run(f.env);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('configuration prepared only');
    expect(first.stdout + first.stderr).not.toContain('test-secret-withheld');
    const file = join(f.conf, 'livekit-server.yaml');
    const config = parse(readFileSync(file, 'utf8'));
    expect(config.turn).toMatchObject({ enabled: true, tls_port: 7894,
      domain: 'turn.example.com', cert_file: certPath, key_file: keyPath });
    // TURN is TLS-only: a UDP port would issue turn:<home IP> to public clients (WI-10006616).
    expect(config.turn).not.toHaveProperty('udp_port');
    // No public edge configured: loopback + LAN keep co-located ICE off the hairpin.
    expect(config.rtc.interfaces.includes).toEqual(['lo', 'test0']);
    expect(config.keys).toEqual({ 'test-key': 'test-secret-withheld' });
    expect(parse(readFileSync(join(f.conf, 'livekit-sip.yaml'), 'utf8')).ws_url).toBe('ws://127.0.0.1:7890');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = readFileSync(join(f.conf, 'livekit.env'), 'utf8');
    expect(stored).toContain('PHONE_WORKER_SECRET=test-worker-retained');
    expect(stored).toContain('PHONE_LIVEKIT_URL=ws://127.0.0.1:7890');
    const before = readFileSync(file, 'utf8');
    const second = run({ PHONE_CONFIG_DIR: f.conf, PHONE_NODE_BIN: process.execPath,
      PHONE_LAN_IFACE: 'test0', PATH: process.env.PATH });
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  // WI-10006708 / P-002 R-13: LiveKit hands its candidates to every participant, so with the
  // public edge the rendered config may list ONLY the tunnel (measured live: the box LAN
  // address 192.168.4.34 reached public browsers while lo + LAN were still listed).
  it('advertises only the edge tunnel, never LAN or loopback, once the public edge is configured', () => {
    const f = fixture('edge-only-candidates');
    const result = run({ ...f.env, PHONE_EDGE_IFACE: 'phedge0' });
    expect(result.status, result.stderr).toBe(0);
    const config = parse(readFileSync(join(f.conf, 'livekit-server.yaml'), 'utf8'));
    expect(config.rtc.interfaces.includes).toEqual(['phedge0']);
    expect(config.rtc.use_external_ip).toBe(true);
    // The box-local DNAT exempts exactly this relay range (edge-config TURN_RELAY_RANGE).
    expect(config.turn).toMatchObject({ relay_range_start: 30000, relay_range_end: 40000 });
    expect(readFileSync(join(f.conf, 'livekit.env'), 'utf8')).toContain('PHONE_EDGE_IFACE=phedge0');
  });

  it('refuses a private WSS origin before any configuration write', () => {
    const f = fixture('unsafe');
    const result = run({ ...f.env, PHONE_LIVEKIT_PUBLIC_URL: 'wss://localhost' });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.conf, 'livekit.env'), 'utf8')).toBe(f.original);
    expect(result.stdout).not.toContain('rendered livekit-server.yaml');
  });

  it('refuses mismatched or expiring certificates and missing hosted TURN', () => {
    expect(() => validateCertificate(readFileSync(certPath), readFileSync(otherKey), 'turn.example.com')).toThrow('do not match');
    expect(() => validateCertificate(readFileSync(shortCert), readFileSync(otherKey), 'turn.example.com')).toThrow('seven days');
    expect(() => validateCertificate(readFileSync(certPath), readFileSync(keyPath), 'wrong.example.com')).toThrow('hostname');
    expect(() => mediaConfig({ PHONE_LIVEKIT_PUBLIC_URL: 'wss://voice.example.com' }, true)).toThrow();
    expect(mediaConfig({}, false).turnYaml).toBe('  tls_port: 0');
  });

  it('honors caller overrides after sourcing existing coordinates', () => {
    const f = fixture('override');
    expect(run(f.env).status).toBe(0);
    expect(run({ ...f.env, PHONE_LIVEKIT_PUBLIC_URL: 'wss://new.example.com' }).status).toBe(0);
    expect(readFileSync(join(f.conf, 'livekit.env'), 'utf8')).toContain('wss://new.example.com');
  });

  it('rejects a preparation credential rotation without modifying the credential record', () => {
    const f = fixture('rotation');
    expect(run(f.env, ['--render-only', '--rotate-secret']).status).not.toBe(0);
    expect(readFileSync(join(f.conf, 'livekit.env'), 'utf8')).toBe(f.original);
  });

  it('rejects an invalid remote preflight with no config file and no service/key side effects', () => {
    const result = run({ PHONE_CONFIG_DIR: join(root, 'absent'), PHONE_NODE_BIN: process.execPath,
      PHONE_LIVEKIT_PUBLIC_URL: 'wss://localhost', PATH: process.env.PATH }, ['--preflight']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('public DNS hostname');
    expect(result.stdout).not.toContain('Credentials');
  });

  it('checks real TLS trust and hostname against a pinned address (isolated laboratory evidence)', async () => {
    const cert = readFileSync(certPath), key = readFileSync(keyPath);
    const server = createServer({ key, cert });
    server.on('tlsClientError', () => {});
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing isolated TLS listener');
    try {
      const params = { hostname: 'turn.example.com', address: '127.0.0.1', port: address.port, timeoutMs: 1000 };
      await expect(checkTlsEndpoint({ ...params, ca: cert })).resolves.toMatchObject({ hostname: 'turn.example.com' });
      await expect(checkTlsEndpoint(params)).rejects.toThrow('trust');
      await expect(checkTlsEndpoint({ ...params, hostname: 'wrong.example.com', ca: cert })).rejects.toThrow('trust');
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});

describe('Phone deployer read-only local status', () => {
  it('reports source-scoped readiness, fails on an inactive worker and never prints secrets', async () => {
    const conf = join(root, 'readiness-status'); mkdirSync(conf);
    const media = createHttpServer((_req, res) => res.end('ready'));
    // The fake sidecar mirrors the real /internal/* guard: armed ⇒ an
    // unauthenticated request is refused 401; booted without the secret ⇒ 503.
    let ingestArmed = true;
    const sidecar = createHttpServer((req, res) => {
      res.statusCode = req.url === '/api/health' ? 200
        : req.url?.startsWith('/internal/') ? (ingestArmed ? 401 : 503) : 404;
      res.end('ready');
    });
    await Promise.all([
      new Promise<void>(resolve => media.listen(0, '127.0.0.1', resolve)),
      new Promise<void>(resolve => sidecar.listen(0, '127.0.0.1', resolve)),
    ]);
    const mediaAddr = media.address(), sidecarAddr = sidecar.address();
    if (!mediaAddr || typeof mediaAddr === 'string' || !sidecarAddr || typeof sidecarAddr === 'string') {
      throw new Error('fixture listeners unavailable');
    }
    writeFileSync(join(conf, 'livekit.env'), `PHONE_LIVEKIT_URL=ws://127.0.0.1:${mediaAddr.port}\nPHONE_LIVEKIT_API_SECRET=private-fixture-secret\n` +
      'PHONE_WORKER_SECRET=private-worker-fixture\n', { mode: 0o600 });
    writeFileSync(join(conf, 'systemctl'), '#!/bin/sh\ncase "$3" in papercusp-phone-worker.service) [ "$PHONE_WORKER_DOWN" != 1 ] || exit 3;; esac\nprintf "active\\n"\n', { mode: 0o700 });
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PHONE_'))),
      PHONE_CONFIG_DIR: conf, PHONE_NODE_BIN: process.execPath,
      PHONE_SIDECAR_URL: `ws://127.0.0.1:${sidecarAddr.port}`,
      PATH: `${conf}:${process.env.PATH ?? ''}`,
    };
    try {
      const runStatus = (input: NodeJS.ProcessEnv) => promisify(execFile)('bash', [deploy, '--status'], {
        env: input, timeout: 15_000,
      }).then(({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
        error => ({ status: error.code, stdout: error.stdout, stderr: error.stderr }));
      const ready = await runStatus(env);
      expect(ready.status, JSON.stringify(ready)).toBe(0);
      expect(JSON.parse(ready.stdout)).toMatchObject({ ok: true, publicPhoneVerified: false });
      const stopped = await runStatus({ ...env, PHONE_WORKER_DOWN: '1' });
      expect(stopped.status).toBe(1);
      expect(JSON.parse(stopped.stdout).checks).toContainEqual({ component: 'worker', ready: false });
      // WI-10006645: every unit active and both health endpoints green, but the
      // running sidecar booted without the worker secret.
      ingestArmed = false;
      const ingestDisabled = await runStatus(env);
      ingestArmed = true;
      expect(ingestDisabled.status).toBe(1);
      expect(JSON.parse(ingestDisabled.stdout)).toMatchObject({ ok: false,
        alerts: [expect.objectContaining({ component: 'worker-ingest' })] });
      const armedEnv = readFileSync(join(conf, 'livekit.env'), 'utf8');
      writeFileSync(join(conf, 'livekit.env'), armedEnv.replace(/^PHONE_WORKER_SECRET=.*\n/m, ''), { mode: 0o600 });
      const secretMissing = await runStatus(env);
      writeFileSync(join(conf, 'livekit.env'), armedEnv, { mode: 0o600 });
      expect(secretMissing.status).toBe(1);
      expect(JSON.parse(secretMissing.stdout).checks).toContainEqual({ component: 'worker-ingest', ready: false });
      const rotatingCert = join(conf, 'rotation certificate.pem');
      const rotatingKey = join(conf, 'rotation private.pem');
      copyFileSync(certPath, rotatingCert); copyFileSync(keyPath, rotatingKey);
      const hosted = `PHONE_LIVEKIT_PUBLIC_URL=wss://voice.example.com\nPHONE_TURN_DOMAIN=turn.example.com\n` +
        `PHONE_TURN_CERT_FILE=${rotatingCert.replaceAll(' ', '\\ ')}\n` +
        `PHONE_TURN_KEY_FILE=${rotatingKey.replaceAll(' ', '\\ ')}\n`;
      const localEnv = readFileSync(join(conf, 'livekit.env'), 'utf8');
      writeFileSync(join(conf, 'livekit.env'), localEnv + hosted, { mode: 0o600 });
      const validCertificate = await runStatus(env);
      expect(validCertificate.status, validCertificate.stderr).toBe(0);
      expect(JSON.parse(validCertificate.stdout)).toMatchObject({
        ok: true, turnCertificateVerified: true,
        checks: expect.arrayContaining([{ component: 'turn-certificate', ready: true }]),
        publicPhoneVerified: false,
      });
      copyFileSync(shortCert, rotatingCert); copyFileSync(otherKey, rotatingKey);
      const renewalDue = await runStatus(env);
      expect(renewalDue.status).toBe(1);
      expect(JSON.parse(renewalDue.stdout)).toMatchObject({
        ok: false, turnCertificateVerified: false,
        checks: expect.arrayContaining([{ component: 'turn-certificate', ready: false }]),
      });
      copyFileSync(certPath, rotatingCert); copyFileSync(keyPath, rotatingKey);
      const renewed = await runStatus(env);
      expect(renewed.status, renewed.stderr).toBe(0);
      expect(JSON.parse(renewed.stdout)).toMatchObject({ ok: true, turnCertificateVerified: true });
      writeFileSync(join(conf, 'livekit.env'), localEnv + 'PHONE_LIVEKIT_PUBLIC_URL=wss://voice.example.com\n', { mode: 0o600 });
      const missingTurn = await runStatus(env);
      expect(missingTurn.status).toBe(1);
      expect(JSON.parse(missingTurn.stdout).checks).toContainEqual({ component: 'turn-certificate', ready: false });
      const outputs = [ready, stopped, ingestDisabled, secretMissing, validCertificate, renewalDue, renewed, missingTurn]
        .map(result => result.stdout + result.stderr).join('\n');
      expect(outputs).not.toContain('private-fixture-secret');
      expect(outputs).not.toContain('private-worker-fixture');
      expect(outputs).not.toContain(rotatingKey);
      expect(outputs).not.toContain(rotatingCert);
    } finally {
      await Promise.all([media, sidecar].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });
});

// WI-10006645: deploy.sh minted the LiveKit pair and the portal secret but never
// PHONE_WORKER_SECRET, so the hosted worker ran with sidecar reporting DISABLED.
describe('Phone deployer worker-ingest secret', () => {
  const workerLine = /^PHONE_WORKER_SECRET=([0-9a-f]{64})$/m;
  function ensure(conf: string, extra: NodeJS.ProcessEnv = {}) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PHONE_')));
    // Sourcing loads the definitions only (the script returns before any action).
    // `set --` first: a sourced file inherits the caller's positional arguments.
    return spawnSync('bash', ['-c', 'd="$1"; set --; source "$d"; ROTATE="${TEST_ROTATE:-0}"; ensure_worker_secret',
      '_', deploy], {
      env: { ...base, PHONE_CONFIG_DIR: conf, ...extra }, encoding: 'utf8', timeout: 15_000,
    });
  }
  function conf(name: string, content: string) {
    const dir = join(root, name); mkdirSync(dir);
    writeFileSync(join(dir, 'livekit.env'), content, { mode: 0o600 });
    return dir;
  }
  const shared = 'PHONE_LIVEKIT_API_KEY=k\nPHONE_LIVEKIT_API_SECRET=s\nDEEPGRAM_API_KEY=vendor-retained\n' +
    'PHONE_TURN_CERT_FILE=/etc/certs/turn\\ cert.pem\n';

  it('mints once into livekit.env, preserves every other line, stays 0600 and never prints it', () => {
    const dir = conf('worker-secret-mint', shared);
    const first = ensure(dir);
    expect(first.status, first.stderr).toBe(0);
    const minted = readFileSync(join(dir, 'livekit.env'), 'utf8');
    const secret = minted.match(workerLine)?.[1];
    expect(secret, minted).toBeDefined();
    expect(minted.replace(workerLine, '').replace(/\n+$/, '\n')).toBe(shared);
    expect(statSync(join(dir, 'livekit.env')).mode & 0o777).toBe(0o600);
    expect(first.stdout + first.stderr).not.toContain(secret!);
    const again = ensure(dir);
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(join(dir, 'livekit.env'), 'utf8')).toBe(minted);
  });

  it('treats a blank line as missing and ignores a value exported only in the caller shell', () => {
    const blank = conf('worker-secret-blank', `${shared}PHONE_WORKER_SECRET=\n`);
    expect(ensure(blank).status).toBe(0);
    expect(readFileSync(join(blank, 'livekit.env'), 'utf8')).toMatch(workerLine);
    const shellOnly = conf('worker-secret-shell-only', shared);
    expect(ensure(shellOnly, { PHONE_WORKER_SECRET: 'f'.repeat(64) }).status).toBe(0);
    const persisted = readFileSync(join(shellOnly, 'livekit.env'), 'utf8').match(workerLine)?.[1];
    expect(persisted).toBeDefined();
    expect(persisted).not.toBe('f'.repeat(64));
  });

  it('rotates only under --rotate-secret, keeping the vendor credentials', () => {
    const dir = conf('worker-secret-rotate', `${shared}PHONE_WORKER_SECRET=${'a'.repeat(64)}\n`);
    expect(ensure(dir).status).toBe(0);
    expect(readFileSync(join(dir, 'livekit.env'), 'utf8')).toContain(`PHONE_WORKER_SECRET=${'a'.repeat(64)}`);
    expect(ensure(dir, { TEST_ROTATE: '1' }).status).toBe(0);
    const rotated = readFileSync(join(dir, 'livekit.env'), 'utf8');
    expect(rotated.match(workerLine)?.[1]).not.toBe('a'.repeat(64));
    expect(rotated).toContain('DEEPGRAM_API_KEY=vendor-retained');
  });

  it('a full deploy arms it before units start; render-only never mints it', () => {
    const source = readFileSync(deploy, 'utf8');
    const call = source.search(/^\s*ensure_worker_secret$/m);
    expect(call).toBeGreaterThan(source.indexOf('step "Credentials"'));
    expect(call).toBeLessThan(source.indexOf('step "Start"'));
    const f = fixture('worker-secret-render-only');
    const withoutWorker = f.original.replace(/^PHONE_WORKER_SECRET=.*\n/m, '');
    writeFileSync(join(f.conf, 'livekit.env'), withoutWorker, { mode: 0o600 });
    const result = run(f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.conf, 'livekit.env'), 'utf8')).not.toMatch(/^PHONE_WORKER_SECRET=/m);
    expect(result.stdout).toContain('PHONE_WORKER_SECRET absent');
  });
});

describe('Phone candidate artifact pin', () => {
  it('pins a clean Phone revision and exact host artifact bytes before any live convergence', () => {
    const conf = join(root, 'artifact-pin'); mkdirSync(conf);
    const phone = join(conf, 'phone-source');
    const worker = join(phone, 'worker'), sidecar = join(phone, 'apps', 'sidecar');
    mkdirSync(worker, { recursive: true }); mkdirSync(sidecar, { recursive: true });
    writeFileSync(join(worker, 'entry.js'), 'old reviewed Phone worker');
    writeFileSync(join(sidecar, 'entry.js'), 'old reviewed Phone sidecar');
    const livekit = join(conf, 'livekit-server'), sip = join(conf, 'livekit-sip');
    writeFileSync(livekit, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(sip, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(conf, 'git'), `#!/bin/sh
case "$3:$4" in
  rev-parse:--show-toplevel) printf '%s\\n' "$PHONE_TEST_ROOT" ;;
  rev-parse:HEAD) printf '%s\\n' "$PHONE_TEST_REVISION" ;;
  status:--porcelain) [ -z "$PHONE_TEST_DIRTY" ] || printf '%s\\n' "$PHONE_TEST_DIRTY" ;;
  archive:--format=tar) tar -C "$PHONE_TEST_ROOT" -cf - worker apps/sidecar ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    const original = 'PHONE_LIVEKIT_API_SECRET=private-pin-fixture-secret\n';
    writeFileSync(join(conf, 'livekit.env'), original, { mode: 0o600 });
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PHONE_'))),
      PHONE_CONFIG_DIR: conf, PHONE_WORKER_DIR: worker, PHONE_SIDECAR_DIR: sidecar,
      PHONE_LIVEKIT_BIN: livekit, PHONE_SIP_BIN: sip, PHONE_NODE_BIN: process.execPath,
      PHONE_TEST_ROOT: phone, PHONE_TEST_REVISION: 'a'.repeat(40),
      PATH: `${conf}:${process.env.PATH ?? ''}`,
    };
    const pinned = run(env, ['--pin-artifacts']);
    expect(pinned.status, pinned.stderr).toBe(0);
    const manifest = join(conf, 'artifacts.sha256');
    expect(statSync(manifest).mode & 0o777).toBe(0o600);
    expect(readFileSync(manifest, 'utf8')).toContain(`PHONE_ARTIFACT_PIN_V1 ${'a'.repeat(40)}`);
    expect(readFileSync(manifest, 'utf8')).not.toContain('private-pin-fixture-secret');
    expect(run(env, ['--verify-artifacts']).status).toBe(0);
    const saved = run(env, ['--stage-rollback']);
    expect(saved.status, saved.stderr).toBe(0);
    const rollback = join(conf, 'rollback');
    expect(statSync(rollback).mode & 0o777).toBe(0o700);
    expect(statSync(join(rollback, 'source.tar')).mode & 0o777).toBe(0o600);
    expect(run(env, ['--stage-rollback']).status).toBe(1);
    expect(run(env, ['--rollback-drill']).status).toBe(0);
    expect(run({ ...env, PHONE_TEST_DIRTY: ' M apps/sidecar/src/server.ts' }, ['--verify-artifacts']).status).toBe(1);
    const completePin = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, completePin.split('\n').slice(0, 3).join('\n') + '\n');
    expect(run(env, ['--verify-artifacts']).status).toBe(1);
    writeFileSync(manifest, completePin);
    expect(run({ ...env, PHONE_TEST_REVISION: 'b'.repeat(40) }, ['--verify-artifacts']).status).toBe(1);
    writeFileSync(livekit, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
    expect(run(env, ['--verify-artifacts']).status).toBe(1);
    expect(run({ ...env, PHONE_TEST_REVISION: 'b'.repeat(40) }, ['--rollback-drill']).status).toBe(0);
    const receipt = join(rollback, 'hashes.sha256');
    const completeReceipt = readFileSync(receipt, 'utf8');
    writeFileSync(receipt, completeReceipt.split('\n').slice(0, 2).join('\n') + '\n');
    expect(run(env, ['--rollback-drill']).status).toBe(1);
    writeFileSync(receipt, completeReceipt);
    writeFileSync(join(rollback, 'source.tar'), 'corrupted');
    expect(run(env, ['--rollback-drill']).status).toBe(1);
    writeFileSync(join(rollback, 'files', '0'), 'corrupted');
    expect(run(env, ['--rollback-drill']).status).toBe(1);
    const refused = run(env, []);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('artifact bytes differ from pin');
    expect(readFileSync(join(conf, 'livekit.env'), 'utf8')).toBe(original);
    expect(refused.stdout + refused.stderr).not.toContain('private-pin-fixture-secret');
    expect(saved.stdout + saved.stderr).not.toContain('private-pin-fixture-secret');
  });
});
