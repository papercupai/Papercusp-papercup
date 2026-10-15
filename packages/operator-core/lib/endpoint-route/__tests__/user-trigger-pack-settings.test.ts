/**
 * Settings → Integrations trigger-pack writes (plan cupboard-distributable-integrations-2026-10-10
 * P-005): change a pack's inputs, and arm it against the review the owner saw.
 *
 *   PUT  /user/integrations/trigger-packs/:installationId/inputs  { inputs }
 *   POST /user/integrations/trigger-packs/:installationId/arm     { fingerprint }
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '22222222-2222-4222-8222-222222222222';
const PACK = '44444444-4444-4444-8444-444444444444';

const m = vi.hoisted(() => ({
  configure: vi.fn(),
  arm: vi.fn(),
  notify: vi.fn(async () => {}),
  sql: { test: true },
}));

vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: OWNER, username: 'owner', display_name: 'Owner', has_password: false })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-1' }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: m.sql }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: m.notify }));
vi.mock('../../cupboard/trigger-pack-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../cupboard/trigger-pack-lifecycle')>()),
  configureTriggerPack: m.configure,
  armTriggerPack: m.arm,
}));

import routes, { TICKET_INTEGRATIONS_QUERY } from '../routes/user/ticket-integrations';
import { TriggerPackLifecycleError } from '../../cupboard/trigger-pack-lifecycle';
import { TriggerPackMaterializeError } from '../../cupboard/trigger-pack-materialize';
import type { RouteContext } from '../define-route';

function route(method: string, path: string) {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`no route ${method} ${path}`);
  return (req: Request, params: Record<string, string> = {}) =>
    Promise.resolve(found.handler(req, { principal: null, input: undefined, params, log: () => {}, signal: new AbortController().signal } as RouteContext));
}

const BASE = '/user/integrations/trigger-packs/:installationId';
const setInputs = route('PUT', `${BASE}/inputs`);
const arm = route('POST', `${BASE}/arm`);

function req(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3070/api/x', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

const invalidatedQueries = () => m.notify.mock.calls.map((call) => (call as unknown[])[0]);

beforeEach(() => {
  for (const fn of [m.configure, m.arm, m.notify]) fn.mockReset();
  m.notify.mockResolvedValue(undefined);
});

describe('PUT inputs', () => {
  it('re-configures the pack with the new inputs as the owner and invalidates the page and triggers', async () => {
    m.configure.mockResolvedValue({
      id: PACK,
      status: 'configured',
      unmet: [],
      armed: false,
      review: { fingerprint: 'fp-2', reviewed: false },
    });
    const res = await setInputs(req('PUT', { inputs: { channel: 'C1' } }), { installationId: PACK });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      installationId: PACK,
      status: 'configured',
      unmet: [],
      armed: false,
      review: { fingerprint: 'fp-2', reviewed: false },
    });
    expect(m.configure).toHaveBeenCalledWith(m.sql, 'workspace-1', { installationId: PACK, inputs: { channel: 'C1' }, configuredBy: OWNER });
    expect(invalidatedQueries()).toEqual(expect.arrayContaining([TICKET_INTEGRATIONS_QUERY, 'externalTriggers.admin']));
  });

  it('a body without an inputs object is a 400 that reaches nothing', async () => {
    const res = await setInputs(req('PUT', { inputs: 'C1' }), { installationId: PACK });
    expect(res.status).toBe(400);
    expect(m.configure).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('an unknown installation is a 404 and an unsupported pack is a 422, each keeping its code', async () => {
    m.configure.mockRejectedValueOnce(new TriggerPackLifecycleError('not_found', 'no such pack'));
    const missing = await setInputs(req('PUT', { inputs: {} }), { installationId: PACK });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, error: 'not_found' });

    m.configure.mockRejectedValueOnce(new TriggerPackMaterializeError('trigger_pack_unsupported', 'nope'));
    const unsupported = await setInputs(req('PUT', { inputs: {} }), { installationId: PACK });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ ok: false, error: 'trigger_pack_unsupported' });
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('a cross-site write is refused before the module runs', async () => {
    const res = await setInputs(req('PUT', { inputs: {} }, { origin: 'https://evil.example' }), { installationId: PACK });
    expect(res.status).toBe(403);
    expect(m.configure).not.toHaveBeenCalled();
  });
});

describe('POST arm', () => {
  it('arms against the fingerprint the owner reviewed, recorded as the owner, and invalidates', async () => {
    m.arm.mockResolvedValue({ ok: true, installationId: PACK, fingerprint: 'fp-1', armedBindingIds: ['b1', 'b2'] });
    const res = await arm(req('POST', { fingerprint: 'fp-1' }), { installationId: PACK });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, installationId: PACK, fingerprint: 'fp-1', armedBindingIds: ['b1', 'b2'] });
    expect(m.arm).toHaveBeenCalledWith(m.sql, 'workspace-1', { installationId: PACK, fingerprint: 'fp-1', reviewedBy: OWNER });
    expect(invalidatedQueries()).toEqual(expect.arrayContaining([TICKET_INTEGRATIONS_QUERY, 'externalTriggers.admin']));
  });

  it('a review that changed since the owner saw it is a 409 carrying the new review, and arms nothing', async () => {
    m.arm.mockResolvedValue({ ok: false, error: 'trigger_pack_review_stale', installationId: PACK, review: { fingerprint: 'fp-2' } });
    const res = await arm(req('POST', { fingerprint: 'fp-1' }), { installationId: PACK });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'trigger_pack_review_stale', review: { fingerprint: 'fp-2' } });
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('a pack that still needs configuration is a 409; an unknown one is a 404', async () => {
    m.arm.mockResolvedValueOnce({ ok: false, error: 'trigger_pack_needs_configuration', installationId: PACK });
    expect((await arm(req('POST', { fingerprint: 'fp-1' }), { installationId: PACK })).status).toBe(409);
    m.arm.mockResolvedValueOnce({ ok: false, error: 'not_found', installationId: PACK });
    expect((await arm(req('POST', { fingerprint: 'fp-1' }), { installationId: PACK })).status).toBe(404);
  });

  it('arming without a fingerprint is a 400 that arms nothing', async () => {
    const res = await arm(req('POST', {}), { installationId: PACK });
    expect(res.status).toBe(400);
    expect(m.arm).not.toHaveBeenCalled();
  });
});
