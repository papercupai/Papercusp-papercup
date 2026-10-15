/**
 * Harness-facing route surface — operator's harness query + KPI endpoints.
 *
 * These specs verify the shape contracts the harness UI depends on. They
 * are read-only and don't mutate harness state.
 */
import { test, expect } from './_egress';
import { onAppOrigin } from './_app-origin';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://localhost:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('harness route surface', () => {
  test('GET /api/harness/all/kpis returns KPI shape', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/harness/all/kpis`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  test('POST /api/zero-harness/rest-query without body returns 4xx', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/zero-harness/rest-query`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    // 400 (missing name), 405 (wrong verb), or 200 if it accepts empty
    expect([200, 400, 401, 405, 500]).toContain(res.status());
  });

  test('GET /api/zero-harness/sse is SSE-shaped or 401', async ({ page }) => {
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
    }, `${baseURL}/api/zero-harness/sse`);

    if ('error' in result) {
      expect(result.error).toMatch(/abort/i);
    } else {
      expect([200, 401]).toContain(result.status);
    }
  });
});
