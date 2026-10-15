import type { ReportRecord } from '@papercusp/operator-core/lib/report-library';
import type { toReportFull, toReportSummary } from '@papercusp/operator-core/lib/agent-tools/reports/_shared';

// Shared only by tests. The server suite calibrates these mocked sync rows
// against the production wire projections used by the Reports resolver.
const body = '# Findings\n\n```mermaid\ngraph TD; A-->B\n```';
const digest = '2efa3def03e48d1fc0b59d57a2f0255a3be3e83f2e97b0f7b55e2fae28eb60e4';

export const reportRecordFixture: ReportRecord = {
  workspaceId: 'workspace-1', requestKey: null, reportId: 'edition-2', lineageId: 'edition-1',
  title: 'Private audit', summary: 'A saved audit', bodyMd: body, bodySha256: digest, goalOwnerReport: null,
  kind: 'audit', subject: { kind: 'plan', ref: 'example-plan', label: 'Example plan' },
  origin: { harnessSlug: 'pot-a', authorOwnerId: 'writer', authorSessionRef: 'session-1' },
  visibility: 'owner', source: 'native', tags: ['operations'],
  publishedAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z',
  retiredAt: null, supersedesReportId: 'edition-1',
};

export const reportFullFixture: ReturnType<typeof toReportFull> = {
  workspace_id: 'workspace-1', request_key: null, report_id: 'edition-2', lineage_id: 'edition-1',
  title: 'Private audit', summary: 'A saved audit', body_md: body, body_bytes: 42,
  body_sha256: digest, goal_owner_report: null, path: '/reports?sel=edition-2',
  kind: 'audit', subject: { kind: 'plan', ref: 'example-plan', label: 'Example plan' },
  origin: { harness_slug: 'pot-a', author_owner_id: 'writer', author_session_ref: 'session-1' },
  visibility: 'owner', source: 'native', tags: ['operations'],
  published_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z',
  retired_at: null, supersedes_report_id: 'edition-1',
};

const { body_md: _body, ...summary } = reportFullFixture;
export const reportSummaryFixture: ReturnType<typeof toReportSummary> = summary;
