import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanIndexRow } from './agent-tools/plans/source';

// Control canonical read seams while executing the production selection,
// classification, manifest, rendering and artifact-publication pipeline.
const h = vi.hoisted(() => ({ plans: vi.fn(), sql: vi.fn(), save: vi.fn() }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./agent-tools/plans/source', () => ({ listPlanIndexRowsForWorkspace: h.plans }));
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [{ slug: 'audit-harness' }] }) }));
vi.mock('./agent-tools/coordination/presence-snapshot', () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: async () => ({ active: [], as_of: '2026-10-07T00:00:00Z' }),
}));
vi.mock('./issue-blocks-merge', async importOriginal => ({
  ...await importOriginal<typeof import('./issue-blocks-merge')>(),
  getAllBlockedPlanItems: async () => new Map(),
}));
vi.mock('./rubrics', () => ({ listRubrics: async () => [] }));
vi.mock('./text-artifacts', () => ({ saveTextArtifact: h.save }));
vi.mock('./plan-acceptance-gate', () => ({ evaluatePlanAcceptanceGate: vi.fn() }));
import { runUnshippedPlansAudit } from './unshipped-plans-audit';

const row = (slug: string, overrides: Partial<PlanIndexRow> = {}): PlanIndexRow => ({
  workspaceId: 'audit-workspace', harnessSlug: 'audit-harness', planSlug: slug,
  title: slug, status: 'active', archived: false, templateSlug: null,
  items: [{ id: 'P-001', status: 'todo', text: 'Preserved evidence', importance: 'normal', blockedBy: [], decisionRefs: [], phase: null }],
  nowState: 'Evidence for ' + slug, nowNext: 'Review ' + slug,
  isBlenderOrigin: false, ...overrides,
} as PlanIndexRow);

beforeEach(() => {
  vi.clearAllMocks();
  h.plans.mockResolvedValue([row('alpha'), row('historical', { status: 'superseded', archived: true }), row('outside')]);
  h.sql.mockImplementation(async (parts: TemplateStringsArray) => {
    if (!parts.join('').trim().startsWith('SELECT')) throw new Error('Audit attempted subject mutation');
    return [];
  });
  h.save.mockResolvedValue(undefined);
});

describe('explicit population through the audit pipeline', () => {
  it('publishes exactly the selected historical and active plans with their original evidence', async () => {
    const result = await runUnshippedPlansAudit({ workspaceId: 'audit-workspace', artifactHarness: 'audit-harness', planSlugs: ['alpha', 'historical'], includeHistorical: true, artifactPrefix: 'reports/plan-audits/scoped_test' });
    expect(result.manifest.rows.map(r => r.slug).sort()).toEqual(['alpha', 'historical']);
    expect(result.manifest.rows.find(r => r.slug === 'historical')).toMatchObject({ status: 'superseded', nowState: 'Evidence for historical', nowNext: 'Review historical' });
    expect(h.plans).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'audit-workspace', includeArchived: true, includeInstances: true }));
    expect(h.save).toHaveBeenCalledTimes(2);
    const json = h.save.mock.calls.find(call => call[1].endsWith('/audit.json'))!;
    const html = h.save.mock.calls.find(call => call[1].endsWith('/report.html'))!;
    expect(json[0]).toBe('audit-harness');
    expect(JSON.parse(json[2])).toEqual(result.manifest);
    const embedded = html[2].match(/<script[^>]*id="audit"[^>]*>([\s\S]*?)<\/script>/)![1];
    expect(JSON.parse(embedded)).toEqual(result.manifest);
    expect(h.sql.mock.calls.every(call => call[0].join('').trim().startsWith('SELECT'))).toBe(true);
  });

  it('refuses an unavailable selection before publishing any report', async () => {
    await expect(runUnshippedPlansAudit({ workspaceId: 'audit-workspace', planSlugs: ['foreign-plan'] })).rejects.toThrow('unavailable plans');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('publishes the full workspace census including archived, superseded, rubric and scheduled-instance rows', async () => {
    const plans = [row('active'), row('archived', { archived: true }), row('superseded', { status: 'superseded' }), row('rubric', { template: 'rubric' }), row('instance', { templateSlug: 'scheduled-parent' }), row('unknown', { harnessSlug: 'unavailable' })];
    h.plans.mockResolvedValue(plans);
    const result = await runUnshippedPlansAudit({ workspaceId: 'audit-workspace', artifactHarness: 'audit-harness', includeHistorical: true, artifactPrefix: 'reports/plan-audits/workspace_test' });
    expect(h.plans).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: true, includeInstances: true }));
    expect(result.manifest.rows.map(r => r.slug).sort()).toEqual(plans.map(p => p.planSlug).sort());
    expect(result.manifest.scope.listedAtSnapshot).toBe(plans.length);
    expect(result.manifest.rows.find(r => r.slug === 'unknown')).toMatchObject({ status: 'unknown' });
    for (const value of Object.values(result.manifest.scope.census)) expect(value).toEqual({ listed: 1, included: 1, excluded: 0, exclusionReason: null });
    const saved = JSON.parse(h.save.mock.calls.find(call => call[1].endsWith('/audit.json'))![2]);
    expect(saved.rows.map((r: { slug: string }) => r.slug).sort()).toEqual(plans.map(p => p.planSlug).sort());
    expect(saved.scope.census).toEqual(result.manifest.scope.census);
  });
});
