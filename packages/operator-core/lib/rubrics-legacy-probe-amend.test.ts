import { describe, expect, it, vi } from 'vitest';

const projectedTools = vi.hoisted(() => [
  {
    expose: { mcp: { name: 'status:read' } },
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
    effect: 'read',
  },
]);

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  listAllProjectedTools: () => projectedTools,
  projectedToolRegistryRevision: (tools: Array<{ expose: { mcp: { name: string } } }>) =>
    `rev:${tools.map((tool) => tool.expose.mcp.name).join(',')}`,
}));

import { acceptanceBarMeaningUnchanged, applyRubricAmendment, migrateLegacyCriterionProbeRevisions, type Rubric } from './rubrics';
import { continuityProbeRevision } from './continuity-probes';

describe('acceptance BAR amendments with legacy continuity probes', () => {
  it('classifies meaning from the stored BAR-set hash without rebuilding the old snapshot', () => {
    const stored = 'a'.repeat(64);

    expect(acceptanceBarMeaningUnchanged(stored, stored)).toBe(true);
    expect(acceptanceBarMeaningUnchanged(stored, 'b'.repeat(64))).toBe(false);
  });

  it('returns null for non-BAR callers so their canonical fallback remains available', () => {
    expect(acceptanceBarMeaningUnchanged(null, 'a'.repeat(64))).toBeNull();
    expect(acceptanceBarMeaningUnchanged(undefined, undefined)).toBeNull();
  });

  it('migrates an unchanged stale probe revision through the current writer contract', () => {
    const currentRevision = continuityProbeRevision('status:read');
    expect(currentRevision).toBeTruthy();
    const staleProbe = {
      kind: 'tool' as const,
      tool: 'status:read',
      args: { id: 'legacy' },
      schemaRevision: 'projected-tool-registry-v1:retired',
      expect: { path: '$.state', op: 'exists' as const },
    };

    const amended = applyRubricAmendment({
      rubricId: 'legacy-rubric',
      kind: 'acceptance',
      workspaceId: 'ws-test',
      subjectPlan: 'subject-plan',
      subjectHarnessSlug: 'papercusp',
      characteristic: 'legacy probe migration',
      title: 'Legacy probe migration',
      description: '',
      criteria: [{
        key: 'legacy-probe',
        title: 'Legacy probe',
        model: 'The probe remains healthy.',
        method: 'Read status.',
        driftMarkers: 'The probe fails.',
        check: { kind: 'probe' as const, all: [staleProbe] },
      }],
      ratingScale: ['healthy', 'broken'],
      status: 'active',
      createdBy: 'owner',
      revision: 1,
    } as unknown as Rubric, {
      rubricId: 'legacy-rubric',
      methodRef: 'updated-method',
    });
    const migrated = amended.criteria[0];

    expect(migrated?.check).toMatchObject({
      kind: 'probe',
      all: [{ schemaRevision: currentRevision }],
    });
  });

  it('keeps an incompatible stale probe unchanged so current validation still refuses it', () => {
    const staleProbe = {
      kind: 'tool' as const,
      tool: 'status:read',
      args: { unexpected: true },
      schemaRevision: 'projected-tool-registry-v1:retired',
      expect: { path: '$.state', op: 'exists' as const },
    };

    const [candidate] = migrateLegacyCriterionProbeRevisions([{
      key: 'incompatible-probe',
      check: { kind: 'probe' as const, probe: staleProbe },
    }]);

    expect(candidate?.check).toMatchObject({ probe: staleProbe });
  });
});
