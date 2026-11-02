import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerProjectedTool, unregisterProjectedToolsForPlugin } from '@papercusp/tooldef';

import { acceptanceBarAmendmentCriterionChanges, acceptanceBarMeaningUnchanged, applyRubricAmendment, migrateLegacyCriterionProbeRevisions, type Rubric } from './rubrics';
import { continuityProbeRevision } from './continuity-probes';

// Rubric imports can initialize the continuity reader before a barrel mock.
// Register the fixture through the same pinned catalog that reader consumes.
beforeAll(() => registerProjectedTool({
  pluginName: 'rubrics-legacy-probe-fixture',
  description: 'Read the fixture status',
  capabilities: [],
  expose: { mcp: { name: 'status:read' } },
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
  effect: 'read',
  fn: async () => ({ content: [{ type: 'text', text: '{"state":"healthy"}' }] }),
}));
afterAll(() => unregisterProjectedToolsForPlugin('rubrics-legacy-probe-fixture'));

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

  it.each(['probe', 'all'] as const)('pins the writer-only live revision in a %s check before storage', (field) => {
    const liveProbe = {
      kind: 'tool' as const,
      tool: 'status:read',
      args: { id: 'incoming' },
      schemaRevision: 'live',
      expect: { path: '$.state', op: 'exists' as const },
    };
    const check = field === 'probe'
      ? { kind: 'probe' as const, probe: liveProbe }
      : { kind: 'probe' as const, all: [liveProbe] };

    const [candidate] = migrateLegacyCriterionProbeRevisions([{ key: 'incoming-probe', check }]);
    const pinned = { ...liveProbe, schemaRevision: continuityProbeRevision('status:read') };

    expect(candidate?.check).toEqual(field === 'probe'
      ? { kind: 'probe', probe: pinned }
      : { kind: 'probe', all: [pinned] });
    expect(liveProbe.schemaRevision).toBe('live');
  });

  it('captures generated probe changes alongside a method-only amendment for independent comparison', () => {
    const before = [{
      key: 'r-3', barKey: 'R-3', title: 'Frontier', model: 'The frontier is complete.',
      method: 'Read the old frontier.', driftMarkers: 'A frontier entry is missing.',
    }, {
      key: 'r-5', barKey: 'R-5', title: 'Adoption', model: 'The runtime contains the source.',
      method: 'Read status.', driftMarkers: 'Source containment is missing.',
      check: { kind: 'probe' as const, probe: {
        kind: 'tool' as const, tool: 'status:read', args: { id: 'original' },
        schemaRevision: 'projected-tool-registry-v1:retired',
        expect: { path: '$.state', op: 'exists' as const },
      } },
    }];
    const rubric = { rubricId: 'legacy-rubric', kind: 'acceptance', criteria: before } as unknown as Rubric;
    const after = applyRubricAmendment(rubric, { rubricId: rubric.rubricId,
      criterion: { key: 'r-3', field: 'method', mode: 'replace', text: 'Read the complete frontier.' },
    }).criteria;
    const changes = acceptanceBarAmendmentCriterionChanges(before, after, ['R-3', 'R-5']);

    expect(changes).toEqual([
      { barKey: 'R-3', before: before[0], after: after[0] },
      { barKey: 'R-5', before: before[1], after: after[1] },
    ]);
    expect(changes[1]?.before?.check).toMatchObject({ probe: { schemaRevision: 'projected-tool-registry-v1:retired' } });
    expect(changes[1]?.after?.check).toMatchObject({ probe: { schemaRevision: continuityProbeRevision('status:read') } });
  });

  it('represents added and removed criteria explicitly and omits unchanged criteria', () => {
    const kept = { key: 'kept', barKey: 'R-1' } as Rubric['criteria'][number];
    const removed = { key: 'removed', barKey: 'R-2' } as Rubric['criteria'][number];
    const added = { key: 'added', barKey: 'R-3' } as Rubric['criteria'][number];
    expect(acceptanceBarAmendmentCriterionChanges([kept, removed], [kept, added], ['R-2', 'R-3'])).toEqual([
      { barKey: 'R-2', before: removed, after: null },
      { barKey: 'R-3', before: null, after: added },
    ]);
  });

  it.each(['live', 'projected-tool-registry-v1:retired'])('keeps an incompatible %s probe unchanged so current validation still refuses it', (schemaRevision) => {
    const staleProbe = {
      kind: 'tool' as const,
      tool: 'status:read',
      args: { unexpected: true },
      schemaRevision,
      expect: { path: '$.state', op: 'exists' as const },
    };

    const [candidate] = migrateLegacyCriterionProbeRevisions([{
      key: 'incompatible-probe',
      check: { kind: 'probe' as const, probe: staleProbe },
    }]);

    expect(candidate?.check).toMatchObject({ probe: staleProbe });
  });
});
