/** Disposable native-device HTTPS acceptance, inside with-test-pg's operator-api profile.
 * Reuses the maintained protected listener and own-tunnel provisioning/removal contract.
 * node scripts/with-test-pg.mjs --isolated-runtime=operator-api -- node --import tsx
 *   packages/operator-core/lib/native-device-fixture.ts <private evidence dir> <cert.pem> [seconds]
 * The receipt is public-safe; pair-payload.json is private input and is removed on exit.
 * The advertised-hostname journey takes an empty cert argument and offlineSeconds=0.
 * Its caller must lease and delegate only the existing /api/device provider rule
 * to ROUTE_READY.ingressTarget, then verify exact restoration before stopping it.
 * Readiness requires the private one-shot token to be redeemed through that route.
 * Existing temporary-hostname native cases keep their original safety guards.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Resolver, resolve4, resolveNs } from 'node:dns/promises';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, fsyncSync, fstatSync, readSync, readFileSync, renameSync, unlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareApi, type CloudflareApi, type CloudflareZone } from './own-tunnel/cloudflare-api';
import { assertPort, parseArgoTunnelCert, tunnelCnameTarget } from './own-tunnel/config';
import { provisionCloudflareTunnel, removeCloudflareTunnel, type RemovalTarget } from './own-tunnel/provision';
import { isCliEntry } from './util/cli-entry';
import type { WorkspaceRegistry } from './workspace-registry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

export function saveFixtureReceipt(evidence: string, receipt: Record<string, unknown>): void {
  const path = resolve(evidence, 'runtime.json');
  const data = JSON.stringify(receipt, null, 2) + '\n';
  // Follow writeRegistry's unique sibling + rename convention: readers see a
  // complete old or new generation, including during readiness/cleanup updates.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function fixtureFailure(error: unknown) {
  const detail = error instanceof Error ? error : new Error(String(error));
  const code = (value: unknown) => value && typeof value === 'object' && 'code' in value
    ? String(value.code) : undefined;
  return { message: detail.message, code: code(detail),
    causeCode: code(detail.cause), causeMessage: detail.cause instanceof Error ? detail.cause.message : undefined };
}

/** Keep public receipts useful without copying private operator logs or error text. */
export interface FixtureHostReadiness {
  kind: 'listener-pending' | 'listener-timeout' | 'host-exited' | 'request-startup-withheld' | 'fixture-stopped';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  logState: 'read' | 'missing' | 'unreadable';
  pendingMigrations?: string[];
  pendingCount?: number;
  failureCode?: string;
}

function fixtureHostReadiness(host: Pick<ChildProcess, 'exitCode' | 'signalCode'>, logPath: string,
  kind: FixtureHostReadiness['kind'], error?: unknown): FixtureHostReadiness {
  let tail = '', logState: FixtureHostReadiness['logState'] = 'read';
  let fd: number | undefined;
  try {
    fd = openSync(logPath, 'r');
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 32 * 1024));
    tail = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, size - buffer.length)).toString('utf8');
  } catch (failure) {
    logState = (failure as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  } finally { if (fd !== undefined) closeSync(fd); }
  const diagnostic: FixtureHostReadiness = { kind, exitCode: host.exitCode, signal: host.signalCode, logState };
  const withheld = tail.match(/REQUEST STARTUP WITHHELD: ([^\r\n]*)/);
  if (host.exitCode !== null || host.signalCode !== null) diagnostic.kind = 'host-exited';
  else if (withheld) {
    diagnostic.kind = 'request-startup-withheld';
    // The writer is boot-migration-gate.ts. Only SQL basenames and a count leave
    // the private log; tokens, connection strings and arbitrary errors never do.
    diagnostic.pendingMigrations = [...new Set(withheld[1]!.match(/\b[0-9]{1,8}-[A-Za-z0-9_-]{1,160}\.sql\b/g) ?? [])].slice(0, 20);
    const count = withheld[1]!.match(/^(\d{1,8}) migration\(s\) remain pending:/);
    if (count) diagnostic.pendingCount = Number(count[1]);
  }
  const failure = fixtureFailure(error);
  const code = failure.causeCode ?? failure.code;
  if (code && /^[A-Z0-9_]{1,64}$/.test(code)) diagnostic.failureCode = code;
  return diagnostic;
}

