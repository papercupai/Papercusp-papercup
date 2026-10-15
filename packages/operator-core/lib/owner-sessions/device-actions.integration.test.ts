import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { OrgTestDb } from '../../test/_org-test-db';
const NEVER_EMIT_MARKER = 'never-emit-me';
const h = vi.hoisted(() => ({ appSql: null as any }));
const routes = vi.hoisted(() => ({ grant: true, target: true, ended: false, protected: false,
  send: vi.fn(), end: vi.fn(), history: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async original => ({ ...(await original<typeof import('@papercusp/agent-mcp')>()), defineTool: (d: unknown) => d }));
vi.mock('../auth/principal/from-cookie', () => ({ principalFromCookie: async () => null }));
vi.mock('../auth/principal/from-superuser-token', () => ({ principalFromSuperuserToken: () => null }));
vi.mock('../auth/principal/from-bearer-token', () => ({ principalFromBearerToken: async () => null }));
vi.mock('../auth/principal/from-loopback', () => ({ principalFromLoopback: () => null }));
vi.mock('../connected-apps/principal', () => ({ resolveAppKeyPrincipal: async () => null }));
vi.mock('../device-store', async original => ({ ...(await original<typeof import('../device-store')>()), isRevoked: async () => false }));
vi.mock('../endpoint-route/telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../remote-auth-policy', async original => ({ ...(await original<typeof import('../remote-auth-policy')>()), isDirectRemoteRequest: () => false }));
vi.mock('./device-authority', () => ({ requireDeviceAgentSessions: async () => routes.grant ? null
  : Response.json({ error: 'agent_sessions_not_granted' }, { status: 403 }) }));
vi.mock('../endpoint-route/routes/device/sessions', async original => ({ ...(await original<typeof import('../endpoint-route/routes/device/sessions')>()), resolveDeviceSessionOwner: async () => routes.target
  ? { ok: true, row: { state: routes.ended ? 'ended' : 'parked' } }
  : { ok: false, response: Response.json({ error: 'session_not_in_workspace' }, { status: 404 }) } }));
vi.mock('./roster', () => ({ readSessionRosterSnapshot: async ({ workspaceId }: { workspaceId: string }) => ({ active: [{ ownerId: 'su-target', workspaceId,
  sessionState: 'parked', label: 'Audit test session', role: routes.protected ? 'green-checkpoint' : 'su', nativeSession: { backend: 'codex' } }], starting: [], pending: [], ended: [] }) }));
vi.mock('./transcript', () => ({ readOwnerHistoryPage: (...args: unknown[]) => routes.history(...args) }));
vi.mock('./actions', () => ({ sendOwnerSessionMessage: (...args: unknown[]) => routes.send(...args),
  endOwnerSession: (...args: unknown[]) => routes.end(...args), adminToolResultJson: (result: { parsed: unknown }) => result.parsed }));
vi.mock('../agent-tools/coordination/liveness-oracle', () => ({ resolveSessionStates: async () => new Map([['su-target', { sessionState: 'ended' }]]) }));
vi.mock('@papercusp/db-org', async original => ({ ...(await original<typeof import('@papercusp/db-org')>()),
  withWorkspace: (ws: string, cb: (tx: any) => unknown) => h.appSql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return cb(tx);
  }),
}));
import { auditDeviceAction, deviceActionKey, deviceActionRefusal, runDeviceAction, type DeviceActionContext } from './device-actions';
import { createOrgTestDb } from '../../test/_org-test-db';
import messageRoutes from '../endpoint-route/routes/device/session-messages';
import endRoutes from '../endpoint-route/routes/device/session-end';
import listRoutes from '../endpoint-route/routes/device/sessions';
import transcriptRoutes from '../endpoint-route/routes/device/session-transcript';
import { registerRoute, type RouteDefinition } from '../endpoint-route/define-route';
import { signDeviceToken, __resetDeviceJwtForTest } from '../device-jwt';
import { flushTrafficEvidence } from '../coverage-census/attribution/sink';
describe('device action receipts (real PG and RLS)', () => {
  let db: OrgTestDb;
  beforeAll(async () => { db = await createOrgTestDb(); h.appSql = db.appSql; }, Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 120_000);
  afterAll(async () => { await flushTrafficEvidence(); await db?.cleanup(); });
  beforeEach(() => {
    vi.stubEnv('MOBILE_JWT_SECRET', NEVER_EMIT_MARKER.repeat(3));
    __resetDeviceJwtForTest();
    routes.grant = true; routes.target = true; routes.ended = false; routes.protected = false;
    routes.send.mockReset().mockResolvedValue({ ok: true, delivery: { kind: 'queued' }, response: {} });
    routes.end.mockReset().mockResolvedValue({ status: 200, parsed: { ok: true, results: [{ ok: true }] } });
    routes.history.mockReset().mockResolvedValue({ ok: true, entries: [
      { kind: 'assistant', text: `API_KEY=${NEVER_EMIT_MARKER}` },
      { kind: 'tool_result', text: 'private-tool-output-never-show' },
    ], cursor: null, hasMore: false });
  });
  afterEach(() => { vi.unstubAllEnvs(); __resetDeviceJwtForTest(); });
  const context = (): DeviceActionContext => ({ principal: { kind: 'device', slug: `phone-${randomUUID()}`,
    workspaceId: `ws-${randomUUID()}`, authMethod: 'jwt', trust: 'verified', capabilities: new Set(['device:*']) },
    owner: 'su-target', action: 'send' });
  it('serializes concurrent network retries and stores one action audit row without message text', async () => {
    const c = context(); const run = vi.fn(async () => ({ status: 200, body: { ok: true, delivery: { kind: 'queued' } } }));
    const replies = await Promise.all(Array.from({ length: 4 }, () => runDeviceAction(c, 'same-key', { text: 'credential marker never stored' }, run)));
    expect(run).toHaveBeenCalledTimes(1);
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    const rows = await db.adminSql`SELECT * FROM harness_shared.audit_log WHERE workspace_id = ${c.principal.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: c.principal.slug, subject: c.owner, action: 'device.session.send' });
    expect(JSON.stringify(rows)).not.toContain('credential marker never stored');
  });
  it('refuses a changed body or target and audits each refusal without repeating the action', async () => {
    const c = context(); const run = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await runDeviceAction(c, 'key', { text: 'first' }, run);
    expect((await runDeviceAction(c, 'key', { text: 'changed' }, run)).status).toBe(409);
    expect((await runDeviceAction({ ...c, owner: 'su-other' }, 'key', { text: 'first' }, run)).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
    const rows = await db.adminSql`SELECT details FROM harness_shared.audit_log WHERE workspace_id = ${c.principal.workspaceId}`;
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.details.reason === 'idempotency_conflict')).toHaveLength(2);
  });
  it('scopes the same key separately for two phones and two workspaces', async () => {
    const a = context(); const b = { ...a, principal: { ...a.principal, slug: 'phone-b' } };
    const foreign = { ...a, principal: { ...a.principal, workspaceId: `ws-${randomUUID()}` } };
    const run = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await Promise.all([a, b, foreign].map(c => runDeviceAction(c, 'shared-key', {}, run)));
    expect(run).toHaveBeenCalledTimes(3);
    expect(deviceActionKey(a, 'shared-key')).not.toBe(deviceActionKey(foreign, 'shared-key'));
  });
  it('writes an authenticated refusal once with device, target and reason', async () => {
    const c = context();
    await auditDeviceAction(c, deviceActionRefusal('agent_sessions_not_granted'));
    const rows = await db.adminSql`SELECT details FROM harness_shared.audit_log WHERE workspace_id = ${c.principal.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ deviceId: c.principal.slug, owner: c.owner, reason: 'agent_sessions_not_granted', status: 403 });
  });
  const callRoute = async (c: DeviceActionContext, body: unknown, invalidJson = false) => {
    const route = c.action === 'send' ? messageRoutes[0] : endRoutes[0];
    const app = new Hono();
    registerRoute(app, route as RouteDefinition<undefined>);
    const token = signDeviceToken({ sub: c.principal.slug, workspace_id: c.principal.workspaceId, device_kind: 'mobile' });
    return app.request('/device/sessions/' + c.owner + (c.action === 'send' ? '/messages' : '/end'),
      { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: invalidJson ? '{invalid-json' : JSON.stringify(body) });
  };
  it.each([
    ['send', 'missing-key', 'idempotency_key_required', 400],
    ['send', 'invalid-message', 'invalid_message', 400],
    ['send', 'foreign-target', 'session_not_in_workspace', 404],
    ['send', 'ended-target', 'session_ended', 409],
    ['send', 'action-failed', 'session_send_failed', 502],
    ['send', 'no-grant', 'agent_sessions_not_granted', 403],
    ['send', 'invalid-json', 'invalid_json', 400],
    ['end', 'invalid-key', 'invalid_idempotency_key', 400],
    ['end', 'protected-target', 'protected_session', 403],
    ['end', 'foreign-target', 'session_not_in_workspace', 404],
    ['end', 'action-failed', 'session_end_failed', 502],
    ['end', 'no-grant', 'agent_sessions_not_granted', 403],
    ['end', 'invalid-json', 'invalid_json', 400],
  ] as const)('persists exactly one identified %s refusal for %s', async (action, scenario, reason, status) => {
    const c = { ...context(), action };
    let body: Record<string, unknown> = { text: 'private request body', idempotencyKey: 'request-key' };
    if (scenario === 'missing-key') body = { text: 'private request body' };
    if (scenario === 'invalid-message') body.text = '';
    if (scenario === 'invalid-key') body.idempotencyKey = '';
    if (scenario === 'foreign-target') routes.target = false;
    if (scenario === 'ended-target') routes.ended = true;
    if (scenario === 'protected-target') routes.protected = true;
    if (scenario === 'no-grant') routes.grant = false;
    if (scenario === 'action-failed') {
      routes.send.mockResolvedValue({ ok: false, status: 502 });
      routes.end.mockResolvedValue({ status: 200, parsed: { ok: false } });
    }
    const response = await callRoute(c, body, scenario === 'invalid-json');
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: reason });
    const rows = await db.adminSql`SELECT actor, subject, action, details FROM harness_shared.audit_log WHERE workspace_id = ${c.principal.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: c.principal.slug, subject: c.owner, action: 'device.session.' + action,
      details: { deviceId: c.principal.slug, owner: c.owner, action, reason, status } });
    expect(JSON.stringify(rows)).not.toContain('private request body');
    if (scenario !== 'action-failed') { expect(routes.send).not.toHaveBeenCalled(); expect(routes.end).not.toHaveBeenCalled(); }
  });
  it.each(['send', 'end'] as const)('persists one accepted %s receipt across route retries', async action => {
    const c = { ...context(), action };
    const body = { text: 'private request body', idempotencyKey: 'request-key' };
    expect((await callRoute(c, body)).status).toBe(200);
    expect((await callRoute(c, body)).status).toBe(200);
    expect(action === 'send' ? routes.send : routes.end).toHaveBeenCalledTimes(1);
    const rows = await db.adminSql`SELECT actor, subject, action, details FROM harness_shared.audit_log WHERE workspace_id = ${c.principal.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: c.principal.slug, subject: c.owner, action: 'device.session.' + action,
      details: { deviceId: c.principal.slug, owner: c.owner, action, status: 200 } });
    expect(JSON.stringify(rows)).not.toContain('private request body');
  });
  const getRoute = async (path: string) => {
    const c = context(); const app = new Hono();
    for (const route of [...listRoutes, ...transcriptRoutes]) registerRoute(app, route as RouteDefinition<undefined>);
    const token = signDeviceToken({ sub: c.principal.slug, workspace_id: c.principal.workspaceId, device_kind: 'mobile' });
    return app.request(path, { headers: { authorization: 'Bearer ' + token } });
  };
  it('reads the device workspace roster through the real authenticated mount', async () => {
    const response = await getRoute('/device/sessions');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ ownerId: 'su-target', label: 'Audit test session' });
  });
  it('returns a bounded redacted transcript through the real authenticated mount', async () => {
    const response = await getRoute('/device/sessions/su-target/transcript');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ kind: 'assistant', text: expect.stringContaining('API_KEY=[redacted]') });
    expect(JSON.stringify(body)).not.toContain(NEVER_EMIT_MARKER);
    expect(JSON.stringify(body)).not.toContain('private-tool-output-never-show');
    expect(routes.history).toHaveBeenCalledWith('su-target', { cursorRaw: null, cap: 50 });
  });
});
