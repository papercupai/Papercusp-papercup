/**
 * CSRF backstop coverage for the two VTL coord admin routes (WI-5249):
 * POST /admin/coord/:verb and POST /admin/coord-inbox-reply both admit
 * `unverified-loopback` (cookie-less desktop webview, EI-338), so the
 * `requireAllowedOriginOr403` guard is what refuses a browser cross-origin
 * POST. The sibling deploy-accounts tests mock the guard away; this file
 * pins the actual refusal + pass-through behavior.
 *
 * Pass-through is asserted via each handler's own early exit (404
 * unknown_verb / 400 missing_fields) so no downstream coord write fires.
 */
import { describe, expect, it, vi } from 'vitest';

// proxy-host-extras' `runScoped` hands every proxied call a REAL admin pool via getOrgPg()
// (proxy-host-extras.ts:33). This CSRF test never queries it — a unit test must not open a live
// pool [EI-19311807188719573].
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const sql = Object.assign(async () => [], {
    unsafe: async () => [],
    // In-process tool dispatch queues telemetry for a debounced transaction.
    // Keep this mock complete enough for that background flush so it does not
    // emit a console warning into whichever later assertion happens to run.
    begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql),
  });
  return {
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql }),
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
  };
});
import coordRoutes from './coord';
import inboxReplyRoutes from './coord-inbox-reply';
import coordinationRoutes from './coordination';
import plansRoutes from './plans';

const coordWrite = coordRoutes[0];
const inboxReply = inboxReplyRoutes[0];
const coordination = coordinationRoutes[0];
const plansWrite = plansRoutes[1];