export async function waitForFixtureHost(host: Pick<ChildProcess, 'exitCode' | 'signalCode'>, logPath: string,
  probe: () => Promise<void>, options: {
    timeoutMs: number; pollMs: number; stopped?: () => boolean;
    record: (diagnostic: FixtureHostReadiness) => void;
    now?: () => number; pause?: (ms: number) => Promise<void>;
  }) {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const inspect = (error?: unknown) => {
    const diagnostic = fixtureHostReadiness(host, logPath,
      options.stopped?.() ? 'fixture-stopped' : now() >= deadline ? 'listener-timeout' : 'listener-pending', error);
    options.record(diagnostic);
    if (diagnostic.kind !== 'listener-pending') {
      throw Object.assign(new Error('Fixture host readiness: ' + diagnostic.kind), { diagnostic });
    }
  };
  let lastFailure: unknown;
  for (;;) {
    inspect(lastFailure);
    try { await probe(); return; }
    catch (error) { lastFailure = error; inspect(error); }
    await (options.pause ?? delay)(options.pollMs);
  }
}

export async function verifyFixtureZone(zone: CloudflareZone, readNs = resolveNs) {
  assert(zone.status === 'active' && zone.paused === false, 'Fixture requires an active unpaused DNS zone');
  assert(zone.name_servers?.length, 'Fixture zone must name authoritative servers');
  const delegated = await readNs(zone.name);
  const normalized = (names: ReadonlyArray<string>) => names.map(n => n.toLowerCase().replace(/\.$/, '')).sort();
  assert.deepEqual(normalized(delegated), normalized(zone.name_servers), 'Fixture DNS delegation mismatch');
}

/** Do not poison a recursive resolver with NXDOMAIN before the new record is published. */
export async function waitForFixtureDns(hostname: string, nameservers: ReadonlyArray<string>, options: {
  read?: () => Promise<string[]>; pause?: () => Promise<void>; now?: () => number;
  onFailure?: (error: unknown) => void;
} = {}) {
  const now = options.now ?? Date.now;
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  if (!options.read) resolver.setServers((await Promise.all(nameservers.map(ns => resolve4(ns)))).flat());
  const read = options.read ?? (() => resolver.resolve4(hostname));
  const deadline = now() + 120_000;
  for (;;) {
    try {
      const addresses = await read();
      assert(addresses.length > 0, 'Authoritative DNS has no fixture address');
      return addresses;
    } catch (error) {
      options.onFailure?.(error);
      if (now() >= deadline) throw error;
      await (options.pause ?? (() => delay(1000)))();
    }
  }
}

