import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import getSpecs from '../agent-tools/plans/get-specs';
import testingRuns from '../agent-tools/testing/runs';
import { setSpecClause } from '../agent-tools/plans/spec-clauses-store';
import { runWithWorkspace } from '../workspace-als';
import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';

function data(value: unknown): Record<string, unknown> {
  expect(value).toHaveProperty('data');
  return (value as { data: Record<string, unknown> }).data;
}

describe('canonical engineering evidence reference resolution', () => {
  let state: Awaited<ReturnType<typeof setupEngineeringEvidenceFixture>>;
  beforeAll(async () => { state = await setupEngineeringEvidenceFixture(true); }, 180_000);
  afterAll(async () => { await state?.dispose(); });

  it('ee.reference-exact: selected immutable spec and case references resolve through their actual canonical tools', async () => {
    const { scope, harness, plan, runId, publicQuery, db } = state;
    const graph = (await publicQuery()).evidence!;
    const spec = graph.nodes.find(node => node.kind === 'spec')!;
    const testCase = graph.nodes.find(node => node.kind === 'test-case')!;
    expect(spec.ref).toMatchObject({ tool: 'plans:get-specs', args: { slug: plan, specIds: ['EE-1'], revision: 1 } });
    expect(testCase.ref).toMatchObject({ tool: 'testing:runs', args: { testRunIds: [runId], cases: true } });

    // A later current revision must not move a previously selected reference.
    expect(await db.begin(async tx => setSpecClause({ planSlug: plan, specId: 'EE-1', expectedRevision: 1, planItemId: 'P-001',
      behavior: 'A later revision has different behavior.', behaviorClass: 'happy-path',
      requiredEvidence: ['tree'], requiredTestLayers: ['integration'], mutationRequired: false,
      lifecycleStatus: 'active', actorId: 'su-ee-author',
      falsifier: { observation: 'A historical reference silently follows the current pointer.',
        probeMethod: 'Resolve the graph reference captured before this revision.' },
    }, { executor: tx as never, workspaceId: scope.workspaceId, harnessSlug: harness }))).toMatchObject({ status: 'revised' });

    const ctx = { workspaceId: scope.workspaceId, harnessSlug: harness, role: 'operator', log: () => {} } as never;
    await runWithWorkspace(scope.workspaceId, async () => {
      const selected = await getSpecs.handler(getSpecs.args.parse(spec.ref.args), ctx);
      expect(data(selected)).toMatchObject({ mode: 'exact-revision', count: 1,
        specs: [{ specId: 'EE-1', revision: 1, behavior: 'The scoped request returns exact declared engineering records.' }] });
      const current = await getSpecs.handler(getSpecs.args.parse({ ...spec.ref.args, revision: undefined }), ctx);
      expect(data(current).specs).toMatchObject([{ specId: 'EE-1', revision: 2 }]);

      const opened = await testingRuns.handler(testingRuns.args.parse(testCase.ref.args), ctx);
      expect(data(opened).runs).toMatchObject([{ id: runId, cases: [{ caseKey: 'ee.intent-exact', occurrence: 1, status: 'pass' }] }]);
      const missing = await getSpecs.handler(getSpecs.args.parse({ ...spec.ref.args, specIds: ['EE-foreign'] }), ctx);
      expect(data(missing).specs).toEqual([]);
    });
  }, 60_000);
});
