import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const h = vi.hoisted(() => ({ save: vi.fn(), engine: vi.fn(), publish: vi.fn(), sql: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('./text-artifacts', () => ({ saveTextArtifact: h.save }));
vi.mock('./report-library', () => ({ publishReport: h.publish }));
vi.mock('./unshipped-plans-audit', () => ({ runUnshippedPlansAudit: h.engine }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-workspace' }));
vi.mock('./harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'test-harness' }));
import { executePlanAudit, getPlanAuditRun, validateAuditRequest, type PlanAuditRun } from './plan-audit-runs';
const run: PlanAuditRun = { schemaVersion: 1, id: '12345678-1234-4567-89ab-123456789abc', workspace: 'test-workspace', harness: 'test-harness', scope: 'single', planSlugs: ['a'], status: 'running', startedAt: new Date().toISOString() };
beforeEach(() => { vi.clearAllMocks();h.save.mockResolvedValue(undefined);h.publish.mockResolvedValue({ reportId: 'rpt_test' }); });
describe('read-only audit run lifecycle', () => {
  it('rejects ambiguous/empty/over-wide selections rather than broadening to workspace', () => {
    expect(() => validateAuditRequest({ scope: 'visible', planSlugs: [] })).toThrow();
    expect(() => validateAuditRequest({ scope: 'single', planSlugs: ['a', 'b'] })).toThrow();
    expect(() => validateAuditRequest({ scope: 'workspace', planSlugs: ['a'] })).toThrow();
    expect(validateAuditRequest({ scope: 'single', planSlugs: [' a ', 'a'] })).toEqual({ scope: 'single', planSlugs: ['a'] });
  });
  it('publishes only after complete artifact generation and records a stable immutable report identity', async () => {
    h.engine.mockResolvedValue({ manifest: { rows: [{}], generatedAt: 'now' }, artifacts: { json: 'json-path' } });
    await executePlanAudit(run);
    expect(h.engine).toHaveBeenCalledWith(expect.objectContaining({ planSlugs: ['a'], artifactPrefix: 'reports/plan-audits/' + run.id }));
    expect(h.publish).toHaveBeenCalledWith(h.sql, expect.objectContaining({ visibility: 'owner', tags: ['plan-audit'] }), { harnessSlug: 'test-harness' });
    expect(h.publish.mock.calls[0][1].bodyMd).toContain('/adv?opcv=plans&paudit=' + run.id);
    expect(h.publish.mock.calls[0][1].bodyMd).not.toContain('](/?');
    expect(JSON.parse(h.save.mock.calls.at(-1)![2])).toMatchObject({ status: 'complete', reportId: 'rpt_test', rowCount: 1 });
  });
  it('never publishes a failed generation as success', async () => {
    h.engine.mockRejectedValue(new Error('missing selected plan'));
    await executePlanAudit(run);
    expect(h.publish).not.toHaveBeenCalled();
    expect(JSON.parse(h.save.mock.calls.at(-1)![2])).toMatchObject({ status: 'failed', error: 'missing selected plan' });
  });
  it('requests the full workspace census including historical plans for the all-plans action', async () => {
    h.engine.mockResolvedValue({ manifest: { rows: [{}], generatedAt: 'now' }, artifacts: { json: 'json-path' } });
    await executePlanAudit({ ...run, scope: 'workspace', planSlugs: undefined });
    expect(h.engine).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'test-workspace', planSlugs: undefined, includeHistorical: true }));
  });
  it('audit run never mutates plan lifecycle, blockers, claims or assignment', async () => {
    h.engine.mockResolvedValueOnce({ manifest: { rows: [{}], generatedAt: 'now' }, artifacts: { json: 'json-path' } });
    await executePlanAudit(run);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.sql).not.toHaveBeenCalled();
    h.engine.mockRejectedValueOnce(new Error('Unavailable evidence'));
    await executePlanAudit({ ...run, id: 'abcdefab-abcd-4abc-8abc-abcdefabcdef' });
    expect(h.sql).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledTimes(2);
    const source = readFileSync(new URL('./plan-audit-runs.ts', import.meta.url), 'utf8');
    expect(source.match(/saveTextArtifact\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+harness_shared|DELETE\s+FROM|MERGE\s+INTO)\b/i);
    expect(source).not.toMatch(/registerRoutine|setPlanStatus|setPlanItemStatus|setWorkItemState|armSchedule|setSchedule/);
  });
  it('terminalizes a persisted interrupted run and refuses mismatched workspace identity', async () => {
    h.sql.mockResolvedValueOnce([{ content: JSON.stringify({ ...run, startedAt: '2020-01-01T00:00:00Z' }) }]);
    expect(await getPlanAuditRun(run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
    h.sql.mockResolvedValueOnce([{ content: JSON.stringify({ ...run, workspace: 'foreign' }) }]);
    await expect(getPlanAuditRun(run.id)).rejects.toThrow('identity mismatch');
    await expect(getPlanAuditRun('../unsafe')).rejects.toThrow('Invalid');
  });
});
