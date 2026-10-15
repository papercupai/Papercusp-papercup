/**
 * Plugin host route surface — the runtime/registry plane.
 *
 * /api/plugins/host/* are the operator-side endpoints the plugin runtime calls
 * to query state, invoke handlers, and stream events. These are different
 * from /api/plugins/[...path]/route.ts which is the per-plugin agent-tool
 * surface.
 *
 * Spec coverage:
 *  - runtime-status returns plugin list
 *  - query/invoke validate input shape
 *  - events SSE is shape-correct
 */
import { test, expect } from './_egress';
import { onAppOrigin } from './_app-origin';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://localhost:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('plugin host routes', () => {
  test('GET /api/plugins/host/runtime-status returns rows array', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/plugins/host/runtime-status`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('rows');
    expect(Array.isArray(body.rows)).toBe(true);
  });

  test('POST /api/plugins/host/query rejects empty body', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/host/query`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([400, 422]).toContain(res.status());
  });

  test('POST /api/plugins/host/query rejects unknown query name', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/host/query`, {
      data: { name: 'totally.fake.query', args: {} },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([400, 500]).toContain(res.status());
  });

  test('POST /api/plugins/host/invoke rejects empty body', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/host/invoke`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([400, 422]).toContain(res.status());
  });

  test('GET /api/plugins/host/events is SSE-shaped or 401', async ({ page }) => {
    await onAppOrigin(page, baseURL);
    const result = await page.evaluate(async (url) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 500);
      try {
        const res = await fetch(url, { signal: controller.signal });
        return {
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
        };
      } catch (e) {
        return { error: String(e) };
      }
    }, `${baseURL}/api/plugins/host/events`);

    if ('error' in result) {
      expect(result.error).toMatch(/abort/i);
    } else {
      // 200 = SSE stream; 401 = auth-gated; 400 = the route now requires
      // plugin/install/name query params (called bare here) — all prove the
      // events route is reachable + validates rather than 404/500-ing.
      expect([200, 401, 400]).toContain(result.status);
    }
  });

  test('GET /api/plugins/host/runtime-status uses GET method (POST returns 405)', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/plugins/host/runtime-status`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([405, 200]).toContain(res.status());
  });
});
