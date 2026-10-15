/**
 * /user/integrations/tickets routes (plan linear-asana-task-sync-2026-10-05 P-007, D-014).
 *
 * The handlers are called directly with the module behind them mocked; the module's own behaviour
 * against Postgres is ticket-integrations.integration.test.ts. Covered here: the signed-in owner
 * and the server-derived workspace scope every call, path params and bodies reach the module,
 * writes invalidate the page's sync query, refusals map onto their HTTP status, and a cross-site
 * write is refused before anything runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';

const m = vi.hoisted(() => ({
  overview: vi.fn(),
  containers: vi.fn(),
  config: vi.fn(),
  setRule: vi.fn(),
  disableRule: vi.fn(),
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
vi.mock('../../integrations/ticket-integrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../integrations/ticket-integrations')>()),
  ticketIntegrationsOverview: m.overview,
  listTicketSourceContainers: m.containers,
  setTicketSourceConfig: m.config,
  setTicketSourceRule: m.setRule,
  disableTicketSourceRule: m.disableRule,
}));

import routes, { TICKET_INTEGRATIONS_QUERY } from '../routes/user/ticket-integrations';
import { TicketIntegrationError } from '../../integrations/ticket-integrations';
import { ProviderCapabilityUnsupported } from '../../capability-verbs/provider-dispatch';
import type { RouteContext } from '../define-route';

const SCOPE = { workspaceId: 'workspace-1', ownerUserId: OWNER };

function route(method: string, path: string) {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`no route ${method} ${path}`);
  return (req: Request, params: Record<string, string> = {}) =>
    Promise.resolve(found.handler(req, { principal: null, input: undefined, params, log: () => {}, signal: new AbortController().signal } as RouteContext));
}

const BASE = '/user/integrations/tickets';
const SRC = `${BASE}/sources/:sourceId`;
const overview = route('GET', BASE);
const containers = route('POST', `${SRC}/containers`);
const config = route('PATCH', `${SRC}/config`);
const addRule = route('POST', `${SRC}/rules`);
const disableRule = route('DELETE', `${SRC}/rules/:ruleId`);

function req(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3070/api/x', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => {
  for (const fn of [m.overview, m.containers, m.config, m.setRule, m.disableRule, m.notify]) fn.mockReset();
  m.notify.mockResolvedValue(undefined);
});

describe('reads', () => {
  it('GET returns the overview for the signed-in owner in the active workspace', async () => {
    m.overview.mockResolvedValue({ providers: [{ id: 'linear' }], sources: [] });
    const res = await overview(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, userId: OWNER, providers: [{ id: 'linear' }], sources: [] });
    expect(m.overview).toHaveBeenCalledWith(m.sql, SCOPE);
  });

  it('POST containers passes the path source and the picker args, and writes nothing', async () => {
    m.containers.mockResolvedValue({ containers: [{ id: 'team-a', name: 'A', kind: 'team' }], truncated: false });
    const res = await containers(req('POST', { args: { workspaceGid: 'ws-1' } }), { sourceId: SOURCE });
    expect(await res.json()).toEqual({ ok: true, containers: [{ id: 'team-a', name: 'A', kind: 'team' }], truncated: false });
    expect(m.containers).toHaveBeenCalledWith(m.sql, { ...SCOPE, sourceId: SOURCE, args: { workspaceGid: 'ws-1' } });
    expect(m.notify).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  it('PATCH config passes the patch and invalidates the page query', async () => {
    m.config.mockResolvedValue({ config: { teamIds: ['team-a'] }, missingConfig: [] });
    const res = await config(req('PATCH', { patch: { teamIds: ['team-a'] } }), { sourceId: SOURCE });
    expect(await res.json()).toEqual({ ok: true, config: { teamIds: ['team-a'] }, missingConfig: [] });
    expect(m.config).toHaveBeenCalledWith(m.sql, { ...SCOPE, sourceId: SOURCE, patch: { teamIds: ['team-a'] } });
    // Unscoped on purpose: the page's key is { userId }, so a { workspaceId, userId } notify
    // never matched it (WI-6554700010008519). toHaveBeenCalledWith is exact, so a scoped
    // notify fails here.
    expect(m.notify).toHaveBeenCalledWith(TICKET_INTEGRATIONS_QUERY);
  });

  it('PATCH config without a patch object is a 400 that reaches nothing', async () => {
    for (const body of ['not json', [], { patch: [] }, {}]) {
      const res = await config(req('PATCH', body), { sourceId: SOURCE });
      expect(res.status).toBe(400);
    }
    expect(m.config).not.toHaveBeenCalled();
  });

  it('POST rules attributes the rule to the owner and passes the preset fields', async () => {
    m.setRule.mockResolvedValue({ rule: { id: 'rule-1' }, backfill: { admitted: 2 } });
    const res = await addRule(req('POST', { preset: 'label', value: 'bug', harness: 'papercusp', workKind: 'task' }), { sourceId: SOURCE });
    expect(await res.json()).toEqual({ ok: true, rule: { id: 'rule-1' }, backfill: { admitted: 2 } });
    expect(m.setRule).toHaveBeenCalledWith(m.sql, {
      ...SCOPE, sourceId: SOURCE, preset: 'label', value: 'bug', harness: 'papercusp', workKind: 'task', createdBy: `owner:${OWNER}`,
    });
    expect(m.notify).toHaveBeenCalledWith(TICKET_INTEGRATIONS_QUERY);
  });

  it('DELETE a rule disables it by the path ids', async () => {
    m.disableRule.mockResolvedValue({ id: 'rule-1', enabled: false });
    const res = await disableRule(req('DELETE'), { sourceId: SOURCE, ruleId: 'rule-1' });
    expect(await res.json()).toEqual({ ok: true, rule: { id: 'rule-1', enabled: false } });
    expect(m.disableRule).toHaveBeenCalledWith(m.sql, { ...SCOPE, sourceId: SOURCE, ruleId: 'rule-1' });
  });

  it('a cross-site write is refused before the module runs', async () => {
    const res = await config(req('PATCH', { patch: {} }, { origin: 'https://evil.example' }), { sourceId: SOURCE });
    expect(res.status).toBe(403);
    expect(m.config).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });
});

describe('refusals map onto their status', () => {
  it('a module refusal keeps its code and status, and a refused write invalidates nothing', async () => {
    m.config.mockRejectedValue(new TicketIntegrationError('ticket_source_not_found', 'no source of yours', 404));
    const res = await config(req('PATCH', { patch: {} }), { sourceId: SOURCE });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'ticket_source_not_found' });
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('a provider without the capability is a 409 naming it', async () => {
    m.containers.mockRejectedValue(new ProviderCapabilityUnsupported('fixture', 'ticket.containers'));
    const res = await containers(req('POST', {}), { sourceId: SOURCE });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'provider_capability_unsupported' });
  });

  it('a provider auth signal is a 401; another provider signal is a 502; anything else is a 500', async () => {
    m.containers.mockRejectedValueOnce(Object.assign(new Error('token revoked'), { kind: 'auth' }));
    let res = await containers(req('POST', {}), { sourceId: SOURCE });
    expect([res.status, (await res.json()).error]).toEqual([401, 'provider_auth']);
    m.containers.mockRejectedValueOnce(Object.assign(new Error('slow down'), { kind: 'rate-limited' }));
    res = await containers(req('POST', {}), { sourceId: SOURCE });
    expect([res.status, (await res.json()).error]).toEqual([502, 'provider_rate-limited']);
    m.containers.mockRejectedValueOnce(new Error('boom'));
    res = await containers(req('POST', {}), { sourceId: SOURCE });
    expect([res.status, (await res.json()).error]).toEqual([500, 'ticket_integrations_failed']);
  });
});
