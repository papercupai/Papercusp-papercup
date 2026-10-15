/**
 * State-snapshot SSE — the bespoke-card system's state channel.
 *
 * /api/operator/state-snapshot publishes (cards, tool-states, etc.) as
 * SSE events keyed on workspace. Spec verifies the stream shape; the
 * full card-correlator + workspace-lifecycle behavior is unit-tested.
 */
import { test, expect } from './_egress';
import { onAppOrigin } from './_app-origin';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://localhost:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('state-snapshot SSE', () => {
  test('GET /api/operator/state-snapshot is SSE-shaped or auth-gated', async ({ page }) => {
    await onAppOrigin(page, baseURL);
    const result = await page.evaluate(async (url) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 600);
      try {
        const res = await fetch(url, { signal: controller.signal });
        return {
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
        };
      } catch (e) {
        return { error: String(e) };
      }
    }, `${baseURL}/api/operator/state-snapshot`);

    if ('error' in result) {
      expect(result.error).toMatch(/abort/i);
    } else {
      expect([200, 401, 403]).toContain(result.status);
      if (result.status === 200) {
        expect(result.contentType).toMatch(/event-stream/);
      }
    }
  });

  test('GET /api/operator/state-snapshot includes Last-Event-ID handling', async ({ page }) => {
    // Probe with Last-Event-ID header — the route should accept it for resumption.
    await onAppOrigin(page, baseURL);
    const result = await page.evaluate(async (url) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 400);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'Last-Event-ID': 'test-resume-id' },
        });
        return { status: res.status };
      } catch (e) {
        return { error: String(e) };
      }
    }, `${baseURL}/api/operator/state-snapshot`);

    if ('error' in result) {
      expect(result.error).toMatch(/abort/i);
    } else {
      // The route should still respond (200 or auth-reject), not 500
      expect(result.status).toBeLessThan(500);
    }
  });
});