export function fixtureIdentity(env: NodeJS.ProcessEnv) {
  assert(/^test-runtime-[a-zA-Z0-9-]+$/.test(env.PAPERCUSP_WORKSPACE_ID ?? ''), 'Disposable workspace required');
  for (const key of ['PAPERCUSP_BACKGROUND_WORKERS', 'PAPERCUSP_DBOS_ENABLE', 'PAPERCUSP_DBOS_ROUTINES'])
    assert.equal(env[key], '0', `${key} must be disabled`);
  assert.equal(env.PAPERCUSP_POT_HOME_SLUG, env.PAPERCUSP_WORKSPACE_ID, 'Disposable install identity required');
  assert.equal(env.PAPERCUSP_ALLOW_REMOTE_ADMIN, undefined, 'Remote admin must not be enabled');
  assert(env.HOME && env.PAPERCUSP_HOME && env.PAPERCUSP_SKIP_PG_DISCOVERY === '1', 'Private HOME and PG required');
  const base = new URL(env.PAPERCUSP_OPERATOR_URL ?? '');
  assert(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.pathname === '/', 'Private loopback operator required');
  assert(base.port && ![3070, 3170, 3055].includes(Number(base.port)) &&
    !base.username && !base.password && !base.search && !base.hash, 'Private child operator port required');
  assert.equal(env.PAPERCUSP_HONO_PORT, base.port, 'Private child operator port must match');
  const pgPort = assertPort(Number(env.PAPERCUSP_PG_PORT));
  assert(pgPort !== 5432, 'Owned isolated Postgres required');
  const pg = new URL(env.PAPERCUSP_TEST_PG_ADMIN_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(pg.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(pg.hostname) &&
    pg.port === String(pgPort) && pg.username && pg.pathname.slice(1), 'Maintained isolated-runtime Postgres receipt required');
  const ingressPort = assertPort(Number(env.PAPERCUSP_EXTERNAL_INGRESS_PORT));
  assert(ingressPort !== Number(base.port) && ![3070, 3170, 3055].includes(ingressPort), 'Separate protected ingress required');
  return { workspaceId: env.PAPERCUSP_WORKSPACE_ID!, base: base.origin, ingressPort };
}

export async function verifyProtectedIngress(base: string, doFetch: typeof fetch = fetch) {
  const statuses: Record<string, number> = {};
  for (const path of ['/api/health', '/api/workspaces', '/api/device/desktop/mint-pair-token']) {
    const response = await doFetch(base + path, {
      method: path.endsWith('mint-pair-token') ? 'POST' : 'GET',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      ...(path.endsWith('mint-pair-token') ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(5000),
    });
    statuses[path] = response.status;
    assert([401, 403, 404].includes(response.status), `Protected ingress exposed ${path}: HTTP ${response.status}`);
    await response.arrayBuffer();
  }
  const heartbeat = await doFetch(base + '/api/device/heartbeat', {
    method: 'POST', signal: AbortSignal.timeout(5000),
  });
  statuses['/api/device/heartbeat'] = heartbeat.status;
  assert.equal(heartbeat.status, 401, 'Device heartbeat must require a JWT');
  await heartbeat.arrayBuffer();
  return statuses;
}

/** Prove an externally delegated advertised route reaches this private fixture.
 * A shared operator must refuse the private one-shot token. No shared credentials,
 * registry writes, attention reads or workspace switches are used by this probe.
 * The caller owns delegation/restoration of the provider route; this helper only
 * mints and revokes a probe device in the disposable database.
 */
export async function verifyAdvertisedFixtureRoute(env = process.env, doFetch: typeof fetch = fetch) {
  const identity = fixtureIdentity(env);
  const publicBase = 'https://api.papercuspai.com';
  const call = (base: string, path: string, init: RequestInit = {}) => doFetch(base + path, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const boundary: Record<string, number> = {};
  for (const [path, method, expected] of [
    ['/api/device/desktop/mint-pair-token', 'POST', 404],
    ['/api/device/desktop/devices', 'GET', 404],
    ['/api/device/heartbeat', 'POST', 401],
  ] as const) {
    const response = await call(publicBase, path, { method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    boundary[path] = response.status;
    await response.arrayBuffer();
    assert.equal(response.status, expected, 'Advertised device route boundary mismatch');
  }
  const minted = await call(identity.base, '/api/device/desktop/mint-pair-token', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: identity.workspaceId }),
  });
  assert.equal(minted.status, 200, 'Private route-probe mint failed');
  const { qrPayload } = await minted.json();
  assert(qrPayload?.server === publicBase && qrPayload.workspaceId === identity.workspaceId &&
    typeof qrPayload.pairToken === 'string' && qrPayload.pairToken, 'Private route-probe payload mismatch');
  let deviceId: string | undefined;
  try {
    const paired = await call(publicBase, '/api/device/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: qrPayload.pairToken, deviceLabel: 'Advertised route isolation probe' }),
    });
    assert.equal(paired.status, 200, 'Advertised route does not reach the disposable fixture');
    const result = await paired.json();
    assert(typeof result.deviceId === 'string' && /^[0-9a-f-]{36}$/i.test(result.deviceId),
      'Route-probe device identity missing');
    deviceId = result.deviceId;
    assert.equal(result.workspaceId, identity.workspaceId, 'Route-probe workspace mismatch');
    assert(typeof result.deviceToken === 'string' && result.deviceToken, 'Route-probe device token missing');
    const local = await call(identity.base, '/api/device/desktop/devices');
    assert.equal(local.status, 200, 'Private route-probe device lookup failed');
    const localDevices = await local.json();
    assert(Array.isArray(localDevices.devices) && localDevices.devices.some((d: { device_id?: string; workspace_id?: string }) =>
      d.device_id === deviceId && d.workspace_id === identity.workspaceId), 'Public pair was not created in the private fixture');
    const runtime = await call(publicBase, '/api/device/runtime-config', {
      headers: { authorization: 'Bearer ' + result.deviceToken },
    });
    assert.equal(runtime.status, 200, 'Advertised route-probe authorization failed');
    assert.equal((await runtime.json()).workspaceId, identity.workspaceId, 'Advertised route-probe runtime mismatch');
    return { publicBase, workspaceId: identity.workspaceId, boundary, privatePairVerified: true };
  } finally {
    if (deviceId) {
      const revoked = await call(identity.base, '/api/device/desktop/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' });
      await revoked.arrayBuffer();
      assert.equal(revoked.status, 200, 'Private route-probe cleanup failed');
    }
  }
}

