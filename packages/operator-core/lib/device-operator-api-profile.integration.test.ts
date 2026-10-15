import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

describe('disposable operator-api monitoring sources', () => {
  let auditDirectory: string | undefined;
  afterEach(() => {
    if (auditDirectory) rmSync(auditDirectory, { recursive: true, force: true });
    auditDirectory = undefined;
  });
  it('measures an explicitly paused private gate and preserves missing-source failure', () => {
    const auditPath = process.env.PAPERCUSP_COMMITTED_SOURCE_AUDIT ??
      join(auditDirectory = mkdtempSync(join(tmpdir(), 'operator-api-load-audit-')), 'loads.jsonl');
    const probe = `
      import { getOrgPg } from '@papercusp/db-org';
      import { releaseGateTile } from './packages/operator-core/lib/device-monitoring.ts';
      import { clearOrientPipelineCache } from './packages/operator-core/lib/agent-tools/coordination/pipeline-health.ts';
      const e = process.env;
      const id = e.PAPERCUSP_WORKSPACE_ID;
      if (!id.startsWith('test-runtime-') || e.PAPERCUSP_POT_HOME_SLUG !== id ||
          e.PAPERCUSP_BACKGROUND_WORKERS !== '0' || e.PAPERCUSP_DBOS_ROUTINES !== '0') {
        throw new Error('Disposable request-only identity required');
      }
      const { sql } = getOrgPg();
      try {
        const rows = await sql\`SELECT workspace_id, install_slug, active, next_fire_at, metadata
          FROM harness_shared.routines WHERE name = 'green-checkpoint'\`;
        const gate = await releaseGateTile(id);
        await sql\`DELETE FROM harness_shared.routines WHERE install_slug = \${id} AND name = 'green-checkpoint'\`;
        clearOrientPipelineCache();
        const missingGate = await releaseGateTile(id);
        console.log('PRIVATE_GATE_PROOF=' + JSON.stringify({ id, home: e.HOME, rows, gate, missingGate }));
      } finally { await sql.end(); }
    `;
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PAPERCUSP_COMMITTED_SOURCE_AUDIT: auditPath,
        NODE_OPTIONS: `--import=${resolve(root, 'scripts/lib/committed-source-loader.mjs')} ${process.env.NODE_OPTIONS ?? ''}` },
    });
    // Retain original phase output even when readiness fails before the probe.
    console.log(result.stdout);
    // Child stderr also carries DB/provenance diagnostics. Retain its channel
    // label; the exit-status assertion below decides whether the child failed.
    if (result.stderr) console.log('[private operator child stderr]\n' + result.stderr);
    expect(result.status, (result.stderr ?? '').slice(-3000)).toBe(0);
    // Progress messages must never be mistaken for the final ready identity.
    // These retained stages also identify import/registry/DB/sidecar stalls.
    for (const stage of ['imports:harness-registry', 'imports:embed-sidecar',
      'imports:db-org', 'imports:device-monitoring', 'private-registry',
      'paused-routine', 'measure-private-gate', 'sidecar-listen']) {
      expect(result.stdout).toContain('operator-api stage ' + stage + ' +');
    }
    const timings = result.stdout.split('\n').filter(line => line.includes('operator-api stage ') && line.includes(' timing='))
      .map(line => JSON.parse(line.slice(line.indexOf(' timing=') + ' timing='.length)));
    expect(timings.length, 'The real child must retain emission and receive clocks').toBeGreaterThan(0);
    for (const timing of timings) {
      expect(timing.childPid).toBeGreaterThan(0);
      expect(timing.childElapsedMs).toBeGreaterThanOrEqual(0);
      expect(timing.childEventLoopDelayMaxMs).toBeGreaterThanOrEqual(0);
      expect(timing.parentLoopLateMaxMs).toBeGreaterThanOrEqual(0);
      expect(timing.deliveryDelayMs).toBeCloseTo(timing.parentReceivedAtMs - timing.childEmittedAtMs, 2);
      expect(timing.profileSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(new Set(timings.map(timing => timing.childPid)).size).toBe(1);
    expect(new Set(timings.map(timing => timing.profileSourceSha256)).size).toBe(1);
    const loads = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const scriptLoad = loads.find(load => load.file === resolve(root, 'scripts/with-test-pg.mjs') &&
      load.schemaVersion === 'committed-source-load-receipt-v1');
    expect(scriptLoad, 'The wrapper must retain its observed loader receipt').toBeDefined();
    expect(scriptLoad.returnedSha256).toMatch(/^[a-f0-9]{64}$/);
    const profileLoad = loads.find(load => load.pid === timings[0].childPid &&
      load.file === resolve(root, 'packages/operator-core/lib/harness-registry.ts') &&
      load.schemaVersion === 'committed-source-load-receipt-v1');
    expect(profileLoad, 'Isolation must preserve the audit channel in the actual profile child').toBeDefined();
    expect(profileLoad.returnedSha256).toMatch(/^[a-f0-9]{64}$/);
    // This receipt pins one loader boundary; it cannot qualify later transforms.
    expect(profileLoad.unresolved).toContain('later-loader-transforms-unmeasured');
    for (const stage of ['harness-registry', 'embed-sidecar', 'db-org', 'device-monitoring',
      'pipeline-health', 'why-chain', 'git-pipeline-stats']) {
      const started = timings.find(timing => timing.stage === 'imports:' + stage && timing.phase === 'start' && !timing.heartbeat);
      const finished = timings.find(timing => timing.stage === 'imports:' + stage && timing.phase === 'ready' && !timing.heartbeat);
      expect(started, 'Missing actual import start: ' + stage).toBeDefined();
      expect(finished, 'Missing actual import completion: ' + stage).toBeDefined();
      expect(finished.operationDurationMs).toBeGreaterThanOrEqual(0);
      expect(Math.abs(finished.operationDurationMs - (finished.childElapsedMs - started.childElapsedMs))).toBeLessThan(5);
    }
    for (const source of ['routines', 'conflicts', 'day', 'week', 'recent',
      'deploy', 'fire-history', 'config-import', 'config-ready']) {
      expect(result.stdout).toContain('measure-private-gate:' + source + ':start');
      expect(result.stdout).toContain('measure-private-gate:' + source + ':ready');
    }
    const gateStages = result.stdout.split('\n').filter(line => line.includes('measure-private-gate:'));
    expect(gateStages.some(line => line.includes('pending=["routines"]'))).toBe(true);
    expect(gateStages.at(-1)).toContain('pending=[]');
    const line = result.stdout.split('\n').find(row => row.startsWith('PRIVATE_GATE_PROOF='));
    expect(line, 'Private gate proof must execute').toBeDefined();
    const proof = JSON.parse(line!.slice('PRIVATE_GATE_PROOF='.length));
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0]).toMatchObject({
      workspace_id: proof.id, install_slug: proof.id, active: false, next_fire_at: null,
      metadata: { pause: { reason: 'Disposable operator-api fixture; publication disabled' } },
    });
    expect(proof.gate).toMatchObject({ gate: 'wedged', red: true });
    expect(proof.missingGate).toBeNull();
    expect(existsSync(proof.home), 'Private runtime must be disposed').toBe(false);
  }, 200_000);
});

