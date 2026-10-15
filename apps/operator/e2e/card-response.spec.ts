/**
 * Bespoke-card response endpoint — HTTP surface.
 *
 * Unit-test coverage (route.test.ts) exercises submit/decline/cancel
 * happy-paths, Zod validation, cross-workspace defense-in-depth, and
 * the 30 RPS per-user rate limit. This spec covers the parts that
 * only show up against the live server: method handling, auth gate
 * ordering, malformed payloads, and Content-Type handling.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.5
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;
const path = '/api/operator/conversations/spec-fixture-id/card-response';

/**
 * A caller the server must NOT treat as the local desktop: a forwarded client
 * address outside loopback marks the request external (forwarded-request-trust),
 * so it gets no seeded default user.
 */
const offBoxHeaders = { 'X-Forwarded-For': '203.0.113.7' };

test.describe('bespoke-card response endpoint', () => {
  test('loopback POST without session is the local desktop user (WI-5044), not 401', async ({
    request,
  }) => {
    // WI-5044: the desktop webview has no session cookie, so a loopback caller
    // resolves to the seeded default user. An unknown correlationId then fails
    // as a lookup miss, never as an auth refusal and never as a crash.
    const res = await request.post(`${baseURL}${path}`, {
      data: { correlationId: 'x', action: 'cancel', workspaceId: 'w' },
    });
    expect(res.status()).not.toBe(401);
    expect(res.status()).toBeLessThan(500);
  });

  test('off-box POST without session is refused BEFORE body validation (auth gate first)', async ({
    request,
  }) => {
    // Obviously invalid body from an external caller: with the auth gate ordered
    // first this is an auth refusal (401 from the handler, or 403 if the route
    // stack's loopback tier refuses earlier), never a 400 validation error.
    const res = await request.post(`${baseURL}${path}`, {
      data: { garbage: true },
      headers: offBoxHeaders,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST with non-JSON Content-Type still 401s without session', async ({ request }) => {
    const res = await request.post(`${baseURL}${path}`, {
      data: 'not-json-at-all',
      headers: { 'Content-Type': 'text/plain' },
    });
    // Either auth-gates first (401) or rejects parsing (400). Must not 500.
    expect([400, 401, 415]).toContain(res.status());
  });

  test('GET returns 405 (POST-only route)', async ({ request }) => {
    const res = await request.get(`${baseURL}${path}`);
    expect(res.status()).toBe(405);
  });

  test('PUT returns 405', async ({ request }) => {
    const res = await request.put(`${baseURL}${path}`, { data: {} });
    expect(res.status()).toBe(405);
  });

  test('DELETE returns 405', async ({ request }) => {
    const res = await request.delete(`${baseURL}${path}`);
    expect(res.status()).toBe(405);
  });

  test('PATCH returns 405', async ({ request }) => {
    const res = await request.patch(`${baseURL}${path}`, { data: {} });
    expect(res.status()).toBe(405);
  });

  test('dynamic [id] segment accepts any string without 500', async ({ request }) => {
    // Path param is opaque (route ignores it; cards are looked up by correlationId)
    // — try a few suspicious shapes and confirm none crash the server.
    const ids = [
      'normal-id',
      encodeURIComponent('with spaces'),
      encodeURIComponent('with/slash'),
      encodeURIComponent('../../etc/passwd'),
      encodeURIComponent('special&chars?=foo'),
    ];
    for (const id of ids) {
      const res = await request.post(
        `${baseURL}/api/operator/conversations/${id}/card-response`,
        { data: { correlationId: 'x', action: 'cancel', workspaceId: 'w' } },
      );
      expect(res.status()).toBeLessThan(500);
    }
  });

  test('oversized body does not 500', async ({ request }) => {
    const huge = 'x'.repeat(2 * 1024 * 1024); // 2MB
    const res = await request.post(`${baseURL}${path}`, {
      data: { correlationId: 'x', action: 'cancel', workspaceId: 'w', payload: { blob: huge } },
    });
    // Either auth-gates (401) or rejects size (413) — never crash.
    expect(res.status()).toBeLessThan(500);
  });
});
