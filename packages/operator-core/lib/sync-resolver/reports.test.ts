import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listReports, listReportLineage, getFlag } = vi.hoisted(() => ({
  listReports: vi.fn(), listReportLineage: vi.fn(), getFlag: vi.fn(),
}));
vi.mock('../report-library', async actual => ({ ...await actual<typeof import('../report-library')>(), listReports, listReportLineage }));
vi.mock('@papercusp/db-org', async actual => ({ ...await actual<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: 'bound-sql' }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'bound-workspace' }));
vi.mock('@papercusp/flags/server', () => ({ getFlag }));
import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

const report = {
  workspaceId: 'bound-workspace', reportId: 'rpt-fixture', title: 'Audit', summary: 'Summary', bodyMd: 'private body',
  kind: 'audit', subject: { kind: 'plan', ref: 'reports-library-2026-09-15', label: null },
  origin: { harnessSlug: 'papercusp', authorOwnerId: 'su-author', authorSessionRef: 'session' },
  visibility: 'owner', supersedesReportId: null, lineageId: 'rpt-fixture', source: 'agent', tags: ['series:ai'],
  publishedAt: '2026-10-07T12:00:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z', retiredAt: null,
};
beforeEach(() => {
  vi.clearAllMocks(); getFlag.mockResolvedValue(true);
  listReports.mockResolvedValue([report]); listReportLineage.mockResolvedValue([report]);
});

describe('Reports sync reads (P-006)', () => {
  it('registers list, legacy producer alias, detail and lineage on the same store', () => {
    expect(knownQueryNamesV2()).toEqual(expect.arrayContaining(['reports.list', 'reports.library', 'reports.get', 'reports.lineage']));
  });
  it('binds owner authority/workspace server-side, threads filters/cursor, and omits bodies from the list', async () => {
    const args = { kind: 'audit', visibility: 'owner', tags: ['series:ai'], since: '2026-10-01T00:00:00Z',
      cursor: { publishedAt: '2026-10-07T13:00:00Z', reportId: 'cursor' }, limit: 5 };
    const rows = await resolveNamedQueryV2('reports.list', args);
    expect(listReports).toHaveBeenCalledWith('bound-sql', { ...args, workspaceId: 'bound-workspace', viewer: { isOwner: true } });
    expect(rows).toEqual([expect.objectContaining({ report_id: 'rpt-fixture', visibility: 'owner' })]);
    if (!Array.isArray(rows)) throw new Error('reports.list returned the unknown-query sentinel');
    expect(rows[0]).not.toHaveProperty('body_md');
  });
  it.each(['workspaceId', 'viewer', 'isOwner', 'ownerId'])('rejects client-selected authority %s', async field => {
    await expect(resolveNamedQueryV2('reports.list', { [field]: 'forged' })).rejects.toBeTruthy();
    expect(listReports).not.toHaveBeenCalled();
  });
  it('keeps retired history reachable and owner-gated', async () => {
    await resolveNamedQueryV2('reports.lineage', { lineageId: 'root' });
    expect(listReportLineage).toHaveBeenCalledWith('bound-sql', 'bound-workspace', 'root', { isOwner: true });
  });
  it('gates UI store reads when the feature is disabled', async () => {
    getFlag.mockResolvedValue(false);
    await expect(resolveNamedQueryV2('reports.list', {})).rejects.toThrow('disabled');
    await expect(resolveNamedQueryV2('reports.lineage', { lineageId: 'root' })).rejects.toThrow('disabled');
    expect(listReports).not.toHaveBeenCalled(); expect(listReportLineage).not.toHaveBeenCalled();
  });
});
