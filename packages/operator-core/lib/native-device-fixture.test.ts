import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { createTextCollector } from './child-output';
import { cleanupFixtureTunnel, expireFixturePair, fixtureFailure, fixtureIdentity, fixtureSwitchRegistry, interruptFixtureHost, saveFixtureReceipt, verifyAdvertisedFixtureRoute, verifyFixtureZone, verifyProtectedIngress, waitForFixtureDns, waitForFixtureHost } from './native-device-fixture';
import type { CloudflareApi } from './own-tunnel/cloudflare-api';
import { advanceFixtureDeviceClock, DEVICE_EXPIRY_OFFSET_MS } from './native-device-fixture-clock';

const privateEnv = {
  PAPERCUSP_WORKSPACE_ID: 'test-runtime-native-123', PAPERCUSP_POT_HOME_SLUG: 'test-runtime-native-123',
  PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_DBOS_ROUTINES: '0',
  HOME: '/tmp/private-native/home', PAPERCUSP_HOME: '/tmp/private-native/home/.papercusp',
  PAPERCUSP_SKIP_PG_DISCOVERY: '1', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:40001',
  PAPERCUSP_HONO_PORT: '40001', PAPERCUSP_PG_PORT: '40003',
  PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://private@127.0.0.1:40003/private',
  PAPERCUSP_EXTERNAL_INGRESS_PORT: '40002',
};

