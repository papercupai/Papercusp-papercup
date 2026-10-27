import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';
import { getClaimTimeTaskBrief } from './task-brief';
import { readEngineeringEvidence } from './engineering-evidence';
import { DEFAULT_PACKER_EFFECTS, packerFacade } from './packer-facade';
import { readWorkItemResume } from '../agent-tools/work_items/resume';

describe('canonical engineering evidence in agent resume', () => {
  let state: Awaited<ReturnType<typeof setupEngineeringEvidenceFixture>>;
  beforeAll(async () => { state = await setupEngineeringEvidenceFixture(); }, 180_000);
  afterAll(async () => { await state?.dispose(); });
  it('ee.brief-resolving-refs: claim and resume share exact private-PG authority without requiring source paths or tracing', async () => {
    const item = { id: 'WI-ee-brief', harness: state.harness, sourcePlanSlug: state.plan, sourcePlanItemIds: ['P-001'],
      payload: { plan_item: { plan_slug: state.plan, item_id: 'P-001' } } };
    const source: typeof getClaimTimeTaskBrief = ref => getClaimTimeTaskBrief({ ...ref, workspaceId: state.scope.workspaceId }, {
      root: async () => state.root, effects: DEFAULT_PACKER_EFFECTS, pack: packerFacade,
      graph: async () => { throw new Error('No source paths requested'); },
      engineering: (query, scope) => readEngineeringEvidence(query, scope, state.store()),
    });
    const claim = (await source({ workItem: item }))!.taskBrief;
    expect(claim.engineering?.intent[0]?.ref.args).toMatchObject({ slug: state.plan, revision: 1 });
    expect(claim.engineering?.rationale[0]?.ref.args).toMatchObject({ slug: state.plan, decisionId: 'D-001' });
    expect(claim.engineering?.validation[0]?.ref.args).toMatchObject({ slug: state.plan });
    const resume = await readWorkItemResume(item, { checkpoint: async () => ({ checkpoint: null, updatedAtMs: null }),
      freshness: async () => undefined, evidence: async () => [], taskBrief: source });
    expect(resume.taskBrief).toHaveProperty('engineering.intent', claim.engineering?.intent);
    const recovery = claim.engineering!.recover.args;
    const graph = await readEngineeringEvidence({ item: { plan: String(recovery.plan), id: String(recovery.item) } },
      state.scope, state.store());
    expect(graph.nodes.find(node => node.kind === 'proof')?.data.id).toBe(state.bindingId);
    expect(graph.nodes.find(node => node.kind === 'test-run')?.data.id).toBe(state.runId);
    expect(claim.engineering?.execution).toEqual([]);
    const foreign = await readEngineeringEvidence({ item: { plan: state.plan, id: 'P-001' } },
      { ...state.scope, workspaceId: 'foreign' }, state.store()).catch(() => null);
    expect(foreign).toBeNull();
  }, 60_000);
});