/** Recover partially provisioned owned resources; never delete a tunnel/record by a loose prefix. */
export async function cleanupFixtureTunnel(api: CloudflareApi, target: RemovalTarget & { tunnelName: string }) {
  const tunnels = await api.listTunnelsByName(target.accountId, target.tunnelName);
  const owned = tunnels.filter(t => t.name === target.tunnelName && !t.deleted_at);
  assert(owned.length <= 1, 'Ambiguous fixture tunnel ownership');
  if (owned.length) {
    assert.equal(owned[0]!.id, target.tunnelId, 'Fixture tunnel identity changed');
    await removeCloudflareTunnel(api, target);
  }
  const remaining = await api.listDnsRecords(target.zoneId, target.hostname);
  assert(!remaining.some(r => r.type === 'CNAME' && r.content === tunnelCnameTarget(target.tunnelId)), 'Owned fixture DNS remains');
  const after = await api.listTunnelsByName(target.accountId, target.tunnelName);
  assert(!after.some(t => t.id === target.tunnelId && !t.deleted_at), 'Owned fixture tunnel remains');
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  await new Promise<void>(done => child.once('exit', () => done()));
  clearTimeout(kill);
}

/** Stop the exact owned operator, retain its private DB/signing identity, then replace it. */
export async function interruptFixtureHost(child: ChildProcess, restart: () => Promise<ChildProcess>,
  seconds: number, record: (value: Record<string, unknown>) => void,
  env = process.env, pause = delay) {
  fixtureIdentity(env);
  assert(Number.isInteger(seconds) && seconds >= 30 && seconds <= 120, 'Bounded operator interruption required');
  assert(child.pid && child.exitCode === null && child.signalCode === null, 'Owned operator must be live');
  const stoppedPid = child.pid;
  await stopChild(child);
  assert(child.exitCode !== null || child.signalCode !== null, 'Owned operator must exit before recovery');
  record({ stoppedPid, stoppedAt: new Date().toISOString(), exitCode: child.exitCode, signal: child.signalCode });
  await pause(seconds * 1000);
  const restored = await restart();
  assert(restored.pid && restored.pid !== stoppedPid && restored.exitCode === null && restored.signalCode === null,
    'Recovery must start a different live operator process');
  record({ restoredPid: restored.pid, restoredAt: new Date().toISOString() });
  return restored;
}

/** Expire only an unused token in this request-only fixture's private database. */
export async function expireFixturePair(pairToken: string, workspaceId: string, env = process.env) {
  const identity = fixtureIdentity(env);
  assert.equal(workspaceId, identity.workspaceId, 'Pair token must belong to this fixture');
  assert(pairToken.length > 0, 'Pair token is required');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const expiresAt = Date.now() - 1000;
  const rows = await sql`UPDATE harness_shared.mobile_pair_tokens SET expires_at_ms = ${expiresAt}
    WHERE pair_token = ${pairToken} AND workspace_id = ${workspaceId} AND consumed = false
    RETURNING expires_at_ms`;
  assert.equal(rows.length, 1, 'Exactly one unused owned pairing token must expire');
  assert.equal(Number(rows[0]!.expires_at_ms), expiresAt);
  return expiresAt;
}

/** Add a second workspace only to the maintained, initially singleton private registry. */
export function fixtureSwitchRegistry(registry: WorkspaceRegistry, env = process.env): WorkspaceRegistry {
  const { workspaceId } = fixtureIdentity(env);
  assert.equal(registry.current, workspaceId, 'Private current workspace mismatch');
  assert.equal(registry.workspaces.length, 1, 'Workspace-switch fixture requires an untouched private registry');
  assert.equal(registry.workspaces[0]!.id, workspaceId, 'Private workspace registry mismatch');
  return { ...registry, workspaces: [
    { ...registry.workspaces[0]!, name: 'Native workspace A' },
    { id: workspaceId + '-other', name: 'Native workspace B', createdAt: Date.now() },
  ] };
}

export async function prepareFixtureWorkspaceSwitch() {
  const { readRegistry, writeRegistry, workspacesRoot } = await import('./workspace-registry');
  const registry = fixtureSwitchRegistry(readRegistry());
  assert.equal(resolve(workspacesRoot()), resolve(dirname(process.env.HOME!), 'workspaces'),
    'Only the maintained private runtime workspace root may be changed');
  const { insertDevice } = await import('./device-store');
  const markers = [];
  for (const [index, workspace] of registry.workspaces.entries()) {
    mkdirSync(resolve(workspacesRoot(), workspace.id), { recursive: true, mode: 0o700 });
    const deviceId = randomUUID();
    const label = `Native workspace ${index === 0 ? 'A' : 'B'} marker`;
    await insertDevice({ deviceId, workspaceId: workspace.id, deviceLabel: label,
      userEmail: 'native-fixture@example.invalid' });
    markers.push({ workspaceId: workspace.id, deviceId, label });
  }
  writeRegistry(registry);
  return { workspaces: registry.workspaces, markers };
}