describe('disposable operator-api device lifecycle', () => {
  it('enforces expiry, revocation and workspace isolation through real HTTP and Postgres', () => {
    const probe = `
      import assert from 'node:assert/strict';
      import { createHmac, randomUUID } from 'node:crypto';
      import { Hono } from 'hono';
      import { createAdaptorServer } from '@hono/node-server';
      const e = process.env;
      const id = e.PAPERCUSP_WORKSPACE_ID;
      if (!id?.startsWith('test-runtime-') || e.PAPERCUSP_POT_HOME_SLUG !== id ||
          e.PAPERCUSP_BACKGROUND_WORKERS !== '0' || e.PAPERCUSP_DBOS_ROUTINES !== '0') {
        throw new Error('Disposable request-only identity required');
      }
      // A private signing key lets expiry be tested independently of signature
      // rejection, without changing the production token TTL or wall clock.
      e.MOBILE_JWT_SECRET = 'private-device-lifecycle-' + randomUUID();
      const { getOrgPg } = await import('@papercusp/db-org');
      const { registerRoute } = await import('./packages/operator-core/lib/endpoint-route/define-route.ts');
      const { default: routes } = await import('./packages/operator-core/lib/endpoint-route/routes/device/pair.ts');
      const { readRegistry } = await import('./packages/operator-core/lib/workspace-registry.ts');
      const { insertDevice } = await import('./packages/operator-core/lib/device-store.ts');
      const { signDeviceToken } = await import('./packages/operator-core/lib/device-jwt.ts');
      const { sql } = getOrgPg();
      const other = id + '-other';
      const { prepareFixtureWorkspaceSwitch } = await import('./packages/operator-core/lib/native-device-fixture.ts');
      const switchFixture = await prepareFixtureWorkspaceSwitch();
      assert.deepEqual(switchFixture.workspaces.map(w => w.id), [id, other]);
      assert.equal(readRegistry().workspaces.length, 2);
      const app = new Hono().basePath('/api');
      for (const route of routes) registerRoute(app, route);
      const server = createAdaptorServer({ fetch: app.fetch });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const base = 'http://127.0.0.1:' + server.address().port;
      const checks = [];
      async function request(name, path, expected, { method = 'GET', token, body, workspace } = {}) {
        const response = await fetch(base + '/api' + path, {
          method, signal: AbortSignal.timeout(15000), headers: {
            ...(token ? { authorization: 'Bearer ' + token } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(workspace ? { 'x-papercusp-workspace': workspace } : {}),
          }, ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const value = await response.json();
        assert.equal(response.status, expected, name + ': ' + JSON.stringify(value));
        checks.push({ name, status: response.status });
        return value;
      }
      try {
        const mint = await request('mint-current-remote-access', '/device/desktop/mint-pair-token', 200,
          { method: 'POST', body: { workspaceId: id } });
        assert.equal(mint.qrPayload?.workspaceId, id);
        assert.equal(typeof mint.qrPayload?.pairToken, 'string');
        assert(mint.qrPayload.pairToken.length > 0);
        assert.equal(typeof mint.qrPayload.server, 'string');
        assert(Number.isFinite(mint.expiresAt));
        const pair = await request('redeem', '/device/pair', 200,
          { method: 'POST', body: { pairToken: mint.qrPayload.pairToken } });
        assert.equal(pair.workspaceId, id);
        assert.equal(typeof pair.deviceId, 'string');
        assert.equal(typeof pair.deviceToken, 'string');
        await request('one-shot-reuse-refused', '/device/pair', 401,
          { method: 'POST', body: { pairToken: mint.qrPayload.pairToken } });
        const pending = await request('mint-expiry-probe', '/device/desktop/mint-pair-token', 200,
          { method: 'POST', body: { workspaceId: id } });
        assert.equal(pending.qrPayload?.workspaceId, id);
        assert.equal(typeof pending.qrPayload?.pairToken, 'string');
        assert(pending.qrPayload.pairToken.length > 0);
        const { expireFixturePair } = await import('./packages/operator-core/lib/native-device-fixture.ts');
        await assert.rejects(expireFixturePair(pending.qrPayload.pairToken, other), /must belong to this fixture/);
        const expiresAt = await expireFixturePair(pending.qrPayload.pairToken, id);
        assert(expiresAt < Date.now());
        await assert.rejects(expireFixturePair('missing-owned-token', id), /Exactly one unused owned/);
        await request('expired-pair-token-refused', '/device/pair', 401,
          { method: 'POST', body: { pairToken: pending.qrPayload.pairToken } });
        const foreignId = randomUUID();
        await insertDevice({ deviceId: foreignId, workspaceId: other,
          userEmail: 'private@example.invalid', deviceLabel: 'Second workspace sentinel' });
        const foreignToken = signDeviceToken({ sub: foreignId, workspace_id: other, device_kind: 'mobile' });
        const devices = await request('workspace-A-device-read', '/device/devices', 200,
          { token: pair.deviceToken, workspace: other });
        assert(devices.devices.some(d => d.device_id === pair.deviceId));
        assert(devices.devices.every(d => d.workspace_id === id));
        assert(!devices.devices.some(d => d.device_id === foreignId));
        const foreignDevices = await request('workspace-B-device-read', '/device/devices', 200,
          { token: foreignToken, workspace: id });
        assert(foreignDevices.devices.some(d => d.device_id === foreignId));
        assert(foreignDevices.devices.every(d => d.workspace_id === other));
        assert(!foreignDevices.devices.some(d => d.device_id === pair.deviceId));
        await request('cross-workspace-revoke-has-no-effect', '/device/devices/' + foreignId, 200,
          { method: 'DELETE', token: pair.deviceToken });
        await request('foreign-device-still-authorized', '/device/heartbeat', 200,
          { method: 'POST', token: foreignToken });
        const config = await request('header-cannot-override-token-workspace', '/device/runtime-config', 200,
          { token: pair.deviceToken, workspace: other });
        assert.equal(config.workspaceId, id);
        await request('unknown-workspace-switch-refused', '/device/workspace/switch', 403,
          { method: 'POST', token: pair.deviceToken, body: { workspaceId: 'unregistered-workspace' } });
        const switched = await request('workspace-switch-A-to-B', '/device/workspace/switch', 200,
          { method: 'POST', token: pair.deviceToken, body: { workspaceId: other } });
        assert.equal(switched.workspaceId, other);
        assert(switched.deviceToken && switched.deviceToken !== pair.deviceToken);
        const switchedConfig = await request('switched-token-claims-B', '/device/runtime-config', 200,
          { token: switched.deviceToken, workspace: id });
        assert.equal(switchedConfig.workspaceId, other);
        const switchedDevices = await request('switched-device-data-is-B', '/device/devices', 200,
          { token: switched.deviceToken });
        assert(switchedDevices.devices.some(d => d.device_label === switchFixture.markers[1].label));
        assert(!switchedDevices.devices.some(d => d.device_label === switchFixture.markers[0].label));
        const switchedBack = await request('workspace-switch-B-to-A', '/device/workspace/switch', 200,
          { method: 'POST', token: switched.deviceToken, body: { workspaceId: id } });
        const restoredDevices = await request('switched-device-data-restores-A', '/device/devices', 200,
          { token: switchedBack.deviceToken });
        assert(restoredDevices.devices.some(d => d.device_label === switchFixture.markers[0].label));
        assert(!restoredDevices.devices.some(d => d.device_label === switchFixture.markers[1].label));
        const [header, payload] = pair.deviceToken.split('.');
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        const expiredPayload = Buffer.from(JSON.stringify({ ...claims,
          exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url');
        const signature = createHmac('sha256', e.MOBILE_JWT_SECRET)
          .update(header + '.' + expiredPayload).digest('base64url');
        const expired = header + '.' + expiredPayload + '.' + signature;
        const attempts = [
          ['/device/runtime-config', {}],
          ['/device/heartbeat', { method: 'POST' }],
          ['/device/workspace/switch', { method: 'POST', body: { workspaceId: other } }],
        ];
        for (const [path, options] of attempts) {
          await request('expired-device-refused:' + path, path, 403, { ...options, token: expired });
        }
        // The valid original still works: the previous failures were expiry,
        // not a revoked row or an invalid private signing configuration.
        await request('unexpired-device-still-authorized', '/device/heartbeat', 200,
          { method: 'POST', token: pair.deviceToken });
        await request('desktop-revoke', '/device/desktop/devices/' + pair.deviceId, 200,
          { method: 'DELETE' });
        for (const [path, options] of attempts) {
          await request('revoked-device-refused:' + path, path, 403,
            { ...options, token: pair.deviceToken });
        }
        await request('other-workspace-survives-revocation', '/device/heartbeat', 200,
          { method: 'POST', token: foreignToken });
        console.log('PRIVATE_DEVICE_LIFECYCLE_PROOF=' + JSON.stringify({
          workspace: id, otherWorkspace: other, home: e.HOME, transport: 'real-loopback-http',
          database: 'disposable-migrated-postgres', checks,
        }));
      } finally {
        await new Promise(resolve => server.close(resolve));
        await sql.end();
      }
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    });
    console.log(result.stdout);
    if (result.stderr) console.log('[private operator child stderr]\n' + result.stderr);
    expect(result.status, (result.stderr ?? '').slice(-3000)).toBe(0);
    const line = result.stdout.split('\n').find(row => row.startsWith('PRIVATE_DEVICE_LIFECYCLE_PROOF='));
    expect(line, 'Real device authorization requests must execute').toBeDefined();
    const proof = JSON.parse(line!.slice('PRIVATE_DEVICE_LIFECYCLE_PROOF='.length));
    expect(proof.checks.map((check: { name: string }) => check.name)).toEqual([
      'mint-current-remote-access', 'redeem', 'one-shot-reuse-refused',
      'mint-expiry-probe', 'expired-pair-token-refused',
      'workspace-A-device-read', 'workspace-B-device-read',
      'cross-workspace-revoke-has-no-effect', 'foreign-device-still-authorized',
      'header-cannot-override-token-workspace', 'unknown-workspace-switch-refused',
      'workspace-switch-A-to-B', 'switched-token-claims-B', 'switched-device-data-is-B',
      'workspace-switch-B-to-A', 'switched-device-data-restores-A',
      ...['/device/runtime-config', '/device/heartbeat', '/device/workspace/switch']
        .map(path => 'expired-device-refused:' + path),
      'unexpired-device-still-authorized', 'desktop-revoke',
      ...['/device/runtime-config', '/device/heartbeat', '/device/workspace/switch']
        .map(path => 'revoked-device-refused:' + path),
      'other-workspace-survives-revocation',
    ]);
    expect(proof.transport).toBe('real-loopback-http');
    expect(proof.database).toBe('disposable-migrated-postgres');
    expect(existsSync(proof.home), 'Private device runtime must be disposed').toBe(false);
  }, 200_000);
});
