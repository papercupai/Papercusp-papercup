import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../lib/sensitive-text';

type Reply = { status: number; data: Record<string, any> };
function diagnostic(reply: Reply): string {
  // Pairing replies carry credentials. Retain only sanitized failure fields.
  return redactSensitiveText(JSON.stringify({ status: reply.status,
    error: reply.data.error, code: reply.data.code, message: reply.data.message }));
}

/** The same real HTTP journey for shared staging and a retained private operator. */
export async function measureSessionCapabilityScenario(options: {
  workspace: string; api: string; expectedSha: string;
}) {
  const api = new URL(options.api);
  assert.equal(api.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(api.hostname));
  assert.notEqual(api.port, '3070', 'pre-release proof must use a current-build runtime');
  assert.equal(api.pathname.replace(/\/$/, ''), '/api');
  assert.ok(options.workspace, 'select the private-fixture workspace explicitly');
  assert.match(options.expectedSha, /^[a-f0-9]{10,40}$/);
  const request = async (path: string, method = 'GET', token?: string, body?: object): Promise<Reply> => {
    const startedAt = performance.now();
    try {
      const response = await fetch(options.api.replace(/\/$/, '') + path, { method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
      return { status: response.status, data: await response.json() };
    } catch (error) {
      // Raw fetch/JSON errors can contain pairing credentials. Preserve the
      // failed door and duration without copying request or response data.
      const elapsedMs = Math.round(performance.now() - startedAt);
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      throw new Error(redactSensitiveText(
        `${method} ${path} failed after ${elapsedMs}ms (${errorName})`,
      ));
    }
  };
  const health = await request('/health');
  assert.equal(health.status, 200, diagnostic(health));
  assert.equal(health.data.bundleStale, undefined);
  assert.equal(health.data.sha, options.expectedSha);
  const absentOwner = `su-mobile-private-absent-${randomUUID()}`;
  const doors = [
    ['GET', '/device/sessions'],
    ['GET', `/device/sessions/${absentOwner}/transcript`],
    ['GET', `/device/sessions/${absentOwner}/transcript?stream=1`],
    ['POST', `/device/sessions/${absentOwner}/messages`],
    ['POST', `/device/sessions/${absentOwner}/end`],
    ['GET', '/device/rest-query?name=deviceSessions.list&args=%7B%7D'],
  ] as const;
  const probe = (method: string, path: string, token?: string) => request(path, method, token,
    method === 'POST' ? { text: 'private capability probe', idempotencyKey: randomUUID() } : undefined);
  const checks = { missingJwt: 0, invalidJwt: 0, defaultDenied: 0, granted: 0, revokedCapability: 0 };
  let deviceId: string | undefined;
  let deviceRevoked = false;
  let scenarioFailure: unknown;
  try {
    for (const [method, path] of doors) {
      for (const token of [undefined, 'invalid-device-jwt']) {
        const reply = await probe(method, path, token);
        assert.ok([401, 403].includes(reply.status), `${method} ${path}: ${diagnostic(reply)}`);
        if (token) checks.invalidJwt++; else checks.missingJwt++;
      }
    }
    const mint = await request('/device/desktop/mint-pair-token', 'POST', undefined,
      { workspaceId: options.workspace });
    assert.equal(mint.status, 200, diagnostic(mint));
    const pair = await request('/device/pair', 'POST', undefined, { pairToken: mint.data.qrPayload.pairToken });
    deviceId = pair.data.deviceId;
    assert.equal(pair.status, 200, diagnostic(pair));
    assert.equal(typeof deviceId, 'string');
    assert.equal(typeof pair.data.deviceToken, 'string');
    const token = pair.data.deviceToken as string;
    const grant = (enabled: boolean) => request(`/device/desktop/devices/${deviceId}/agent-sessions`,
      'POST', undefined, { workspaceId: options.workspace, enabled });
    for (const [method, path] of doors) {
      const reply = await probe(method, path, token);
      assert.equal(reply.status, 403, `${path}: ${diagnostic(reply)}`);
      checks.defaultDenied++;
    }
    const enabled = await grant(true);
    assert.equal(enabled.status, 200, diagnostic(enabled));
    for (const [method, path] of doors) {
      const reply = await probe(method, path, token);
      // Targeted writes reach the workspace guard; no real agent is sent to or ended.
      assert.equal(reply.status, path.includes(absentOwner) ? 404 : 200, `${path}: ${diagnostic(reply)}`);
      if (path === '/device/sessions') assert.ok(Array.isArray(reply.data.sessions));
      if (path.startsWith('/device/rest-query')) assert.ok(Array.isArray(reply.data.rows));
      checks.granted++;
    }
    const disabled = await grant(false);
    assert.equal(disabled.status, 200, diagnostic(disabled));
    for (const [method, path] of doors) {
      const reply = await probe(method, path, token);
      assert.equal(reply.status, 403, `${path}: ${diagnostic(reply)}`);
      checks.revokedCapability++;
    }
    const after = await request('/health');
    assert.equal(after.status, 200, diagnostic(after));
    assert.equal(after.data.sha, health.data.sha, 'the serving build must remain pinned throughout the journey');
    assert.equal(after.data.bundleStale, undefined);
  } catch (error) {
    scenarioFailure = error;
    throw error;
  } finally {
    if (deviceId) {
      try {
        const cleanup = await request(`/device/desktop/devices/${deviceId}`, 'DELETE');
        assert.equal(cleanup.status, 200, diagnostic(cleanup));
        deviceRevoked = true;
      } catch (cleanupFailure) {
        if (scenarioFailure !== undefined) {
          throw new AggregateError([scenarioFailure, cleanupFailure],
            'Device-session verification and private-device cleanup both failed');
        }
        throw cleanupFailure;
      }
    }
  }
  return { workspace: options.workspace, sha: health.data.sha, checks, deviceRevoked };
}
