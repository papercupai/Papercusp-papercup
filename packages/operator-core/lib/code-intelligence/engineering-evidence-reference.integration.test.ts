import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTestRunExecutionDetails, type ExecutionBoundaryReceipt } from '@papercusp/test-config/execution-details';
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
    const ctx = { workspaceId: scope.workspaceId, harnessSlug: harness, projectDir: scope.root, role: 'operator', log: () => {},
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
      const foreignCtx = { ...ctx as object, workspaceId: 'ee-foreign' } as never;
      expect(data(await getEvidence.handler(getEvidence.args.parse(proof.ref.args), foreignCtx)))
        .toMatchObject({ count: 0, evidence: [] });
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

  it('ee.reference-case-occurrences: repeated case names retain distinct outcomes and a missing occurrence stays absent', async () => {
    const { db, runId, scope, harness, publicQuery } = state;
    await db`INSERT INTO harness_shared.test_case_runs (test_run_id,case_index,case_key,occurrence,status)
      VALUES (${runId},1,'ee.intent-exact',2,'fail')`;
    const graph = (await publicQuery()).evidence!;
    const nodes = graph.nodes.filter(node => node.kind === 'test-case');
    expect(nodes.map(node => node.id)).toHaveLength(2);
    expect(new Set(nodes.map(node => node.id)).size).toBe(2);
    expect(nodes.map(node => node.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId, key: 'ee.intent-exact', occurrence: 1, status: 'pass' }),
      expect.objectContaining({ runId, key: 'ee.intent-exact', occurrence: 2, status: 'fail' }),
    ]));
    const ctx = { workspaceId: scope.workspaceId, harnessSlug: harness, role: 'operator', log: () => {} } as never;
    await runWithWorkspace(scope.workspaceId, async () => {
      for (const node of nodes) {
        const opened = data(await testingRuns.handler(testingRuns.args.parse(node.ref.args), ctx));
        const runs = opened.runs as { id: number; cases: { caseKey: string; occurrence: number; status: string }[] }[];
        const cases = runs.find(run => run.id === runId)!.cases;
        expect(cases.find(test => test.caseKey === node.data.key && test.occurrence === node.data.occurrence))
          .toMatchObject({ status: node.data.status });
        expect(cases.find(test => test.caseKey === node.data.key && test.occurrence === 999)).toBeUndefined();
      }
    });
  }, 90_000);

  it('ee.reference-execution: opens the exact correlated execution record and respects an explicit tenant filter', async () => {
    const { db, scope, harness, runId, publicQuery } = state;
    // Persist a synthetic control in the private fixture database. This tests
    // reference resolution; the live producer separately proves real spans.
    const now = Date.now();
    const receipt: ExecutionBoundaryReceipt = { boundary: 'graph:query:evidence', callId: 'ee-reference-execution',
      workspaceId: scope.workspaceId, harness, traceId: '1'.repeat(32), spanId: '2'.repeat(16),
      parentSpanId: '3'.repeat(16), traceFlags: 1, startedAt: now - 20, endedAt: now - 10,
      outcome: 'ok', sourceFingerprint: '4'.repeat(64), buildSha: 'c'.repeat(40),
      artifactFingerprint: '5'.repeat(64), environmentFingerprint: '6'.repeat(64), workflowId: null };
    const observation = { caseKey: 'ee.intent-exact', occurrence: 1, receipt };
    const cases = await db`SELECT status FROM harness_shared.test_case_runs WHERE test_run_id=${runId}`;
    const details = { schemaVersion: 1, root: scope.root, filePath: 'evidence-feature.integration.test.ts',
      runGroupId: null, workspaceId: scope.workspaceId, harnessSlug: harness, testNamePattern: null,
      mutationPhase: null, commitSha: receipt.buildSha, worktreeDirty: false, collectionFailed: false,
      passed: cases.filter(row => row.status === 'pass').length, failed: cases.filter(row => row.status === 'fail').length,
      skipped: cases.filter(row => row.status === 'skip').length, boundaryObservations: [observation] };
    expect(parseTestRunExecutionDetails(details), 'the canonical reader must accept the complete control metadata').toBeDefined();
    const [invocation] = await db`INSERT INTO harness_shared.tool_invocations
      (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,status,serving_build_sha,invoked_at,metadata_json)
      VALUES (${scope.workspaceId},${harness},'papercusp','graph:query','operator','ee-reference-fixture',
        ${receipt.callId},'ok',${receipt.buildSha},${new Date(now - 15)},
        ${db.json({ otel: { callId: receipt.callId, traceId: receipt.traceId, spanId: receipt.parentSpanId,
          traceFlags: 1, boundaryObservations: [receipt] } })}) RETURNING id`;
    await db`UPDATE harness_shared.test_runs SET started_at=${new Date(now - 30)}, finished_at=${new Date(now)},
      execution_details=${db.json(details)}
      WHERE id=${runId} AND workspace_id=${scope.workspaceId}`;
    try {
      const graph = (await publicQuery()).evidence!;
      const execution = graph.nodes.find(node => node.kind === 'execution');
      expect(execution?.data).toMatchObject({ runId, invocationId: String(invocation!.id), ...observation });
      expect(execution?.ref).toEqual({ tool: 'testing:runs', args: { harness, testRunIds: [runId], cases: true } });
      const ctx = { workspaceId: scope.workspaceId, harnessSlug: harness, role: 'operator', log: () => {} } as never;
      await runWithWorkspace(scope.workspaceId, async () => {
        const args = testingRuns.args.parse(execution!.ref.args);
        const opened = data(await testingRuns.handler(args, ctx));
        expect(opened.runs).toMatchObject([{ id: runId, executionDetails: { boundaryObservations: [observation] },
          cases: expect.arrayContaining([expect.objectContaining({ caseKey: observation.caseKey, occurrence: 1 })]) }]);
        // This operator diagnostic is global by default so NULL-scoped CI
        // rows remain visible. Its documented tenant selector is an argument.
        const foreign = data(await testingRuns.handler(testingRuns.args.parse({ ...args, workspace: 'ee-foreign' }), ctx));
        expect(foreign.runs).toEqual([]);
      });
    } finally {
      await db`UPDATE harness_shared.test_runs SET execution_details=NULL WHERE id=${runId}`;
      await db`DELETE FROM harness_shared.tool_invocations WHERE id=${invocation!.id}`;
    }
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
      expect(data(opened).runs).toMatchObject([{ id: runId, cases: expect.arrayContaining([
        expect.objectContaining({ caseKey: 'ee.intent-exact', occurrence: 1, status: 'pass' }),
      ]) }]);
      const missing = await getSpecs.handler(getSpecs.args.parse({ ...spec.ref.args, specIds: ['EE-foreign'] }), ctx);
      expect(data(missing).specs).toEqual([]);
    });
  }, 60_000);
});
