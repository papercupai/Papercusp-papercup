import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import getSpecs from '../agent-tools/plans/get-specs';
import getPlan from '../agent-tools/plans/get';
import getEvidence from '../agent-tools/plans/get-spec-evidence';
import getWorkItem from '../agent-tools/work_items/get';
import graphQuery from '../agent-tools/gitnexus/query';
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

  it('ee.reference-authorities: item, decision, proof, work-item and code-anchor destinations open their actual canonical records', async () => {
    const { scope, harness, plan, bindingId, runId, path, publicQuery } = state;
    const graph = (await publicQuery()).evidence!;
    const node = (kind: string) => {
      const selected = graph.nodes.find(value => value.kind === kind);
      expect(selected, `Expected a resolving ${kind} reference`).toBeDefined();
      return selected!;
    };
    const ctx = { workspaceId: scope.workspaceId, harnessSlug: harness, role: 'operator', log: () => {},
      principal: { slug: 'ee-reader', workspaceId: scope.workspaceId, capabilities: new Set(['intel:read']) } } as never;
    await runWithWorkspace(scope.workspaceId, async () => {
      const item = node('item');
      expect(item.ref.tool).toBe('plans:get');
      expect(data(await getPlan.handler(getPlan.args.parse(item.ref.args), ctx))).toMatchObject({
        results: [{ slug: plan, itemSelection: { requested: ['P-001'], matched: ['P-001'], missing: [] } }],
      });
      const decision = node('decision');
      expect(decision.ref.tool).toBe('plans:get');
      expect(data(await getPlan.handler(getPlan.args.parse(decision.ref.args), ctx))).toMatchObject({
        results: [{ slug: plan, decisions: [{ id: 'D-001', body: expect.stringContaining('explicit governing rule') }] }],
      });
      const proof = node('proof');
      expect(proof.ref.tool).toBe('plans:get-spec-evidence');
      expect(data(await getEvidence.handler(getEvidence.args.parse(proof.ref.args), ctx))).toMatchObject({
        evidence: [{ id: bindingId, specId: 'EE-1', specRevision: 1, workItemId: 'WI-ee-proof', testRunId: runId }],
      });
      const workItem = node('work-item');
      expect(workItem.ref.tool).toBe('work_items:get');
      expect(data(await getWorkItem.handler(getWorkItem.args.parse({ ...workItem.ref.args, threadLimit: 0 }), ctx)))
        .toMatchObject({ results: [{ id: 'WI-ee-proof', workItem: { id: 'WI-ee-proof' } }] });
      const symbol = node('symbol');
      expect(symbol.ref.tool).toBe('graph:query');
      expect(data(await graphQuery.handler(graphQuery.args.parse(symbol.ref.args), ctx))).toMatchObject({
        error: null, sites: expect.arrayContaining([expect.objectContaining({ path, line1: 1 })]),
      });
    });
  }, 90_000);

  it('ee.reference-scope-negative: wrong repository, tenant and missing history cannot resolve as the selected evidence', async () => {
    const { scope, harness, plan, publicQuery, store, runId } = state;
    const graph = (await publicQuery()).evidence!;
    const spec = graph.nodes.find(node => node.kind === 'spec')!;
    const proof = graph.nodes.find(node => node.kind === 'proof')!;
    const ctx = { workspaceId: scope.workspaceId, harnessSlug: harness, role: 'operator', log: () => {} } as never;
    await runWithWorkspace(scope.workspaceId, async () => {
      expect(data(await getSpecs.handler(getSpecs.args.parse({ ...spec.ref.args, revision: 999 }), ctx)).specs).toEqual([]);
      expect(data(await getEvidence.handler(getEvidence.args.parse({ ...proof.ref.args, bindingIds: [2147483647] }), ctx)))
        .toMatchObject({ count: 0, evidence: [] });
      expect(data(await getPlan.handler(getPlan.args.parse({ harness, slug: plan, decisionId: 'D-999' }), ctx)))
        .toMatchObject({ results: [{ decisions: [], decisionSelection: { missing: ['D-999'] } }] });
    });
    // These use the real scoped PG adapters, including the foreign fixture's
    // same repository/path controls, rather than fabricated empty tool results.
    expect(await store().run({ ...scope, workspaceId: 'ee-foreign' }, runId)).toBeNull();
    expect(await store().cases({ ...scope, harness: 'foreign-repo' }, runId, 21)).toEqual([]);
    expect((await publicQuery({ plan, item: 'P-001', harnesses: ['foreign-repo'] })).evidence).toBeNull();
    const missing = (await publicQuery({ plan, item: 'P-999' })).evidence!;
    const repair = missing.gaps.find(gap => gap.code === 'no-visible-item-anchor');
    expect(repair?.at).toMatchObject({ tool: 'graph:query', args: { harnesses: [harness], plan, item: 'P-999' } });
    expect(repair?.repair).toMatchObject({ tool: 'plans:add-item', args: { harness } });
    expect((await publicQuery(repair!.at.args)).evidence?.nodes).toEqual([]);
  }, 90_000);

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