export async function runNativeDeviceFixture(evidencePath: string, certPath: string, seconds = 1800,
  interruptionSeconds = Number(process.env.PAPERCUSP_NATIVE_OFFLINE_SECONDS ?? '0'), workspaceSwitch = false,
  deviceExpiry = false, advertisedHostname = false) {
  const identity = fixtureIdentity(process.env); // All preconditions precede any external write.
  assert(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600, 'Bounded lifetime required');
  assert(interruptionSeconds === 0 || (Number.isInteger(interruptionSeconds) && interruptionSeconds >= 30 &&
    interruptionSeconds <= 120), 'Offline fixture interval must be 30 to 120 seconds');
  assert(!workspaceSwitch || interruptionSeconds === 0, 'Workspace-switch and outage acceptance require separate fixtures');
  assert(!deviceExpiry || (!workspaceSwitch && interruptionSeconds === 0),
    'Device expiry requires a separate fixture');
  assert(!advertisedHostname || (!deviceExpiry && !workspaceSwitch && interruptionSeconds === 0),
    'Advertised-hostname acceptance requires a separate fixture');
  const evidence = resolve(evidencePath);
  assert(isAbsolute(evidencePath) && relative(ROOT, evidence).startsWith('..'), 'Evidence/private input must be outside the repository');
  // Device expiry uses the existing private desktop controls only. It creates
  // no tunnel, DNS record or public route and needs no provider credential.
  const login = deviceExpiry || advertisedHostname ? undefined : parseArgoTunnelCert(readFileSync(certPath, 'utf8'));
  assert(deviceExpiry || advertisedHostname || login, 'A maintained Cloudflare login certificate is required');
  const api = login ? cloudflareApi({ apiToken: login.apiToken }) : undefined;
  const zone = api && login ? await api.getZone(login.zoneId) : undefined;
  if (zone && login) {
    assert.equal(zone.account?.id, login.accountId, 'Certificate zone/account mismatch');
    await verifyFixtureZone(zone); // Fail closed before creating external resources.
  }
  const runId = randomUUID();
  const tunnelName = 'native-iphone-fixture-' + runId;
  const hostname = advertisedHostname ? 'api.papercuspai.com' :
    zone ? 'native-iphone-' + runId + '.' + zone.name : '127.0.0.1';
  if (api && zone && login) {
    assert.equal((await api.listDnsRecords(zone.id, hostname)).length, 0, 'Fixture hostname already exists');
    assert.equal((await api.listTunnelsByName(login.accountId, tunnelName)).length, 0, 'Fixture tunnel already exists');
  }
  mkdirSync(evidence, { mode: 0o700 }); // Refuse an existing attempt; retain earlier evidence.
  const receipt: Record<string, unknown> = { schemaVersion: 1, runId, ...identity, hostname,
    publicBase: deviceExpiry ? identity.base : 'https://' + hostname, loopbackOnly: deviceExpiry,
    ...(advertisedHostname ? { providerRouteOwnedByCaller: true,
      providerRouteRestoration: 'Not performed or attested by this fixture; requires the caller\'s exact provider receipt',
      cleanupScope: 'Owned fixture processes and private inputs; excludes the caller-owned provider route' } : {}),
    controlPid: process.pid, home: process.env.HOME,
    sourceSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    startedAt: new Date().toISOString(), ready: false, cleanupVerified: false,
    scope: deviceExpiry ? 'Disposable loopback device-expiry fixture; no public resources or release acceptance' :
      'Disposable public HTTPS fixture; no native UI, cloud relay or release acceptance claimed' };
  const save = () => saveFixtureReceipt(evidence, receipt);
  let host: ChildProcess | undefined, connector: ChildProcess | undefined;
  // Use the maintained host bundle producer instead of loading the CommonJS
  // TypeScript entry through tsx. The committed-source guard correctly refuses
  // a CommonJS transform of a checkout module; this fixture must exercise the
  // same plain-node artifact that staging and release hosts run. Keep the
  // generated directory under the ignored dist-host-* family so its bundle is
  // allowed by the source guard, while its import.meta-derived repo root still
  // resolves to this checkout.
  const fixtureBundleDir = mkdtempSync(join(ROOT, 'apps/operator/dist-host-native-fixture-'));
  const fixtureBundlePath = join(fixtureBundleDir, 'hono-host.mjs');
  let removal: (RemovalTarget & { tunnelName: string }) | undefined;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const logs: number[] = [];
  const start = (command: string, args: string[], env: NodeJS.ProcessEnv, logName: string, ipc = false) => {
    const fd = openSync(resolve(evidence, logName), 'wx', 0o600); logs.push(fd);
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ipc ? ['ignore', fd, fd, 'ipc'] : ['ignore', fd, fd] });
    child.on('error', error => { receipt.processError = error.message; stopped = true; });
    return child;
  };
  try {
    save();
    const switchFixture = workspaceSwitch ? await prepareFixtureWorkspaceSwitch() : undefined;
    if (switchFixture) { receipt.workspaceSwitch = switchFixture; save(); }
    const expectedWorkspaceIds = switchFixture?.workspaces.map(w => w.id) ?? [identity.workspaceId];
    const hostEnv = {
      ...process.env, MOBILE_JWT_SECRET: randomBytes(48).toString('base64url'),
      MOBILE_DESKTOP_PUBLIC_URL: String(receipt.publicBase), MOBILE_DESKTOP_HOST: hostname,
    };
    // The bundle is already plain ESM; an inherited tsx hook would still
    // transform any runtime source import and make the committed-source guard
    // refuse it. Retain that guard as the only preload for this child rather
    // than disabling NODE_OPTIONS or running an unjudged transformed module.
    const bundleHostEnv = {
      ...hostEnv,
      NODE_OPTIONS: `--import=${resolve(ROOT, 'scripts/lib/committed-source-loader.mjs')}`,
    };
    const startHost = (log: string) => {
      const buildLog = resolve(evidence, 'host-bundle-build.log');
      try {
        const output = execFileSync('bash', [resolve(ROOT, 'apps/operator/bin/bundle-host.sh'),
          'bin/hono-host.ts', fixtureBundlePath], {
          cwd: ROOT, env: hostEnv, encoding: 'utf8', timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        writeFileSync(buildLog, output, { mode: 0o600 });
      } catch (error) {
        const detail = error && typeof error === 'object'
          ? `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`
          : String(error);
        writeFileSync(buildLog, detail.slice(-32_000), { mode: 0o600 });
        // Preserve the build refusal in the conventional host log as well: the
        // caller's bounded startup diagnostic already reads that path.
        writeFileSync(resolve(evidence, log), detail.slice(-32_000), { mode: 0o600 });
        throw error;
      }
      return start(process.execPath,
        [...(deviceExpiry ? ['--import', resolve(ROOT,
          'packages/operator-core/lib/native-device-fixture-clock.ts')] : []), fixtureBundlePath],
        bundleHostEnv, log, deviceExpiry);
    };
    host = startHost('host.log');
    receipt.hostPid = host.pid;
    await waitForFixtureHost(host, resolve(evidence, 'host.log'), async () => {
        const health = await fetch(identity.base + '/api/health', { signal: AbortSignal.timeout(2000) });
        const registry = await fetch(identity.base + '/api/workspaces', { signal: AbortSignal.timeout(2000) });
        const h = await health.json(), r = await registry.json();
        assert(h.ok === true && h.service === 'papercusp-operator', 'Unexpected private health');
        assert.equal(r.current, identity.workspaceId, 'Private current workspace mismatch');
        assert.deepEqual(r.workspaces.map((w: { id: string }) => w.id).sort(), [...expectedWorkspaceIds].sort(),
          'Private workspace registry mismatch');
        receipt.localBoundary = await verifyProtectedIngress('http://127.0.0.1:' + identity.ingressPort);
    }, { timeoutMs: 180_000, pollMs: 500, stopped: () => stopped,
      record: diagnostic => { receipt.localReadiness = diagnostic; save(); } });
    if (advertisedHostname) {
      receipt.awaitingPublicRoute = { publicBase: receipt.publicBase,
        ingressTarget: 'http://127.0.0.1:' + identity.ingressPort };
      save();
      console.log('NATIVE_HTTPS_FIXTURE_ROUTE_READY=' + JSON.stringify(receipt.awaitingPublicRoute));
      const routeReadyBy = Date.now() + 120_000;
      for (;;) {
        assert(!stopped && host.exitCode === null && host.signalCode === null, 'Advertised fixture stopped');
        try { receipt.advertisedRoute = await verifyAdvertisedFixtureRoute(); break; }
        catch (error) {
          receipt.publicLastFailure = fixtureFailure(error); save();
          if (Date.now() >= routeReadyBy) throw error;
          await delay(1000);
        }
      }
    }
    if (api && login && zone) {
    // Track creation immediately, including a later config/DNS/token failure.
    const trackedApi: CloudflareApi = { ...api, createTunnel: async (accountId, name) => {
      const tunnel = await api.createTunnel(accountId, name);
      removal = { accountId, zoneId: zone.id, tunnelId: tunnel.id, hostname, tunnelName };
      receipt.tunnelId = tunnel.id; save(); return tunnel;
    } };
    const provisioned = await provisionCloudflareTunnel(trackedApi, {
      accountId: login.accountId, zoneId: zone.id, hostname, tunnelName, ingressPort: identity.ingressPort,
    });
    removal = { ...removal!, dnsRecordId: provisioned.dnsRecordId };
    connector = start('cloudflared', ['tunnel', '--no-autoupdate', 'run'], {
      ...process.env, TUNNEL_TOKEN: provisioned.runToken,
    }, 'connector.log');
    receipt.connectorPid = connector.pid; save();
    receipt.authoritativeAddresses = await waitForFixtureDns(hostname, zone.name_servers!, {
      onFailure: error => { receipt.dnsLastFailure = fixtureFailure(error); save(); },
    });
    receipt.dnsPublishedAt = new Date().toISOString(); save();
    const publicReadyBy = Date.now() + 120_000;
    for (;;) {
      assert(!stopped && connector.exitCode === null && connector.signalCode === null, 'Fixture connector exited');
      try { receipt.publicBoundary = await verifyProtectedIngress(String(receipt.publicBase)); break; }
      catch (error) {
        receipt.publicLastFailure = fixtureFailure(error); save();
        if (Date.now() >= publicReadyBy) throw error;
        await delay(1000);
      }
    }
    }
    const minted = await fetch(identity.base + '/api/device/desktop/mint-pair-token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: identity.workspaceId }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(minted.status, 200, 'Private pairing mint failed');
    const { qrPayload } = await minted.json();
    assert(qrPayload.workspaceId === identity.workspaceId && qrPayload.server === receipt.publicBase,
      'Fresh QR must advertise the exact public endpoint');
    writeFileSync(resolve(evidence, 'pair-payload.json'), JSON.stringify(qrPayload), { mode: 0o600, flag: 'wx' });
    const expiryMint = await fetch(identity.base + '/api/device/desktop/mint-pair-token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: identity.workspaceId }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(expiryMint.status, 200, 'Private expiry pairing mint failed');
    const expiredPayload = (await expiryMint.json()).qrPayload;
    assert(expiredPayload?.workspaceId === identity.workspaceId && expiredPayload.server === receipt.publicBase &&
      typeof expiredPayload.pairToken === 'string' && expiredPayload.pairToken !== qrPayload.pairToken,
      'Expiry probe must use a separate owned token');
    const expiresAt = await expireFixturePair(expiredPayload.pairToken, identity.workspaceId);
    const refusal = await fetch(String(receipt.publicBase) + '/api/device/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairToken: expiredPayload.pairToken }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(refusal.status, 401, 'Real public backend must refuse the expired pairing token');
    await refusal.arrayBuffer();
    writeFileSync(resolve(evidence, 'expired-pair-payload.json'), JSON.stringify(expiredPayload),
      { mode: 0o600, flag: 'wx' });
    receipt.pairExpiry = { expiresAt, refusalStatus: refusal.status, separateFreshControl: true };
    receipt.ready = true; receipt.readyAt = new Date().toISOString(); save();
    console.log('NATIVE_HTTPS_FIXTURE_READY=' + JSON.stringify({ receipt: resolve(evidence, 'runtime.json'),
      publicBase: receipt.publicBase, workspaceId: identity.workspaceId }));
    const until = Date.now() + seconds * 1000;
    let interruptionDone = false;
    let deviceExpiryDone = false;
    while (!stopped && Date.now() < until && !existsSync(resolve(evidence, 'stop'))) {
      assert(host.exitCode === null && host.signalCode === null &&
        (!connector || (connector.exitCode === null && connector.signalCode === null)),
        'Owned fixture process exited');
      if (deviceExpiry && !deviceExpiryDone) {
        const { listDevices } = await import('./device-store');
        const devices = await listDevices(identity.workspaceId);
        assert(devices.length <= 1, 'Device expiry requires one initially paired phone');
        if (devices.length === 1 && devices[0]!.last_seen) {
          // Preserve a visible authorized positive control before the genuine JWT refusal.
          await delay(15_000);
          const { advanceFixtureDeviceClock } = await import('./native-device-fixture-clock');
          const offsetMs = await advanceFixtureDeviceClock(host);
          const after = await listDevices(identity.workspaceId);
          assert(after.length === 1 && after[0]!.device_id === devices[0]!.device_id &&
            after[0]!.revoked_at === null, 'Expiry must preserve the unrevoked device row');
          receipt.deviceExpiry = { offsetMs, advancedAt: new Date().toISOString(),
            heartbeatBeforeAdvance: true, originalDevicePreserved: true, signingIdentityPreserved: true };
          deviceExpiryDone = true; save();
        }
      }
      if (interruptionSeconds && !interruptionDone) {
        const { listDevices } = await import('./device-store');
        const devices = await listDevices(identity.workspaceId);
        assert(devices.length <= 1, 'Offline acceptance requires exactly one owned phone');
        if (devices.length === 1 && devices[0]!.last_seen) {
          // Let the visible authorized read finish before disconnecting. The
          // native case then waits on actual UI outcomes, not this timer.
          receipt.interruption = { pairedDeviceCount: 1, heartbeatBeforeStop: true,
            seconds: interruptionSeconds, requestedAt: new Date().toISOString() }; save();
          await delay(15_000);
          host = await interruptFixtureHost(host, async () => startHost('restored-host.log'),
            interruptionSeconds, value => {
              Object.assign(receipt.interruption as object, value); save();
            });
          receipt.hostPid = host.pid;
          await waitForFixtureHost(host, resolve(evidence, 'restored-host.log'), async () => {
              const health = await fetch(identity.base + '/api/health', { signal: AbortSignal.timeout(2000) });
              assert((await health.json()).ok === true, 'Restored operator health failed');
              receipt.restoredPublicBoundary = await verifyProtectedIngress(String(receipt.publicBase));
              const after = await listDevices(identity.workspaceId);
              assert(after.length === 1 && after[0]!.device_id === devices[0]!.device_id,
                'Recovery must preserve the original paired phone');
              Object.assign(receipt.interruption as object, { readyAt: new Date().toISOString(),
                originalDevicePreserved: true }); save();
          }, { timeoutMs: 120_000, pollMs: 1000, stopped: () => stopped,
            record: diagnostic => { receipt.recoveryReadiness = diagnostic; save(); } });
          interruptionDone = true;
        }
      }
      await delay(500);
    }
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    receipt.failure = fixtureFailure(error);
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await stopChild(connector); await stopChild(host);
    receipt.processCleanupVerified = (!host || !host.pid || host.exitCode !== null || host.signalCode !== null) &&
      (!connector || !connector.pid || connector.exitCode !== null || connector.signalCode !== null);
    try {
      if (removal) { assert(api); await cleanupFixtureTunnel(api, removal); }
      receipt.cloudCleanupVerified = true;
    } catch (error) { receipt.cleanupError = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
    for (const name of ['pair-payload.json', 'expired-pair-payload.json']) {
      const input = resolve(evidence, name); if (existsSync(input)) unlinkSync(input);
    }
    for (const fd of logs) closeSync(fd);
    rmSync(fixtureBundleDir, { recursive: true, force: true });
    receipt.cleanupVerified = receipt.processCleanupVerified === true && receipt.cloudCleanupVerified === true;
    receipt.finishedAt = new Date().toISOString(); save();
    console.log('NATIVE_HTTPS_FIXTURE_TERMINAL=' + JSON.stringify({ ready: receipt.ready, cleanupVerified: receipt.cleanupVerified,
      error: receipt.error, cleanupError: receipt.cleanupError }));
  }
}

if (isCliEntry(import.meta.url)) {
  const [evidence, cert, lifetime, offlineSeconds, journey] = process.argv.slice(2);
  assert(journey === undefined || ['workspace-switch', 'device-expiry', 'advertised-hostname'].includes(journey), 'Unknown native fixture journey');
  runNativeDeviceFixture(evidence ?? '', cert ?? '', lifetime ? Number(lifetime) : 1800,
    offlineSeconds === undefined ? undefined : Number(offlineSeconds), journey === 'workspace-switch',
    journey === 'device-expiry', journey === 'advertised-hostname').catch(error => {
    console.error('NATIVE_HTTPS_FIXTURE_PREFLIGHT_FAILED=' + error.message); process.exitCode = 1;
  });
}
