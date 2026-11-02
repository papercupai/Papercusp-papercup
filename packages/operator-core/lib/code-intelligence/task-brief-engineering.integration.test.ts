import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';
import { getClaimTimeTaskBrief, getIntentTimeTaskBrief, getCompletionTimeBrief,
  TASK_BRIEF_MAX_CHARS, type TaskBriefDeps } from './task-brief';
import { readEngineeringEvidence } from './engineering-evidence';
import { DEFAULT_PACKER_EFFECTS, packerFacade } from './packer-facade';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { readWorkItemResume } from '../agent-tools/work_items/resume';
import { toolsetFromNames } from './push-toolset';

describe('canonical engineering evidence in agent resume', () => {
  let state: Awaited<ReturnType<typeof setupEngineeringEvidenceFixture>>;
  let itemGraph: Awaited<ReturnType<typeof readEngineeringEvidence>>;
  let symbolGraph: Awaited<ReturnType<typeof readEngineeringEvidence>>;
  let packed: Awaited<ReturnType<typeof packerFacade>>;
  let callers: Awaited<ReturnType<typeof firstPartyCallersOffthread>>;
  beforeAll(async () => {
    state = await setupEngineeringEvidenceFixture();
    // Capture real producer results before the interactive delivery deadline,
    // as in task-brief.integration.test.ts. The PG records and compiler/packer
    // results remain real; each adapter must request the exact captured scope.
    [itemGraph, symbolGraph, packed, callers] = await Promise.all([
      readEngineeringEvidence({ item: { plan: state.plan, id: 'P-001' } }, state.scope, state.store()),
      readEngineeringEvidence(state.query, state.scope, state.store()),
      packerFacade('pack', { rootPath: state.root, include: [state.path], format: 'xml', compress: false }, DEFAULT_PACKER_EFFECTS),
      firstPartyCallersOffthread({ root: state.root, name: 'evidenceFeature', filePath: state.path,
        paths: [state.path], op: 'callers', limit: 8, vendorDir: LSP_VENDOR_DIR }),
    ]);
    expect(packed.answer.error).toBeNull();
    expect(symbolGraph.nodes.find(node => node.kind === 'symbol')).toBeDefined();
  }, 180_000);
  afterAll(async () => { await state?.dispose(); });
  const surfaces = ['claim', 'intent', 'completion'] as const;
  async function deliver(surface: typeof surfaces[number], workspaceId = state.scope.workspaceId,
    maxChars = TASK_BRIEF_MAX_CHARS) {
    const item = { id: 'WI-ee-brief', harness: state.harness, sourcePlanSlug: state.plan, sourcePlanItemIds: ['P-001'],
      payload: { plan_item: { plan_slug: state.plan, item_id: 'P-001' } } };
    const engineering: typeof readEngineeringEvidence = async (query, scope) => {
      expect(scope).toEqual({ ...state.scope, workspaceId });
      expect(query).toEqual(surface === 'intent' ? state.query : { item: { plan: state.plan, id: 'P-001' } });
      if (workspaceId !== state.scope.workspaceId) return readEngineeringEvidence(query, scope, state.store());
      return surface === 'intent' ? symbolGraph : itemGraph;
    };
    const deps: TaskBriefDeps = {
      root: async () => state.root, effects: DEFAULT_PACKER_EFFECTS,
      pack: async (_op, args) => { expect(args.include).toEqual([state.path]); return packed; },
      graph: async () => callers, claimedPaths: async () => [], failures: async () => [], engineering,
      toolset: async () => toolsetFromNames(['graph:query', 'work_items:get', 'plans:get', 'code:pack', 'coord:declare-intent']),
    };
    if (surface === 'claim') return (await getClaimTimeTaskBrief({ workspaceId, workItem: item,
      owner: 'su-ee-integration', maxChars }, deps))!.taskBrief;
    if (surface === 'intent') return (await getIntentTimeTaskBrief({ workspaceId, harness: state.harness,
      owner: 'su-ee-integration', intent: 'Inspect exact engineering evidence', paths: [state.path], maxChars }, deps))!.taskBrief;
    return getCompletionTimeBrief({ workspaceId, harness: state.harness, subject: item, paths: [],
      owner: 'su-ee-integration', maxChars }, { root: deps.root, engineering, toolset: deps.toolset });
  }
  it.each(surfaces)('ee.brief-pg-entrypoints / %s: delivers exact PG intent, rationale and proof without inventing execution', async surface => {
    const brief = await deliver(surface);
    expect(brief.engineering?.intent).toContainEqual({ state: 'current', ref: {
      tool: 'plans:get-specs', args: { harness: state.harness, slug: state.plan, specIds: ['EE-1'], revision: 1 } } });
    expect(brief.engineering?.rationale).toEqual([{ state: 'current', ref: {
      tool: 'plans:get', args: { harness: state.harness, slug: state.plan, decisionId: 'D-001' } } }]);
    expect(brief.engineering?.validation).toContainEqual(expect.objectContaining({ ref: {
      tool: 'plans:get-spec-evidence', args: { harness: state.harness, slug: state.plan, bindingIds: [state.bindingId] } } }));
    expect(brief.engineering?.execution).toEqual([]);
    expect(brief.engineering?.gaps).toContain('Only named child boundaries are observed; static anchors, test outcomes and parent spans do not observe their callees.');
    const recovery = brief.engineering!.recover!;
    expect(recovery).toMatchObject({ tool: 'graph:query', args: { op: 'evidence', harnesses: [state.harness] } });
    const recovered = await readEngineeringEvidence(surface === 'intent'
      ? { symbol: { path: String(recovery.args.file_path), name: String(recovery.args.name) } }
      : { item: { plan: String(recovery.args.plan), id: String(recovery.args.item) } }, state.scope, state.store());
    expect(recovered.nodes.find(node => node.kind === 'proof')?.data.id).toBe(state.bindingId);
    expect(recovered.nodes.find(node => node.kind === 'test-run')?.data.id).toBe(state.runId);
  }, 60_000);
  it.each(surfaces)('ee.brief-pg-scope-negative / %s: foreign workspace cannot inherit canonical PG support', async surface => {
    const brief = await deliver(surface, 'ee-foreign');
    expect(brief.engineering).toMatchObject({ intent: [], rationale: [], validation: [], execution: [],
      gaps: ['engineering-evidence-unavailable'] });
    expect(JSON.stringify(brief.engineering)).not.toMatch(/EE-1|D-001|WI-ee-proof/);
    expect(brief.engineering?.recover?.args.harnesses).toEqual([state.harness]);
  }, 60_000);
  it.each(surfaces)('ee.brief-pg-budget / %s: bounds delivery and preserves scoped recovery and unobserved execution', async surface => {
    const brief = await deliver(surface, state.scope.workspaceId, 2400);
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(2400);
    expect(brief.engineering?.recover).toMatchObject({ tool: 'graph:query', args: { harnesses: [state.harness] } });
    expect(brief.engineering?.execution).toEqual([]);
  }, 60_000);
  it('ee.brief-resolving-refs: claim and resume share exact private-PG authority without requiring source paths or tracing', async () => {
    const item = { id: 'WI-ee-brief', harness: state.harness, sourcePlanSlug: state.plan, sourcePlanItemIds: ['P-001'],
      payload: { plan_item: { plan_slug: state.plan, item_id: 'P-001' } } };
    // P-006: the recipient was listed graph:query, so the brief may name its engineering recovery call.
    const source: typeof getClaimTimeTaskBrief = ref => getClaimTimeTaskBrief({ ...ref, workspaceId: state.scope.workspaceId,
      owner: 'su-ee-integration' }, {
      toolset: async () => toolsetFromNames(['graph:query', 'work_items:get', 'plans:get', 'code:pack']),
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
    const recovery = claim.engineering!.recover!.args;
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
