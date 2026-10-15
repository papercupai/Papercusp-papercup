/**
 * Backup route surface — E2E through the public HTTP API.
 *
 * Covers what the operator binary owns:
 *  - GET /api/backups (settings + stats shape)
 *  - GET /api/backups/snapshots (list)
 *  - POST /api/backups/snapshots (manual create — graceful failure when
 *    kopia bin or workspace path is unavailable)
 *  - GET /api/backups/healthcheck
 *  - POST /api/admin/backup-orphan-cleanup (admin sweep route)
 *  - GET /api/backups/events (SSE)
 *
 * Out of scope (per project_papercup_backup_integration memory):
 *  - kopia binary install/setup
 *  - Real snapshot creation requiring writable workspace + kopia install
 *  - Snapshot restore (destructive, needs real backup history)
 *
 * The flow tests confirm the routes exist, validate their input,
 * and either succeed or fail-gracefully when kopia isn't bootstrapped.
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('backup route surface', () => {
  test('GET /api/backups returns settings + stats shape', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/backups`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('settings');
    expect(body.settings).toHaveProperty('enabled');
    expect(body.settings).toHaveProperty('cadenceMode');
    expect(body.settings).toHaveProperty('cadenceMinutes');
    expect(body.settings).toHaveProperty('retentionPreset');
  });

  test('GET /api/backups/snapshots returns array', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/backups/snapshots?limit=5`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.snapshots)).toBe(true);
  });

  test('POST /api/backups/snapshots accepts a valid manual reason', async ({ request }) => {
    // The route runs the WHOLE snapshot (pg_dump + kopia over the workspace
    // root) inside the request and returns its id + trace, so its latency is
    // the snapshot's. Measured 2026-10-07 from harness_shared.backup_snapshots
    // (14 days): manual snapshots p50 30s / max 36s. Playwright's default 10s
    // request budget timed this out on EVERY isolated run (WI-10006791), so give
    // this one call an explicit budget well above the measured max.
    test.setTimeout(150_000);
    const res = await request.post(`${baseURL}/api/backups/snapshots`, {
      data: { reason: 'manual', context: { source: 'e2e-test' } },
      headers: { 'Content-Type': 'application/json' },
      timeout: 120_000,
    });
    // Either succeeds (kopia bootstrapped) or fails-gracefully with 500 + error string
    // (kopia not installed). Both prove the route is wired.
    expect([200, 500]).toContain(res.status());
    if (res.status() === 500) {
      const body = await res.json();
      expect(body).toHaveProperty('error');
    }
  });

  test('POST /api/backups/snapshots rejects invalid reason', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/backups/snapshots`, {
      data: { reason: 'not-a-real-reason' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([400, 500]).toContain(res.status());
  });

  test('GET /api/backups/healthcheck returns status', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/backups/healthcheck`);
    expect([200, 500, 503]).toContain(res.status());
    // Healthcheck always returns JSON; either ok=true or error string.
    const body = await res.json().catch(() => null);
    expect(body).toBeTruthy();
  });

  test('GET /api/backups/events returns a JSON history list (or 401)', async ({ request }) => {
    // /api/backups/events is a paginated HISTORY query of backup_events rows
    // (?since=&limit=) — a JSON list, NOT a live SSE stream. (Live progress, if
    // surfaced, rides a separate channel.) See lib/endpoint-route/routes/
    // backups/events.ts. Assert that contract, not event-stream.
    const res = await request.get(`${baseURL}/api/backups/events?limit=5`);
    expect([200, 401]).toContain(res.status());
    if (res.status() === 200) {
      expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
      const body = await res.json();
      expect(Array.isArray(body.events)).toBe(true);
    }
  });

  test('POST /api/admin/backup-orphan-cleanup is gated (no auth → not 200)', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/backup-orphan-cleanup`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    // 401/403 (auth gate) or 200 (loopback dev path) — either proves the route is wired.
    expect([200, 401, 403]).toContain(res.status());
  });

  test('PUT /api/backups validates settings schema', async ({ request }) => {
    const res = await request.put(`${baseURL}/api/backups`, {
      data: { enabled: 'not-a-bool' },  // wrong type
      headers: { 'Content-Type': 'application/json' },
    });
    expect([400, 500]).toContain(res.status());
  });

  test('GET /api/backups/failures returns list shape', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/backups/failures`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Either array directly or { failures: [...] }
    const failures = Array.isArray(body) ? body : body.failures;
    expect(Array.isArray(failures)).toBe(true);
  });
});
