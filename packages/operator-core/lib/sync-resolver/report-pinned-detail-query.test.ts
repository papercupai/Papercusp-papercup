import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeGoalOwnerReportSnapshot } from '@papercusp/chat-protocol';
import { goalOwnerReportFixture } from '../../test/fixtures/goal-owner-report';

const { getReport } = vi.hoisted(() => ({ getReport: vi.fn() }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-card' }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
vi.mock('../report-library', async (actual) => ({
  ...await actual<typeof import('../report-library')>(), getReport,
}));
vi.mock('@papercusp/db-org', async (actual) => ({
  ...await actual<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: 'bound-sql' }),
}));
import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

describe('REPORT-PINNED-DETAIL-P003 exact report sync query', () => {
  beforeEach(() => vi.clearAllMocks());
  it('uses reports:get exact store/projection with the current workspace and human viewer, including retired pins', async () => {
    const snapshot = goalOwnerReportFixture('workspace-card');
    const bodyMd = serializeGoalOwnerReportSnapshot(snapshot);
    getReport.mockResolvedValue({
      workspaceId: snapshot.workspaceId, reportId: 'report-original', bodyMd, goalOwnerReport: snapshot,
      title: 'Pinned', summary: '', kind: 'progress', subject: { kind: 'goal', ref: snapshot.goalId, label: null },
      origin: { harnessSlug: 'papercusp', authorOwnerId: 'su-author', authorSessionRef: 'source' },
      visibility: 'owner', supersedesReportId: null, lineageId: 'report-original', source: 'agent', tags: [],
      publishedAt: snapshot.observedAt, updatedAt: snapshot.observedAt, retiredAt: snapshot.observedAt,
    });
    expect(knownQueryNamesV2()).toContain('reports.get');
    const rows = await resolveNamedQueryV2('reports.get', { reportId: 'report-original' });
    expect(getReport).toHaveBeenCalledExactlyOnceWith('bound-sql', 'workspace-card', 'report-original', { isOwner: true });
    expect(rows).toEqual([expect.objectContaining({ report_id: 'report-original', body_md: bodyMd,
      goal_owner_report: snapshot, retired_at: snapshot.observedAt, body_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  });
  it('keeps missing reports absent instead of substituting a lineage successor', async () => {
    getReport.mockResolvedValue(null);
    await expect(resolveNamedQueryV2('reports.get', { reportId: 'missing' })).resolves.toEqual([]);
  });
  it('does not accept a client-selected workspace or a blank report ID', async () => {
    await expect(resolveNamedQueryV2('reports.get', { reportId: 'report-original', workspaceId: 'other' })).rejects.toBeTruthy();
    await expect(resolveNamedQueryV2('reports.get', { reportId: '' })).rejects.toBeTruthy();
    expect(getReport).not.toHaveBeenCalled();
  });
});