describe('disposable native HTTPS fixture admission', () => {
  it('publishes complete private runtime receipts while an independent reader is active', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-receipt-'));
    const path = join(directory, 'runtime.json');
    const state = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    const receipt = (generation: number) => ({ generation, payload: String(generation).repeat(8192) });
    saveFixtureReceipt(directory, receipt(0));
    const reader = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      const state = new Int32Array(workerData.state);
      let reads = 0, failures = 0, firstFailure;
      parentPort.postMessage('ready');
      while (!Atomics.load(state, 0)) {
        try {
          const value = JSON.parse(readFileSync(workerData.path, 'utf8'));
          if (!Number.isInteger(value.generation) || value.payload !== String(value.generation).repeat(8192)) {
            throw new Error('Incomplete receipt generation');
          }
          reads++;
        } catch (error) {
          failures++;
          firstFailure ??= error.message;
        }
        Atomics.add(state, 1, 1);
      }
      parentPort.postMessage({ reads, failures, firstFailure });
    `, { eval: true, workerData: { path, state: state.buffer } });
    const ready = new Promise<void>((done, reject) => {
      reader.on('message', value => { if (value === 'ready') done(); });
      reader.once('error', reject);
    });
    const finished = new Promise<{ reads: number; failures: number; firstFailure?: string }>((done, reject) => {
      reader.on('message', value => { if (value !== 'ready') done(value); });
      reader.once('error', reject);
    });
    try {
      await ready;
      const before = Atomics.load(state, 1);
      for (let generation = 1; generation <= 200; generation++) saveFixtureReceipt(directory, receipt(generation));
      const duringWrites = Atomics.load(state, 1) - before;
      Atomics.store(state, 0, 1);
      const result = await finished;
      expect(duringWrites).toBeGreaterThan(0);
      expect(result.reads).toBeGreaterThan(0);
      expect(result, 'Concurrent readers must never observe partial JSON').toMatchObject({ failures: 0 });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(receipt(200));
      chmodSync(path, 0o644);
      saveFixtureReceipt(directory, receipt(201));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(directory)).toEqual(['runtime.json']);
    } finally {
      Atomics.store(state, 0, 1);
      await reader.terminate();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes its unpublished receipt after a failed rename', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-receipt-failure-'));
    mkdirSync(join(directory, 'runtime.json'));
    try {
      expect(() => saveFixtureReceipt(directory, { ready: true })).toThrow();
      expect(readdirSync(directory)).toEqual(['runtime.json']);
      expect(statSync(join(directory, 'runtime.json')).isDirectory()).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('expires an actually signed device JWT only in the owned child and accepts a newly signed token', async () => {
    const parentBefore = Date.now();
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', '--import',
      join(root, 'packages/operator-core/lib/native-device-fixture-clock.ts'),
      '--input-type=module', '-e', `
        import { signDeviceToken, verifyDeviceToken } from './packages/operator-core/lib/device-jwt.ts';
        const claims = {sub:'owned-phone',workspace_id:process.env.PAPERCUSP_WORKSPACE_ID,device_kind:'mobile'};
        const token = signDeviceToken(claims);
        process.send({type:'before', valid:!!verifyDeviceToken(token)});
        process.on('message', m => {
          if(m.type !== 'native-fixture-expire-device') return;
          const fresh = signDeviceToken(claims);
          process.send({type:'after',oldValid:!!verifyDeviceToken(token),freshValid:!!verifyDeviceToken(fresh)});
        });
      `], { cwd: root, env: { ...process.env, ...privateEnv, MOBILE_JWT_SECRET: 'fixture-only-stable-secret' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const childFailure = createTextCollector(child.stderr);
    const message = (type: string) => new Promise<any>((done, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Missing child proof: ' + type)); }, 10000);
      const exited = () => { cleanup(); reject(new Error('Fixture child exited: ' + childFailure.text())); };
      const receive = (m: any) => { if (m.type === type) { cleanup(); done(m); } };
      child.on('message', receive);
      child.once('exit', exited);
      child.once('error', reject);
    });
    try {
      expect(await message('before')).toEqual({ type: 'before', valid: true });
      await expect(advanceFixtureDeviceClock(child, { ...privateEnv, PAPERCUSP_WORKSPACE_ID: 'production' }))
        .rejects.toThrow('Disposable workspace required');
      const after = message('after');
      expect(await advanceFixtureDeviceClock(child, privateEnv)).toBe(DEVICE_EXPIRY_OFFSET_MS);
      expect(await after).toEqual({ type: 'after', oldValid: false, freshValid: true });
      expect(Date.now() - parentBefore).toBeLessThan(60_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(done => child.once('exit', () => done()));
        child.kill('SIGKILL'); await exited;
      }
    }
  });
  it('adds distinct workspace choices without accepting an existing multi-workspace or foreign registry', () => {
    const id = privateEnv.PAPERCUSP_WORKSPACE_ID;
    const original = { current: id, workspaces: [{ id, name: 'Private', createdAt: 1 }] };
    const expanded = fixtureSwitchRegistry(original, privateEnv);
    expect(expanded.current).toBe(id);
    expect(expanded.workspaces.map(w => [w.id, w.name])).toEqual([
      [id, 'Native workspace A'], [id + '-other', 'Native workspace B'],
    ]);
    expect(original.workspaces).toEqual([{ id, name: 'Private', createdAt: 1 }]);
    expect(() => fixtureSwitchRegistry(expanded, privateEnv)).toThrow('untouched private registry');
    expect(() => fixtureSwitchRegistry({ ...original, current: 'foreign' }, privateEnv))
      .toThrow('Private current workspace mismatch');
    expect(() => fixtureSwitchRegistry({ ...original, workspaces: [{ ...original.workspaces[0]!, id: 'foreign' }] }, privateEnv))
      .toThrow('Private workspace registry mismatch');
    expect(() => fixtureSwitchRegistry(original, { ...privateEnv, PAPERCUSP_BACKGROUND_WORKERS: '1' }))
      .toThrow('must be disabled');
  });
  it('distinguishes alive withheld startup, process exit and listener timeout without exposing private logs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-readiness-'));
    const log = join(directory, 'host.log');
    const host = { exitCode: null as number | null, signalCode: null };
    const probe = vi.fn(async () => { throw Object.assign(new Error('private connection detail'), { code: 'ECONNREFUSED' }); });
    const rows: unknown[] = [];
    const record = (row: unknown) => rows.push(row);
    const pause = vi.fn(async () => undefined);
    try {
      writeFileSync(log, 'private-prefix'.repeat(5000) + '\n[boot-migrate] 🚨 REQUEST STARTUP WITHHELD: ' +
        '1 migration(s) remain pending: 1510-example.sql. HTTP stays closed. private-pairing-secret\n');
      await expect(waitForFixtureHost(host, log, probe, { timeoutMs: 120000, pollMs: 1000, record, pause }))
        .rejects.toMatchObject({ diagnostic: { kind: 'request-startup-withheld', exitCode: null,
          pendingCount: 1, pendingMigrations: ['1510-example.sql'], logState: 'read' } });
      expect(probe).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      host.exitCode = 7;
      await expect(waitForFixtureHost(host, log, probe, { timeoutMs: 120000, pollMs: 1000, record }))
        .rejects.toMatchObject({ diagnostic: { kind: 'host-exited', exitCode: 7 } });
      host.exitCode = null;
      writeFileSync(log, 'private-pairing-secret\n');
      let clock = 0;
      await expect(waitForFixtureHost(host, log, probe, { timeoutMs: 100, pollMs: 50, record,
        now: () => clock, pause: async ms => { clock += ms; } }))
        .rejects.toMatchObject({ diagnostic: { kind: 'listener-timeout', failureCode: 'ECONNREFUSED' } });
      expect(probe).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(rows)).not.toMatch(/private-prefix|private-pairing-secret|private connection detail/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('continues ordinary listener startup and preserves a diagnostic before process death', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-listener-'));
    const log = join(directory, 'host.log');
    const host = { exitCode: null as number | null, signalCode: null };
    const rows: unknown[] = [];
    const record = (row: unknown) => rows.push(row);
    try {
      writeFileSync(log, 'ordinary startup\n');
      const probe = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('not yet')).mockResolvedValueOnce();
      await expect(waitForFixtureHost(host, log, probe, { timeoutMs: 1000, pollMs: 1, record,
        pause: async () => undefined })).resolves.toBeUndefined();
      expect(probe).toHaveBeenCalledTimes(2);
      await expect(waitForFixtureHost(host, log, async () => { host.exitCode = 9; throw new Error('fetch failed'); },
        { timeoutMs: 1000, pollMs: 1, record })).rejects.toMatchObject({ diagnostic: { kind: 'host-exited', exitCode: 9 } });
      expect(rows.at(-1)).toMatchObject({ kind: 'host-exited', exitCode: 9 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('actually stops and replaces its owned HTTP process while retaining its signing identity', async () => {
    let port = 0;
    const children: ReturnType<typeof spawn>[] = [];
    const start = async () => {
      const child = spawn(process.execPath, ['-e', `
        require('node:http').createServer((q,s)=>s.end(process.env.FIXTURE_SIGNING_ID))
          .listen(Number(process.env.FIXTURE_PORT),'127.0.0.1',function(){console.log(this.address().port)});
      `], { env: { ...process.env, FIXTURE_SIGNING_ID: 'same-private-identity', FIXTURE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      port = await new Promise<number>((done, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('HTTP child exited before readiness')));
        child.stdout!.once('data', value => done(Number(String(value).trim())));
      });
      return child;
    };
    try {
      const original = await start();
      const base = 'http://127.0.0.1:' + port;
      expect(await (await fetch(base)).text()).toBe('same-private-identity');
      const events: Record<string, unknown>[] = [];
      await expect(interruptFixtureHost(original, start, 55, value => events.push(value),
        { ...privateEnv, PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' }))
        .rejects.toThrow('Disposable workspace required');
      expect(original.signalCode).toBeNull();
      await expect(interruptFixtureHost(original, start, 0, value => events.push(value), privateEnv))
        .rejects.toThrow('Bounded operator interruption required');
      const restored = await interruptFixtureHost(original, start, 55, value => events.push(value), privateEnv,
        async ms => {
          expect(ms).toBe(55_000);
          expect(original.signalCode).toBe('SIGTERM');
          await expect(fetch(base, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
        });
      expect(restored.pid).not.toBe(original.pid);
      expect(await (await fetch(base)).text()).toBe('same-private-identity');
      expect(events).toMatchObject([{ stoppedPid: original.pid, signal: 'SIGTERM' }, { restoredPid: restored.pid }]);
    } finally {
      await Promise.all(children.map(child => {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        const exited = new Promise<void>(done => child.once('exit', () => done()));
        child.kill('SIGKILL'); return exited;
      }));
    }
  });
  it('refuses non-fixture expiry and cross-workspace tokens before database access', async () => {
    await expect(expireFixturePair('private-token', 'papercusp-workspace', privateEnv))
      .rejects.toThrow('must belong to this fixture');
    await expect(expireFixturePair('private-token', privateEnv.PAPERCUSP_WORKSPACE_ID,
      { ...privateEnv, PAPERCUSP_BACKGROUND_WORKERS: '1' })).rejects.toThrow('must be disabled');
    await expect(expireFixturePair('', privateEnv.PAPERCUSP_WORKSPACE_ID, privateEnv))
      .rejects.toThrow('Pair token is required');
  });
  it('refuses inactive or incorrectly delegated zones before provisioning', async () => {
    const zone = { id: 'z', name: 'example.org', status: 'active', paused: false,
      name_servers: ['first.ns.example', 'second.ns.example'] };
    const readNs = vi.fn(async () => ['SECOND.NS.EXAMPLE.', 'first.ns.example']);
    await expect(verifyFixtureZone(zone, readNs)).resolves.toBeUndefined();
    await expect(verifyFixtureZone({ ...zone, status: 'pending' }, readNs)).rejects.toThrow('active unpaused');
    await expect(verifyFixtureZone({ ...zone, paused: true }, readNs)).rejects.toThrow('active unpaused');
    await expect(verifyFixtureZone(zone, async () => ['peer.ns.example'])).rejects.toThrow('delegation mismatch');
    expect(readNs).toHaveBeenCalledTimes(1);
  });

  it('waits for authoritative publication and preserves DNS failure details', async () => {
    const missing = Object.assign(new Error('queryA ENODATA'), { code: 'ENODATA' });
    const read = vi.fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(missing).mockResolvedValueOnce(['192.0.2.1']);
    const pause = vi.fn(async () => undefined);
    const failures: unknown[] = [];
    await expect(waitForFixtureDns('native.example.org', [], { read, pause,
      onFailure: error => failures.push(fixtureFailure(error)) })).resolves.toEqual(['192.0.2.1']);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([{ message: 'queryA ENODATA', code: 'ENODATA' }]);
    const exhausted = vi.fn(async () => { throw missing; });
    const times = [0, 120001];
    await expect(waitForFixtureDns('native.example.org', [], { read: exhausted, now: () => times.shift()! }))
      .rejects.toThrow('queryA ENODATA');
    expect(fixtureFailure(new TypeError('fetch failed', { cause: missing }))).toMatchObject({ causeCode: 'ENODATA' });
  });

  it('refuses a real workspace, remote admin or ordinary operator port before provisioning', () => {
    expect(fixtureIdentity(privateEnv).ingressPort).toBe(40002);
    for (const change of [
      { PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' }, { PAPERCUSP_ALLOW_REMOTE_ADMIN: '1' },
      { PAPERCUSP_BACKGROUND_WORKERS: '1' }, { PAPERCUSP_DBOS_ENABLE: '1' },
      { PAPERCUSP_SKIP_PG_DISCOVERY: '0' }, { PAPERCUSP_POT_HOME_SLUG: 'papercusp' },
      { PAPERCUSP_EXTERNAL_INGRESS_PORT: '40001' }, { PAPERCUSP_EXTERNAL_INGRESS_PORT: '3070' },
      { PAPERCUSP_EXTERNAL_INGRESS_PORT: '3170' }, { PAPERCUSP_OPERATOR_URL: 'http://192.168.1.2:40001' },
      { PAPERCUSP_HONO_PORT: '3070' }, { PAPERCUSP_PG_PORT: '5432' },
      { PAPERCUSP_TEST_PG_ADMIN_URL: undefined },
      { PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://private@127.0.0.1:5432/private' },
      { PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://private@remote.example:40003/private' },
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170', PAPERCUSP_HONO_PORT: '3170' },
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070', PAPERCUSP_HONO_PORT: '3070' },
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3055', PAPERCUSP_HONO_PORT: '3055' },
      { PAPERCUSP_OPERATOR_URL: 'http://user:secret@127.0.0.1:40001' },
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:40001?query=1' },
    ]) expect(() => fixtureIdentity({ ...privateEnv, ...change })).toThrow();
  });

  it.each(['pass', 'misrouted', 'foreign-workspace', 'missing-private-device', 'runtime-mismatch', 'cleanup-failed'])(
    'requires private origin identity before advertised-hostname readiness (%s)', async outcome => {
      const deviceId = '12345678-1234-1234-1234-123456789abc';
      const publicBase = 'https://api.papercuspai.com';
      const workspaceId = privateEnv.PAPERCUSP_WORKSPACE_ID;
      const seen: Array<{ base: string; path: string; method: string }> = [];
      const probe = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input));
        seen.push({ base: url.origin, path: url.pathname, method: init.method ?? 'GET' });
        expect(init.redirect).toBe('error');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        const privateCall = url.origin === privateEnv.PAPERCUSP_OPERATOR_URL;
        if (privateCall && url.pathname.endsWith('mint-pair-token')) {
          expect(JSON.parse(String(init.body))).toEqual({ workspaceId });
          return Response.json({ qrPayload: { server: publicBase, workspaceId, pairToken: 'private-one-shot' } });
        }
        if (privateCall && init.method === 'DELETE')
          return Response.json({}, { status: outcome === 'cleanup-failed' ? 500 : 200 });
        if (privateCall && url.pathname.endsWith('/devices'))
          return Response.json({ devices: outcome === 'missing-private-device' ? [] : [{ device_id: deviceId, workspace_id: workspaceId }] });
        if (url.pathname === '/api/device/pair') {
          expect(JSON.parse(String(init.body)).pairToken).toBe('private-one-shot');
          return Response.json({ deviceId, deviceToken: 'private-jwt',
            workspaceId: outcome === 'foreign-workspace' ? 'shared-workspace' : workspaceId },
          { status: outcome === 'misrouted' ? 401 : 200 });
        }
        if (url.pathname.endsWith('runtime-config')) {
          expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-jwt');
          return Response.json({ workspaceId: outcome === 'runtime-mismatch' ? 'shared-workspace' : workspaceId });
        }
        return Response.json({}, { status: url.pathname.endsWith('heartbeat') ? 401 : 404 });
      }) as unknown as typeof fetch;
      if (outcome === 'pass') {
        const receipt = await verifyAdvertisedFixtureRoute(privateEnv, probe);
        expect(receipt).toMatchObject({ publicBase, workspaceId, privatePairVerified: true });
        expect(JSON.stringify(receipt)).not.toMatch(/private-one-shot|private-jwt/);
      } else await expect(verifyAdvertisedFixtureRoute(privateEnv, probe)).rejects.toThrow();
      expect(seen.some(r => r.path.includes('attention') || r.path.includes('switch') || r.path === '/api/workspaces')).toBe(false);
      expect(seen.filter(r => r.method === 'DELETE')).toEqual(outcome === 'misrouted' ? [] : [
        { base: privateEnv.PAPERCUSP_OPERATOR_URL, path: '/api/device/desktop/devices/' + deviceId, method: 'DELETE' },
      ]);
      if (['misrouted', 'foreign-workspace', 'missing-private-device'].includes(outcome))
        expect(seen.some(r => r.path.endsWith('runtime-config'))).toBe(false);
    });

  it('rejects shared-runtime input before sending any advertised-route request', async () => {
    const probe = vi.fn();
    await expect(verifyAdvertisedFixtureRoute({ ...privateEnv, PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' }, probe))
      .rejects.toThrow('Disposable workspace');
    expect(probe).not.toHaveBeenCalled();
  });

  it('measures real HTTP denial even when the connector rewrites Host to localhost', async () => {
    const seen: Array<{ path: string; host: string | undefined; method: string | undefined }> = [];
    let exposeMint = false;
    const server = createServer((req, res) => {
      seen.push({ path: req.url!, host: req.headers.host, method: req.method });
      res.writeHead(req.url === '/api/device/heartbeat' ? (req.method === 'POST' ? 401 : 405) :
        (exposeMint && req.url?.endsWith('mint-pair-token')) ? 200 : 404);
      res.end('{}');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address() as { port: number };
      const base = 'http://127.0.0.1:' + address.port;
      // Native HTTP retains an explicitly rewritten Host; undici fetch may
      // replace it with the URL host. Both requests still hit the real socket.
      const socketFetch = ((input: string, init?: RequestInit) => new Promise<Response>((done, reject) => {
        const req = request(input, { method: init?.method, headers: init?.headers as Record<string, string> }, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => done(new Response(Buffer.concat(chunks), { status: res.statusCode })));
        });
        req.on('error', reject); req.end(typeof init?.body === 'string' ? init.body : undefined);
      })) as typeof fetch;
      await expect(verifyProtectedIngress(base, socketFetch)).resolves.toMatchObject({ '/api/device/heartbeat': 401 });
      expect(seen.slice(0, 3).every(row => row.host === 'localhost')).toBe(true);
      expect(seen[3]).toMatchObject({ path: '/api/device/heartbeat', method: 'POST' });
      exposeMint = true;
      await expect(verifyProtectedIngress(base)).rejects.toThrow('exposed /api/device/desktop/mint-pair-token');
    } finally { await new Promise<void>(done => server.close(() => done())); }
  });

  it('does not mistake a broken listener for a protected one', async () => {
    await expect(verifyProtectedIngress('http://127.0.0.1:1')).rejects.toThrow();
    const bad = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(verifyProtectedIngress('http://127.0.0.1:40002', bad)).rejects.toThrow('HTTP 500');
  });

  it('removes only its exact owned CNAME/tunnel, preserving another record at the hostname', async () => {
    let removed = false;
    const other = { id: 'peer', type: 'TXT', name: 'native.example.org', content: 'keep' };
    const api = {
      listTunnelsByName: vi.fn(async () => removed ? [] : [{ id: 'owned', name: 'native-exact', deleted_at: null }]),
      listDnsRecords: vi.fn(async () => removed ? [other] : [other,
        { id: 'ours', type: 'CNAME', name: 'native.example.org', content: 'owned.cfargotunnel.com' }]),
      deleteDnsRecord: vi.fn(async () => undefined), cleanupConnections: vi.fn(async () => undefined),
      deleteTunnel: vi.fn(async () => { removed = true; }),
    };
    await cleanupFixtureTunnel(api as unknown as CloudflareApi,
      { accountId: 'a', zoneId: 'z', tunnelId: 'owned', tunnelName: 'native-exact', hostname: 'native.example.org' });
    expect(api.deleteDnsRecord.mock.calls).toEqual([['z', 'ours']]);
    expect(api.deleteTunnel.mock.calls).toEqual([['a', 'owned']]);
  });

  it('refuses cleanup when the exact name now resolves to a different tunnel', async () => {
    const remove = vi.fn();
    const api = { listTunnelsByName: async () => [{ id: 'peer', name: 'native-exact' }], deleteTunnel: remove };
    await expect(cleanupFixtureTunnel(api as unknown as CloudflareApi,
      { accountId: 'a', zoneId: 'z', tunnelId: 'owned', tunnelName: 'native-exact', hostname: 'native.example.org' }))
      .rejects.toThrow('Fixture tunnel identity changed');
    expect(remove).not.toHaveBeenCalled();
  });
});
