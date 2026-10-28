import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStatus } from './dev-data';

const API_URL = 'http://127.0.0.1:3055/api/flags/bootstrap';

function stubFetch(api: { status: number; contentType: string }) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const response = url === API_URL ? api : { status: 200, contentType: 'text/html' };
    return {
      status: response.status,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? response.contentType : null },
    } as Response;
  }));
  return seen;
}

describe('buildStatus Vite API proxy probe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports reachable when :3055 returns JSON from the operator API', async () => {
    const seen = stubFetch({ status: 200, contentType: 'application/json; charset=utf-8' });

    const status = await buildStatus();

    expect(seen).toContain(API_URL);
    expect(status.dev3055ApiReachable).toBe(true);
  });

  it('reports unreachable when the proxied API returns a server error', async () => {
    stubFetch({ status: 502, contentType: 'application/json' });

    const status = await buildStatus();

    expect(status.dev3055ApiReachable).toBe(false);
  });

  it('does not treat a successful HTML SPA fallback as an API response', async () => {
    stubFetch({ status: 200, contentType: 'text/html' });

    const status = await buildStatus();

    expect(status.dev3055ApiReachable).toBe(false);
  });
});
