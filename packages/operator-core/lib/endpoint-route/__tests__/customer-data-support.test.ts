import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Principal } from '@papercusp/agent-mcp';
const h = vi.hoisted(() => ({ cookie: vi.fn(), appKey: vi.fn() }));
vi.mock('../../auth/principal/from-cookie', () => ({ principalFromCookie: h.cookie }));
vi.mock('../../connected-apps/principal', () => ({ resolveAppKeyPrincipal: h.appKey }));
vi.mock('../../auth/principal/from-device-jwt', () => ({ principalFromDeviceJwt: vi.fn(async () => null) }));
vi.mock('../../auth/principal/from-bearer-token', () => ({ principalFromBearerToken: vi.fn(async () => null) }));
vi.mock('../../auth/principal/from-superuser-token', () => ({ principalFromSuperuserToken: vi.fn(async () => null) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../coverage-census/attribution/sink', () => ({ recordHttpTraffic: vi.fn() }));
import { createCustomerDataSupportRoutes, HOSTED_SUPPORT_STAFF_IDS_ENV } from '../routes/admin/customer-data';
import { CUSTOMER_DATA_EXPORT_SCOPE, CUSTOMER_DELETION_RECOVERY_SCOPE } from '../../data-governance/hosted-customer-data-support';
import { registerRoute } from '../define-route';

const organizationId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const staffId = '44444444-4444-4444-8444-444444444444';
const principal = (overrides: Partial<Principal> = {}): Principal => ({ kind: 'user', slug: staffId,
  workspaceId: 'ws', authMethod: 'cookie-session', trust: 'verified',
  capabilities: new Set([CUSTOMER_DATA_EXPORT_SCOPE, CUSTOMER_DELETION_RECOVERY_SCOPE]), ...overrides });
function fixture(useEnvironment = false) {
  const staff = new Set([staffId]);
  const exportData = vi.fn(async () => ({ receiptId: 'receipt', stores: [] }));
  const recoverDeletion = vi.fn(async () => ({ workflowId: 'original', operationId, outcome: 'resumed' as const }));
  const app = new Hono();
  for (const route of createCustomerDataSupportRoutes({ support: { exportData, recoverDeletion },
    ...(useEnvironment ? {} : { staffPrincipalIds: () => staff }) })) registerRoute(app, route);
  const post = (path: string, body: object, headers: Record<string, string> = {}) => app.request(`http://127.0.0.1${path}`, {
    method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { staff, exportData, recoverDeletion, post };
}
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); h.cookie.mockResolvedValue(principal()); h.appKey.mockResolvedValue(null); });

describe('internal operator customer-data support routes', () => {
  it('exports with the verified staff actor, no customer impersonation and no cache', async () => {
    const f = fixture(); const response = await f.post('/admin/customer-data/export', { organizationId, grantId });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.exportData).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ slug: staffId, roles: new Set(['staff']) }), { organizationId, grantId });
    expect(await response.json()).toEqual({ ok: true, result: { receiptId: 'receipt', stores: [] } });
  });

  it('recovers only the supplied immutable operation through the support service', async () => {
    const f = fixture(); const response = await f.post('/admin/customer-data/deletion/recover', { organizationId, grantId, operationId });
    expect(response.status).toBe(200);
    expect(f.recoverDeletion).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ slug: staffId }), { organizationId, grantId, operationId });
    expect(f.exportData).not.toHaveBeenCalled();
  });

  it.each([null, principal({ slug: 'foreign-staff' }), principal({ capabilities: new Set(['*']) }),
    principal({ authMethod: 'bearer-token' }), principal({ kind: 'system' }), principal({ trust: 'trusted' })])(
    'rejects missing or substituted staff authority at the mounted door', async actor => {
      const f = fixture(); h.cookie.mockResolvedValue(actor);
      expect((await f.post('/admin/customer-data/export', { organizationId, grantId })).status).toBeGreaterThanOrEqual(401);
      expect(f.exportData).not.toHaveBeenCalled(); expect(f.recoverDeletion).not.toHaveBeenCalled();
    });

  it('keeps operation scopes independent and observes staff removal immediately', async () => {
    const f = fixture(); h.cookie.mockResolvedValue(principal({ capabilities: new Set([CUSTOMER_DELETION_RECOVERY_SCOPE]) }));
    expect((await f.post('/admin/customer-data/export', { organizationId, grantId })).status).toBe(403);
    h.cookie.mockResolvedValue(principal()); f.staff.clear();
    expect((await f.post('/admin/customer-data/deletion/recover', { organizationId, grantId, operationId })).status).toBe(403);
    expect(f.exportData).not.toHaveBeenCalled(); expect(f.recoverDeletion).not.toHaveBeenCalled();
  });

  it('defaults to no staff admission and reads the server allowlist, never a client header', async () => {
    vi.stubEnv(HOSTED_SUPPORT_STAFF_IDS_ENV, ''); const f = fixture(true);
    expect((await f.post('/admin/customer-data/export', { organizationId, grantId }, { 'x-staff-id': staffId })).status).toBe(403);
    vi.stubEnv(HOSTED_SUPPORT_STAFF_IDS_ENV, staffId);
    expect((await f.post('/admin/customer-data/export', { organizationId, grantId })).status).toBe(200);
    vi.stubEnv(HOSTED_SUPPORT_STAFF_IDS_ENV, '');
    expect((await f.post('/admin/customer-data/export', { organizationId, grantId })).status).toBe(403);
  });

  it.each([{ staffId }, { policy: {} }, { workflowId: 'client-workflow' }, { role: 'staff' }])(
    'rejects client-supplied authority and workflow fields: %j', async extra => {
      const f = fixture(); expect((await f.post('/admin/customer-data/export', { organizationId, grantId, ...extra })).status).toBe(400);
      expect(f.exportData).not.toHaveBeenCalled();
    });

  it('blocks cross-origin and cross-site browser mutations before support execution', async () => {
    const f = fixture();
    const cases: Record<string, string>[] = [{ origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of cases) {
      expect((await f.post('/admin/customer-data/export', { organizationId, grantId }, headers)).status).toBe(403);
    }
    expect(f.exportData).not.toHaveBeenCalled();
  });

  it('returns a bounded refusal and never echoes database/provider errors', async () => {
    const f = fixture(); f.exportData.mockRejectedValueOnce(new Error('postgres://private-credential/customer-data'));
    const response = await f.post('/admin/customer-data/export', { organizationId, grantId });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'customer_data_support_operation_unavailable' });
  });
});
