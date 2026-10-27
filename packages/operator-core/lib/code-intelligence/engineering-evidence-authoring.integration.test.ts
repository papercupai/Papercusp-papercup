import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultAutobindDeps, runSpecEvidenceAutobind, type AutobindTarget } from '../agent-tools/plans/spec-evidence-autobind';
import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';
import { readEngineeringEvidence } from './engineering-evidence';

describe('native engineering evidence authoring and reconciliation', () => {
  let state: Awaited<ReturnType<typeof setupEngineeringEvidenceFixture>>;
  beforeAll(async () => { state = await setupEngineeringEvidenceFixture(); }, 180_000);
  afterAll(async () => { await state?.dispose(); });

  it('ee.newer-failure: real reconciliation withdraws exact earlier support and preserves its history', async () => {
    const { db, scope, plan, bindingId, runId, store } = state;
    const file = 'evidence-feature.integration.test.ts';
    const target: AutobindTarget = { workspaceId: scope.workspaceId, harnessSlug: scope.harness,
      planSlug: plan, specId: 'EE-1', specRevision: 1, workItemId: 'WI-ee-proof', barKey: 'R-1', testFile: file };
    const [failure] = await db`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,framework,status,source,commit_sha,worktree_dirty,finished_at)
      VALUES (${scope.workspaceId},${scope.harness},${file},'vitest','fail','local',${'c'.repeat(40)},false,now())
      RETURNING id`;
    // A newer unrelated pass must not replace the named file's failing result.
    await db`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,framework,status,source,commit_sha,worktree_dirty,finished_at)
      VALUES (${scope.workspaceId},${scope.harness},'unrelated.integration.test.ts','vitest','pass','local',${'c'.repeat(40)},false,now())`;
    const deps = { ...defaultAutobindDeps(), loadTargets: async () => [target] };
    const result = await runSpecEvidenceAutobind(scope.workspaceId, deps);
    expect(result.outcomes.filter(outcome => outcome.kind === 'refused')).toEqual([]);
    expect(result.decisions.retract).toBe(1);
    const [binding] = await db`SELECT retracted_at,retracted_by,retraction_reason
      FROM harness_shared.spec_evidence_bindings WHERE id=${bindingId}`;
    expect(binding?.retracted_at).not.toBeNull();
    expect(binding?.retracted_by).toBe('system:spec-evidence-autobind');
    expect(binding?.retraction_reason).toContain(`test-run ${failure!.id}`);
    const graph = await readEngineeringEvidence({ item: { plan, id: 'P-001' } }, scope, store());
    expect(graph.nodes.find(n => n.kind === 'proof' && n.data.id === bindingId)).toMatchObject({
      state: 'historical', data: { withdrawn: true, runId },
    });
    expect(graph.nodes.filter(n => n.kind === 'proof' && n.state === 'current')).toEqual([]);
    expect((await runSpecEvidenceAutobind(scope.workspaceId, deps)).decisions.retract).toBe(0);
  }, 60_000);

  it('ee.retraction-refusal: a missing binding cannot be reported as a successful withdrawal', async () => {
    const { scope, plan, bindingId } = state;
    const target: AutobindTarget = { workspaceId: 'ee-foreign', harnessSlug: scope.harness,
      planSlug: plan, specId: 'EE-1', specRevision: 1, workItemId: 'WI-ee-proof', barKey: 'R-1',
      testFile: 'evidence-feature.integration.test.ts' };
    await expect(defaultAutobindDeps().retract(target, bindingId, 'foreign target must not withdraw another workspace binding'))
      .rejects.toThrow('autobind_retraction_not_applied:ee-foreign/');
  });
});
