import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureSessionCapabilityScenario } from './session-capability-http-scenario';

const options = {
  workspace: 'private-fixture-workspace',
  api: 'http://127.0.0.1:3170/api',
  expectedSha: '0123456789',
};
const deviceToken = 'fixture-device-token-not-real';
const devicePath = '/api/device/desktop/devices/private-fixture-device';

function timeout() {
  const error = new Error(`request carried deviceToken=${deviceToken}`);
  error.name = 'TimeoutError';
  return error;
}

function pairedJourney(cleanupFails = false) {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${path}`);
    if (path === '/api/health') return Response.json({ sha: options.expectedSha });
    if (path === '/api/device/desktop/mint-pair-token') {
      return Response.json({ qrPayload: { pairToken: 'fixture-pair-token-not-real' } });
    }
    if (path === '/api/device/pair') {
      return Response.json({ deviceId: 'private-fixture-device', deviceToken });
    }
    if (path === `${devicePath}/agent-sessions`) throw timeout();
    if (path === devicePath && method === 'DELETE') {
      if (cleanupFails) throw timeout();
      return Response.json({ ok: true });
    }
    const token = new Headers(init?.headers).get('authorization');
    return Response.json({}, { status: token === `Bearer ${deviceToken}` ? 403 : 401 });
  }));
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe('current-build device scenario failure evidence', () => {
  it('identifies a timed-out health request without exposing credential-bearing errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout()));
    const error = await measureSessionCapabilityScenario(options).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/GET \/health failed after \d+ms \(TimeoutError\)/);
    expect(error.message).not.toContain(deviceToken);
  });

  it('names the failed grant request and still revokes the private paired device', async () => {
    const requests = pairedJourney();
    const error = await measureSessionCapabilityScenario(options).catch(error => error);
    expect(error.message).toContain('POST /device/desktop/devices/private-fixture-device/agent-sessions');
    expect(error.message).not.toContain(deviceToken);
    expect(requests.at(-1)).toBe(`DELETE ${devicePath}`);
  });

  it('preserves both request and cleanup failures when revocation also times out', async () => {
    const requests = pairedJourney(true);
    const error = await measureSessionCapabilityScenario(options).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0].message).toContain('POST /device/desktop/devices/private-fixture-device/agent-sessions');
    expect(error.errors[1].message).toContain('DELETE /device/desktop/devices/private-fixture-device');
    expect(error.errors.map((entry: Error) => entry.message).join('\n')).not.toContain(deviceToken);
    expect(requests.at(-1)).toBe(`DELETE ${devicePath}`);
  });
});
