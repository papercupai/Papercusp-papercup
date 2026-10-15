import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publish: vi.fn(), disabled: vi.fn(), audits: vi.fn(), failure: vi.fn(),
  sql: vi.fn(), useSql: false }));
vi.mock('./report-publication', () => ({ publishReportWithEffects: mocks.publish }));
vi.mock('./agent-tools/reports/_shared', () => ({ reportsLibraryDisabled: mocks.disabled }));
vi.mock('./report-library', () => ({ listReports: mocks.audits,
  ReportRequestConflictError: class ReportRequestConflictError extends Error {} }));
vi.mock('./harness/improvements/capture-core', () => ({ captureImprovement: mocks.failure }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: mocks.useSql ? mocks.sql : 'fixture-sql' }) }));
import { captureCoordReport, captureAcceptanceVerdict, captureAuditCompletion } from './report-capture';
import { ReportRequestConflictError } from './report-library';
const origin = { workspaceId: 'ws', ownerId: 'author', harnessSlug: 'pot', sessionRef: 'session' };
beforeEach(() => {
  vi.resetAllMocks(); mocks.useSql = false; mocks.disabled.mockResolvedValue(null); mocks.audits.mockResolvedValue([{ reportId: 'rpt_audit' }]);
  mocks.publish.mockResolvedValue({ report: { reportId: 'rpt_saved' }, eventEmitted: true });
  mocks.failure.mockResolvedValue({ created: true });
});
describe('Reports capture adapters', () => {
  it('preserves existing capture bytes when persisted JSON reorders members, while keeping publisher identity checks', async () => {
    const input = { ...origin, issueId: 'card-1', rubricRef: 'rubric', title: 'Verdict',
      body: 'Exact prose', ratings: { result: { rating: 'pass', evidence: 'measured' } } };
    await captureAcceptanceVerdict(input);
    const original = mocks.publish.mock.calls[0][1];
    mocks.useSql = true; mocks.sql.mockResolvedValue([{ body_md: original.bodyMd }]);
    mocks.publish.mockRejectedValueOnce(new ReportRequestConflictError(original.requestKey));
    expect(await captureAcceptanceVerdict({ ...input,
      ratings: { result: { evidence: 'measured', rating: 'pass' } } })).toBe('rpt_saved');
    expect(mocks.publish.mock.calls[1][1].bodyMd).not.toBe(original.bodyMd);
    expect(mocks.publish.mock.calls[2][1]).toEqual(original);
    expect(mocks.sql.mock.calls[0].slice(1)).toEqual(['ws', 'author', 'author:author', original.requestKey, 'capture:acceptance']);
    expect(mocks.failure).not.toHaveBeenCalled();
    // An origin/title/etc. conflict still belongs to the immutable publisher.
    mocks.publish.mockRejectedValue(new ReportRequestConflictError(original.requestKey));
    expect(await captureAcceptanceVerdict({ ...input, title: 'Changed title' })).toBeNull();
    expect(mocks.failure).toHaveBeenCalledTimes(1);
  });
  it.each(['verdict', 'prose', 'malformed'] as const)('refuses a capture retry with changed %s', async change => {
    const input = { ...origin, issueId: 'card-1', rubricRef: 'rubric', title: 'Verdict', body: 'Exact prose',
      ratings: { result: { rating: 'pass', evidence: 'measured' } } };
    await captureAcceptanceVerdict(input);
    const original = mocks.publish.mock.calls[0][1];
    mocks.useSql = true;
    mocks.sql.mockResolvedValue([{ body_md: change === 'malformed'
      ? original.bodyMd.replace('"ratings":', 'invalid:') : original.bodyMd }]);
    mocks.publish.mockRejectedValue(new ReportRequestConflictError(original.requestKey));
    expect(await captureAcceptanceVerdict({ ...input,
      ...(change === 'prose' ? { body: 'Changed prose' } : {}),
      ...(change === 'verdict' ? { ratings: { result: { rating: 'fail', evidence: 'measured' } } } : {}),
    })).toBeNull();
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.failure).toHaveBeenCalledTimes(1);
  });
  it('preserves a delivered card body, plan subject and server origin with a stable retry key', async () => {
    const input = { ...origin, msgId: 'message-1', summary: 'Progress', report: { title: 'Review', plans: [{ slug: 'plan-1', title: 'Plan',
      summary: 'Measured result', items: [{ id: 'P-1', text: 'Verified', status: 'done', ref: 'wi:WI-1' }] }] } };
    expect(await captureCoordReport(input)).toBe('rpt_saved');
    await captureCoordReport(input);
    const [, published, stamped] = mocks.publish.mock.calls[0];
    expect(published).toMatchObject({ visibility: 'owner', source: 'capture:coord', subject: { kind: 'plan', ref: 'plan-1' } });
    expect(published.bodyMd).toContain('P-1: Verified (done) — wi:WI-1');
    expect(stamped).toEqual({ authorOwnerId: 'author', harnessSlug: 'pot', authorSessionRef: 'session' });
    expect(mocks.publish.mock.calls[1][1].requestKey).toBe(published.requestKey);
  });
  it('copies exact acceptance evidence and gives independent verdicts distinct source keys', async () => {
    const input = { ...origin, issueId: 'card-1', rubricRef: 'acceptance-plan-1', title: 'Acceptance', planSlug: 'plan-1',
      ratings: { rendered: { rating: 'passed', evidence: 'native assertion' } }, acceptance: { verdict: 'accepted', reasoning: 'Verified' } };
    await captureAcceptanceVerdict(input);
    await captureAcceptanceVerdict({ ...input, issueId: 'card-2' });
    const first = mocks.publish.mock.calls[0][1];
    expect(first.kind).toBe('review'); expect(first.bodyMd).toContain('native assertion');
    expect(first.bodyMd).toContain('accepted');
    expect(mocks.publish.mock.calls[1][1].requestKey).not.toBe(first.requestKey);
  });
  it('captures a completed audit from exact persisted publication after audit mode exit', async () => {
    const input = { ...origin, itemId: 'WI-1', title: 'Program audit', completion: { summary: 'Measured verdict', testResult: 'passed' } };
    await captureAuditCompletion(input);
    expect(mocks.publish.mock.calls[0][1]).toMatchObject({ kind: 'audit', subject: { kind: 'work_item', ref: 'WI-1' } });
    expect(mocks.publish.mock.calls[0][1].bodyMd).toContain('testResult');
    expect(mocks.audits).toHaveBeenCalledWith('fixture-sql', {
      workspaceId: 'ws', viewer: { ownerId: 'author' }, kind: 'audit',
      subject: { kind: 'work_item', ref: 'WI-1' }, originOwnerId: 'author',
      originHarnessSlug: 'pot', source: 'agent', limit: 1,
    });
    mocks.publish.mockClear(); mocks.audits.mockResolvedValue([]);
    expect(await captureAuditCompletion(input)).toBeNull(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('honors the kill switch and files a source-addressable failure without failing the original verdict', async () => {
    const input = { ...origin, issueId: 'card-1', rubricRef: 'rubric', title: 'Verdict', ratings: {} };
    mocks.disabled.mockResolvedValue({ ok: false });
    expect(await captureAcceptanceVerdict(input)).toBeNull(); expect(mocks.publish).not.toHaveBeenCalled();
    mocks.disabled.mockResolvedValue(null); mocks.publish.mockRejectedValue(new Error('database unavailable'));
    expect(await captureAcceptanceVerdict(input)).toBeNull();
    expect(mocks.failure.mock.calls[0][0].body).toContain('card-1');
  });
});
