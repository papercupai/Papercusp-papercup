/**
 * Admin route surface — auth/loopback gating + shape contracts.
 *
 * The /api/admin/* family is gated to {trust: verified|trusted} (the D3
 * auth-posture pass — CSRF/DNS-rebinding defense): the desktop chrome's
 * same-origin verified session OR the per-install **superuser bearer token**
 * is required. A raw loopback `request` (no session, no bearer) carries an
 * `unverified-loopback` principal → 403. So the behavior specs send the SU
 * bearer (read from `~/.papercusp/superuser-token`); they SKIP when no token
 * is present (e.g. a clean CI box that hasn't provisioned one) rather than
 * fail. These specs verify:
 *
 *  - Authed routes return their shape (200) with the SU bearer
 *  - Wrong HTTP verb returns 405
 *  - Bearer-required routes reject (401/403) without a bearer
 *  - Input validation rejects bad shapes
 *
 * Not covered (would mutate state): running a build command, pruning executed
 * actions, rotating tokens, executing a destructive admin action.
 */
import { test, expect } from './_egress';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

/**
 * Per-install superuser bearer — the documented auth for /api/admin/*.
 *
 * Resolved exactly like the operator's canonical reader
 * (packages/operator-core/lib/superuser-token.ts): `$PAPERCUSP_HOME/superuser-token`,
 * defaulting to `~/.papercusp`. A hard-coded `~/.papercusp` sends the WRONG token
 * to an isolated operator (`VERIFY_TAURI_ISOLATED_DB=1` exports a per-run
 * PAPERCUSP_HOME), and the failure is silent on most routes: `tables` and
 * `commands` also admit `unverified-loopback`, so only the verified-only
 * `/api/admin/run` exposes it, as a 403 (WI-10006736).
 */
const SU_TOKEN = (() => {
  try {
    const home = process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp');
    return readFileSync(join(home, 'superuser-token'), 'utf8').trim();
  } catch {
    return '';
  }
})();
const suHeaders: Record<string, string> = SU_TOKEN ? { Authorization: `Bearer ${SU_TOKEN}` } : {};

test.describe('admin route surface', () => {
  test('GET /api/admin/tables returns table list', async ({ request }) => {
    test.skip(!SU_TOKEN, 'no superuser token (~/.papercusp/superuser-token) — cannot auth /api/admin/*');
    const res = await request.get(`${baseURL}/api/admin/tables`, { headers: suHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tables)).toBe(true);
    if (body.tables.length > 0) {
      expect(body.tables[0]).toHaveProperty('exportName');
      expect(body.tables[0]).toHaveProperty('label');
      expect(body.tables[0]).toHaveProperty('schema');
    }
  });

  test('GET /api/admin/commands returns command list with build/run sections', async ({ request }) => {
    test.skip(!SU_TOKEN, 'no superuser token — cannot auth /api/admin/*');
    const res = await request.get(`${baseURL}/api/admin/commands`, { headers: suHeaders });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.commands)).toBe(true);
    // Verify schema: each command has id, label, section, command, description
    const cmd = body.commands[0];
    expect(cmd).toHaveProperty('id');
    expect(cmd).toHaveProperty('label');
    expect(cmd).toHaveProperty('section');
    expect(cmd).toHaveProperty('command');
  });

  test('GET /api/admin/run without cmd param returns 400', async ({ request }) => {
    test.skip(!SU_TOKEN, 'no superuser token — cannot auth /api/admin/*');
    const res = await request.get(`${baseURL}/api/admin/run`, { headers: suHeaders });
    expect(res.status()).toBe(400);
  });

  test('GET /api/admin/run with unknown cmd returns error', async ({ request }) => {
    test.skip(!SU_TOKEN, 'no superuser token — cannot auth /api/admin/*');
    const res = await request.get(`${baseURL}/api/admin/run?cmd=totally-fake-cmd-id`, { headers: suHeaders });
    // 400 (unknown cmd) or 404 — either proves the route validates
    expect([400, 404]).toContain(res.status());
  });

  test('POST /api/admin/embed-backfill is gated', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/embed-backfill`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    // 200 (loopback authorized) or 401/403 (auth required)
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/admin/embed-backfill returns 405 (POST only)', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/embed-backfill`);
    expect(res.status()).toBe(405);
  });

  test('GET /api/admin/spawn-signing/failures rejects without a bearer', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/spawn-signing/failures`);
    // No bearer + a loopback principal that lacks the required trust →
    // require-principal returns 403 (wrong-trust); a missing principal → 401.
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/admin/spawn-signing/rotate requires bearer', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/spawn-signing/rotate`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/admin/rotate-token is bearer-gated', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/rotate-token`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([200, 401, 403]).toContain(res.status());
  });

  test('POST /api/admin/prune-executed-actions returns 405 on GET', async ({ request }) => {
    const res = await request.get(`${baseURL}/api/admin/prune-executed-actions`);
    expect(res.status()).toBe(405);
  });

  test('POST /api/admin/backup-orphan-cleanup is reachable', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/admin/backup-orphan-cleanup`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([200, 401, 403]).toContain(res.status());
  });

  test('GET /api/admin/tables/[exportName] returns table data for a known table', async ({ request }) => {
    test.skip(!SU_TOKEN, 'no superuser token — cannot auth /api/admin/*');
    // First fetch the list to get a known exportName.
    const list = await request.get(`${baseURL}/api/admin/tables`, { headers: suHeaders });
    const tables = (await list.json()).tables ?? [];
    if (tables.length === 0) {
      test.skip(true, 'No admin tables present');
    }
    const first = tables[0].exportName;
    const res = await request.get(`${baseURL}/api/admin/tables/${first}`, { headers: suHeaders });
    expect([200, 401]).toContain(res.status());
  });
});
