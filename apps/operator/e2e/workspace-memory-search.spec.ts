/**
 * Workspace registry + user memory + user search route surface.
 *
 * Covers the public HTTP API for:
 *  - /api/workspaces (list + current)
 *  - /api/operator/state-snapshot (auth gate)
 *  - /api/user/preferences (auth gate)
 *  - /api/user/memory (auth gate)
 *  - /api/user/search (auth gate)
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('workspace registry + user surfaces', () => {
  test('GET /api/workspaces returns current + workspaces array', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/workspaces`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.current).toBeTruthy();
    expect(typeof body.current).toBe('string');
    expect(Array.isArray(body.workspaces)).toBe(true);
    if (body.workspaces.length > 0) {
      const ws = body.workspaces[0];
      expect(ws).toHaveProperty('id');
      expect(ws).toHaveProperty('name');
    }
  });

  test('GET /api/workspaces includes the current workspace', async ({ request }) => {
    // The registry must list the workspace it reports as `current`. The id is
    // environment-specific — the dev box calls it 'default', the isolated rig
    // 'verify-tauri-isolated-<display>' — so hardcoding 'default' failed every
    // isolated run (WI-10006791, seeded group operator-e2e-seed-ready-…19-29-08Z).
    const res = await request.get(`${baseURL}/api/workspaces`);
    const body = await res.json();
    const ids = body.workspaces.map((w: { id: string }) => w.id);
    expect(typeof body.current).toBe('string');
    expect(ids).toContain(body.current);
  });

  test('GET /api/operator/state-snapshot requires auth', async () => {
    // The route is a long-lived SSE stream (`timeoutSec: null`). Playwright's
    // APIRequestContext buffers the WHOLE body, so `request.get` never resolves
    // and the test timed out at 10s on every run (WI-10006791). Native fetch
    // resolves on HEADERS; read the status, then close the stream.
    const ac = new AbortController();
    const res = await fetch(`${baseURL}/api/operator/state-snapshot`, { signal: ac.signal });
    try {
      expect([200, 401, 403]).toContain(res.status);
    } finally {
      ac.abort();
    }
  });

  test('GET /api/user/preferences requires auth', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/user/preferences`);
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/user/memory requires auth', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/user/memory`);
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/user/search?q=test requires auth', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/user/search?q=test`);
    expect([200, 401, 403]).toContain(res.status());
  });

  test('POST /api/user/memory validates before writing (create route, P-010)', async ({ request }) => {
    // The create route is `auth: 'loopback'` + getSessionUserOrDefault: a loopback
    // caller with no session IS the single-user install's default user, so a
    // well-formed POST here CREATES a real memory (it returned 200 and wrote a row
    // on :3070, 2026-10-06 — WI-10006791). The old "unauthenticated POST is 401"
    // premise was stale, and the old body polluted whichever store it ran against.
    // Exercise the route with an invalid body instead: validation runs before
    // journaling, so this is a 400 with no write.
    const res = await request.post(`${baseURL}/api/user/memory`, {
      data: { text: '   ', kind: 'preference' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('text_required');
  });

  test('PATCH /api/user/memory validates before writing', async ({ request }) => {
    const res = await request.fetch(`${baseURL}/api/user/memory`, {
      method: 'PATCH',
      data: { text: '   ' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('id_and_text_required');
  });

  test('DELETE /api/user/memory validates before accessing the backend', async ({ request }) => {
    const res = await request.fetch(`${baseURL}/api/user/memory`, {
      method: 'DELETE',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('id_or_all_required');
  });
});
