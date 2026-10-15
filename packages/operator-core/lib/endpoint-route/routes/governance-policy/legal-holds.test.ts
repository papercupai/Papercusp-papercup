/**
 * The legal-hold doors (P-017b WI-6554700010012480): authorization comes first, refusals map to stable
 * codes, and each door runs its data-governance/legal-holds.ts operation as the authenticated admin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
vi.mock('../../../data-governance/siem-export-org-audit', () => ({ assertOrgAuditExportAuthorized: vi.fn() }));
vi.mock('../../../data-governance/legal-holds', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../data-governance/legal-holds')>();
  return { ...original, listOrganizationLegalHolds: vi.fn(), placeOrganizationLegalHold: vi.fn(), releaseOrganizationLegalHold: vi.fn() };
});

import { SiemExportAccessError } from '../../../data-governance/siem-export';
import { assertOrgAuditExportAuthorized } from '../../../data-governance/siem-export-org-audit';
import {
  LegalHoldError,
  listOrganizationLegalHolds,
  placeOrganizationLegalHold,
  releaseOrganizationLegalHold,
  type LegalHoldRecord,
} from '../../../data-governance/legal-holds';
import type { Sql } from 'postgres';
import routes, { LEGAL_HOLD_STATUS, setLegalHoldDoorSqlForTests } from './legal-holds';

// The doors hand this pool to the (mocked) operations; it is never queried here.
const POOL = Object.create(null) as Sql;
setLegalHoldDoorSqlForTests(POOL);

const [listRoute, placeRoute, releaseRoute] = routes;
const ORG = '11111111-1111-4111-8111-111111111111';

async function call(route: (typeof routes)[number], input: Record<string, unknown>, slug: string | null = 'tester') {
  const ctx = { input, principal: slug ? { slug } : null } as never;
  const res = (await route.handler(new Request('http://127.0.0.1/api/governance-policy/legal-holds'), ctx)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const HOLD: LegalHoldRecord = {
  holdId: 'h1', workspaceId: 'ws-active', dataSourceId: 'src', channelId: 'C1', reason: 'litigation',
  placedBy: 'admin:tester', placedAt: '2026-10-14T10:00:00.000Z', releasedAt: null, releasedBy: null,
  retained: [{ store: 'harness_shared.chat_messages', rows: 2 }],
};

beforeEach(() => {
  // The door ignores the authorization result; a reset mock resolves undefined, which is an allow.
  vi.mocked(assertOrgAuditExportAuthorized).mockReset();
  vi.mocked(listOrganizationLegalHolds).mockReset().mockResolvedValue([]);
  vi.mocked(placeOrganizationLegalHold).mockReset().mockResolvedValue({ hold: HOLD, auditEventId: 'e1' });
  vi.mocked(releaseOrganizationLegalHold).mockReset().mockResolvedValue({ hold: { ...HOLD, retained: null }, auditEventId: 'e2' });
});

describe('legal-hold doors (P-017b)', () => {
  it('serves three POST doors under /governance-policy/legal-holds', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /governance-policy/legal-holds/list',
      'POST /governance-policy/legal-holds/place',
      'POST /governance-policy/legal-holds/release',
    ]);
  });

  it('authorizes the admin over the organization, then runs as that admin on the request workspace', async () => {
    const out = await call(placeRoute, { organizationId: ORG, dataSourceId: 'src', channelId: 'C1', reason: 'litigation' });
    expect(out).toEqual({ status: 200, body: { ok: true, op: 'place', hold: HOLD, auditEventId: 'e1' } });
    expect(assertOrgAuditExportAuthorized).toHaveBeenCalledWith('admin:tester', ORG, { sql: POOL });
    expect(placeOrganizationLegalHold).toHaveBeenCalledWith(POOL, {
      scope: { organizationId: ORG, workspaceIds: ['ws-active'] }, actor: { kind: 'staff_admin', id: 'admin:tester' },
      workspaceId: 'ws-active', dataSourceId: 'src', channelId: 'C1', reason: 'litigation',
    });
    await call(listRoute, { organizationId: ORG, workspaceId: 'ws-2', includeReleased: true });
    expect(listOrganizationLegalHolds).toHaveBeenCalledWith(expect.anything(), {
      scope: { organizationId: ORG, workspaceIds: ['ws-2'] }, actor: { kind: 'staff_admin', id: 'admin:tester' }, includeReleased: true,
    });
  });

  it('refuses a principal without governance approve before touching any hold', async () => {
    vi.mocked(assertOrgAuditExportAuthorized).mockRejectedValue(new SiemExportAccessError('admin:tester lacks approve'));
    for (const [route, input] of [
      [listRoute, { organizationId: ORG }],
      [placeRoute, { organizationId: ORG, dataSourceId: 'src', reason: 'r' }],
      [releaseRoute, { organizationId: ORG, holdId: 'h1', reason: 'r' }],
    ] as const) {
      const out = await call(route, input);
      expect(out.status).toBe(403);
      expect(out.body).toMatchObject({
        ok: false,
        code: 'forbidden',
        refusal: {
          observed: { organizationApproval: 'not satisfied', requiredCapability: 'approve' },
          liftsWhen: expect.stringContaining('human administrator'),
          whoCanMakeItTrue: ['owner', 'host'],
        },
      });
    }
    expect(listOrganizationLegalHolds).not.toHaveBeenCalled();
    expect(placeOrganizationLegalHold).not.toHaveBeenCalled();
    expect(releaseOrganizationLegalHold).not.toHaveBeenCalled();
  });

  it('maps each legal-hold refusal to its status', async () => {
    for (const [code, status] of Object.entries(LEGAL_HOLD_STATUS)) {
      vi.mocked(releaseOrganizationLegalHold).mockRejectedValueOnce(new LegalHoldError(code as never, code));
      const out = await call(releaseRoute, { organizationId: ORG, holdId: 'h1', reason: 'r' });
      expect(out.status).toBe(status);
      expect(out.body).toMatchObject({ ok: false, op: 'release', code });
    }
  });

  it('rethrows an unexpected error instead of answering a refusal', async () => {
    vi.mocked(placeOrganizationLegalHold).mockRejectedValue(new Error('database down'));
    await expect(call(placeRoute, { organizationId: ORG, dataSourceId: 'src', reason: 'r' })).rejects.toThrow('database down');
  });
});