function post(path: string, origin: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== null) headers.origin = origin;
  return new Request(`http://127.0.0.1/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('coord admin routes — CSRF backstop (requireAllowedOriginOr403)', () => {
  it('admits the read-only wake-mode lookup and refuses its write shape', async () => {
    const readReq = post('/admin/coord/wake-mode', null, { agent: 'su-read-only' });
    const readRes = (await coordWrite.handler(readReq as never, { params: { verb: 'wake-mode' } } as never)) as Response;
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toMatchObject({ agent: 'su-read-only', mode: 'auto' });

    const writeReq = post('/admin/coord/wake-mode', null, { agent: 'su-read-only', mode: 'manual' });
    const writeRes = (await coordWrite.handler(writeReq as never, { params: { verb: 'wake-mode' } } as never)) as Response;
    expect(writeRes.status).toBe(405);
    expect(await writeRes.json()).toMatchObject({ error: { code: 'read_only_verb' } });
  });

  it('POST /admin/coord/:verb refuses a cross-origin browser POST', async () => {
    const req = post('/admin/coord/resolve', 'https://evil.example', { msg_id: 'x' });
    const res = (await coordWrite.handler(req as never, { params: { verb: 'resolve' } } as never)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin_blocked' });
  });

  it('POST /admin/coord-inbox-reply refuses a cross-origin browser POST', async () => {
    const req = post('/admin/coord-inbox-reply', 'https://evil.example', { askerId: 'a', text: 't' });
    const res = (await inboxReply.handler(req as never, {} as never)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin_blocked' });
  });

  it('allowed desktop-webview origins and no-Origin native fetches pass through', async () => {
    // coord/:verb — an unknown verb 404s AFTER the guard, proving pass-through.
    for (const origin of ['http://127.0.0.1:3055', 'tauri://tauri.localhost', null]) {
      const req = post('/admin/coord/nope', origin, {});
      const res = (await coordWrite.handler(req as never, { params: { verb: 'nope' } } as never)) as Response;
      expect(res.status, `coord/:verb origin=${origin}`).toBe(404);
    }
    // coord-inbox-reply — missing fields 400 AFTER the guard, same proof.
    for (const origin of ['http://localhost:3055', null]) {
      const req = post('/admin/coord-inbox-reply', origin, {});
      const res = (await inboxReply.handler(req as never, {} as never)) as Response;
      expect(res.status, `inbox-reply origin=${origin}`).toBe(400);
    }
  });
});

/**
 * WI-6486 — the coordination proxy joined the VTL set because the HUD's
 * conversation pane 403-blanked on the cookie-less desktop webview. Its
 * `unverified-loopback` admission rests entirely on the same CSRF backstop, and
 * this proxy reaches WRITE verbs (topics:create, conversations:post/answer/
 * resolve, coord:ask) — so if the guard is ever dropped from the dispatch, the
 * admission becomes a cross-origin write hole. These pin both halves.
 */
describe('coordination proxy — CSRF backstop (WI-6486)', () => {
  it('refuses a cross-origin browser POST', async () => {
    const req = post('/admin/coordination/sessions/list', 'https://evil.example', { owner: 'su-x' });
    const res = (await coordination.handler(req as never, {
      params: { group: 'sessions', verb: 'list' },
    } as never)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin_blocked' });
  });

  it('refuses a cross-origin POST to a WRITE verb too — not just the read', async () => {
    const req = post('/admin/coordination/topics/create', 'https://evil.example', { name: 'x' });
    const res = (await coordination.handler(req as never, {
      params: { group: 'topics', verb: 'create' },
    } as never)) as Response;
    expect(res.status).toBe(403);
  });

  it('lets desktop-webview origins and no-Origin native fetches through', async () => {
    // An unlisted verb 404s AFTER the guard, proving pass-through without
    // dispatching a real tool call.
    for (const origin of ['http://127.0.0.1:3055', 'tauri://tauri.localhost', null]) {
      const req = post('/admin/coordination/sessions/nope', origin, {});
      const res = (await coordination.handler(req as never, {
        params: { group: 'sessions', verb: 'nope' },
      } as never)) as Response;
      expect(res.status, `coordination origin=${origin}`).toBe(404);
    }
  });

  it('still exposes sessions:list — the lookup the HUD conversation depends on', async () => {
    // Guards the ALLOWED map itself: if `sessions.list` were dropped, the pane
    // would 404 instead of 403 and the symptom would look like a different bug.
    const req = post('/admin/coordination/sessions/list', null, { owner: 'su-x' });
    const res = (await coordination.handler(req as never, {
      params: { group: 'sessions', verb: 'list' },
    } as never)) as Response;
    expect(res.status).not.toBe(404);
  });

  it('still exposes coord:ask through the owner UI proxy', async () => {
    // Missing required args fails at the tool schema (400), proving the proxy
    // reached the UI-only handler instead of rejecting/omitting the verb.
    const req = post('/admin/coordination/coord/ask', null, {});
    const res = (await coordination.handler(req as never, {
      params: { group: 'coord', verb: 'ask' },
    } as never)) as Response;
    expect(res.status).toBe(400);
  });
});

/**
 * WI-6501 — POST /admin/plans/:verb joined the VTL set because the left sidebar's
 * plan load 403'd on the cookie-less desktop webview (owner-reported: "plans:get →
 * 403: trust unverified-loopback not in allowlist").
 *
 * The read half is what the owner hit, but widening the tier necessarily widened the
 * WRITE route too — and plans writes are not cosmetic (set-status, add-item, edit,
 * promote). So the CSRF guard is the only thing left standing between a foreign page
 * and a plan mutation. These pin it.
 */
describe('plans admin write route — CSRF backstop (WI-6501)', () => {
  it('refuses a cross-origin browser POST', async () => {
    const req = post('/admin/plans/set-status', 'https://evil.example', { slug: 'x', status: 'shipped' });
    const res = (await plansWrite.handler(req as never, { params: { verb: 'set-status' } } as never)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_origin_blocked' });
  });

  it('refuses BEFORE dispatching the verb — an unknown verb still 403s, not 404s', async () => {
    // Proves ordering: the guard runs ahead of verb resolution, so no write path is
    // reachable cross-origin even for a verb that would otherwise short-circuit.
    const req = post('/admin/plans/nope', 'https://evil.example', {});
    const res = (await plansWrite.handler(req as never, { params: { verb: 'nope' } } as never)) as Response;
    expect(res.status).toBe(403);
  });

  it('lets desktop-webview origins and no-Origin native fetches through', async () => {
    for (const origin of ['http://127.0.0.1:3055', 'tauri://tauri.localhost', null]) {
      const req = post('/admin/plans/nope', origin, {});
      const res = (await plansWrite.handler(req as never, { params: { verb: 'nope' } } as never)) as Response;
      expect(res.status, `plans origin=${origin}`).toBe(404);
    }
  });
});
