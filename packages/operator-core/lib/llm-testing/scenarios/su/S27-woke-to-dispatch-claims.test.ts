import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';

import {
  makeS27DispatchWorld,
  S27_DISPATCH_WORLD,
  S27_SCRIPTED_WAKE,
  SU_S27_WOKE_TO_DISPATCH_CLAIMS,
} from './S27-woke-to-dispatch-claims';

async function call(
  world: ReturnType<typeof makeS27DispatchWorld>,
  name: string,
  args: unknown = {},
): Promise<Record<string, any>> {
  const result = await world.override(name, args);
  if (result === PASS_THROUGH) throw new Error(`${name} unexpectedly passed through`);
  const text = (result as { content: Array<{ text?: string }> }).content[0]?.text;
  if (typeof text !== 'string') throw new Error(`${name} did not return text content`);
  return JSON.parse(text) as Record<string, any>;
}

function runWithAssistantText(assistantText: string): RunSummary {
  return {
    runId: 's27-assertion-regression',
    scenarioId: SU_S27_WOKE_TO_DISPATCH_CLAIMS.id,
    scenarioVersion: SU_S27_WOKE_TO_DISPATCH_CLAIMS.version,
    scenarioTarget: 'su',
    identityHash: 'fixture',
    sutModel: 'fixture',
    judgeModel: 'fixture',
    personaId: 'coordinator-dispatch',
    personaTraits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
    workspaceMode: 'isolated',
    transportMode: 'in-process',
    turns: [{
      assistantText,
      toolCalls: [],
      toolResults: [],
      cards: [],
      controlTags: [],
      costUsd: 0,
      latencyMs: 0,
      finishReason: 'done',
      rawSseTape: [],
    }],
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(0),
    finishedAt: new Date(0),
    finishReason: 'completed',
    capBreaches: [],
  };
}

describe('SU-S27 directed-dispatch world', () => {
  const planSlug = 'fleet-dispatch-wake-clarity-2026-06-22';
  const planItems = ['P-001', 'P-002', 'P-003', 'P-004'];
  const workItems = ['WI-501', 'WI-502', 'WI-503', 'WI-504'];

  it('allows explanatory repark mentions but rejects an affirmative repark', () => {
    const noReadAndRepark = SU_S27_WOKE_TO_DISPATCH_CLAIMS.asserts.find(
      (assertion) => assertion.kind === 'custom' && assertion.name === 'no-read-and-repark',
    );
    if (!noReadAndRepark || noReadAndRepark.kind !== 'custom') {
      throw new Error('S27 no-read-and-repark assertion is missing');
    }

    for (const text of [
      'P-003 requires the directed-wake claim-now obligation with no re-parking.',
      'Neither is a license to re-park the whole lane.',
    ]) {
      expect(noReadAndRepark.eval(runWithAssistantText(text))).toEqual([]);
    }
    expect(
      noReadAndRepark.eval(runWithAssistantText('I will re-park the whole lane until tomorrow.')),
    ).toMatchObject([{ assertKind: 'custom:no-read-and-repark' }]);
  });

  it('scripts the coordinator wake and keeps follow-up simulation out of the worker role', () => {
    expect(SU_S27_WOKE_TO_DISPATCH_CLAIMS.version).toBe(5);
    expect(SU_S27_WOKE_TO_DISPATCH_CLAIMS.triggers).toEqual([
      expect.objectContaining({
        on: 'after_turn',
        param: 0,
        fire: 'user_message',
        text: S27_SCRIPTED_WAKE,
      }),
    ]);
    expect(S27_SCRIPTED_WAKE).toMatch(/directed dispatch from su-815e2/);
    expect(S27_SCRIPTED_WAKE).toMatch(/Do not stop at WIP/);
    expect(SU_S27_WOKE_TO_DISPATCH_CLAIMS.simUserContext).toMatch(/not the worker/);
    expect(SU_S27_WOKE_TO_DISPATCH_CLAIMS.simUserContext).toMatch(/not satisfied.*merely claims/s);
  });

  it('exposes every dispatched item and the exact plan identity at orientation', async () => {
    const world = makeS27DispatchWorld();
    const result = await call(world, 'mcp__agentmcp__coord:orient', { intent: 'pick up the dispatch' });

    expect(result.claimable.map((item: any) => item.id)).toEqual(workItems);
    expect(result.claimable.map((item: any) => item.payload.plan_item.item_id)).toEqual(planItems);
    expect(result.claimable.every((item: any) => item.payload.plan_item.plan_slug === planSlug)).toBe(true);
    expect(result.inbox.recent[0]).toMatchObject({
      kind: 'dispatch',
      planSlug,
      planItems,
    });
    expect(result.inbox.recent[0].summary).toMatch(/consolidating.*fleet-dispatch.*wake-semantics/i);
  });

  it('keeps plan, assigned-plan-item, and work-item reads consistent', async () => {
    const world = makeS27DispatchWorld();
    const [plan, assigned, listed] = await Promise.all([
      call(world, 'plans:get', { slug: planSlug, harness: 'papercusp' }),
      call(world, 'plan_items:my_items'),
      call(world, 'work_items:list'),
    ]);

    expect(plan.slug).toBe(planSlug);
    expect(plan.items.map((item: any) => item.id)).toEqual(planItems);
    expect(plan.items.every((item: any) => typeof item.acceptanceCriteria === 'string')).toBe(true);
    expect(assigned.items.map((item: any) => item.item)).toEqual(planItems);
    expect(listed.items.map((item: any) => item.id)).toEqual(workItems);
  });

  it('returns the existing playbook pages and accepts the consolidated deliverable', async () => {
    const world = makeS27DispatchWorld();
    const found = await call(world, 'docs:search', { query: 'fleet dispatch wake', harness: 'papercusp' });
    expect(found.results.map((row: any) => row.slug)).toEqual([
      'playbook/fleet-dispatch',
      'playbook/wake-semantics',
    ]);

    const read = await call(world, 'docs:get', {
      slugs: ['playbook/fleet-dispatch', 'playbook/wake-semantics'],
      harness: 'papercusp',
    });
    expect(read.documents).toHaveLength(2);
    expect(read.documents.map((row: any) => row.body).join('\n')).toMatch(/pickup confirmed/);
    expect(read.documents.map((row: any) => row.body).join('\n')).toMatch(/coord:presence/);

    const authored = await call(world, 'docs:author', {
      slug: 'playbook/fleet-dispatch-wake-clarity',
      title: 'Fleet dispatch wake clarity',
      body: '# consolidated',
      status: 'active',
      verify: true,
    });
    expect(authored).toMatchObject({
      ok: true,
      slug: 'playbook/fleet-dispatch-wake-clarity',
      status: 'active',
      verified: true,
    });

    const persisted = await call(world, 'docs:get', {
      slugs: ['playbook/fleet-dispatch-wake-clarity'],
      harness: 'papercusp',
    });
    expect(persisted.documents).toEqual([
      expect.objectContaining({
        slug: 'playbook/fleet-dispatch-wake-clarity',
        body: '# consolidated',
        version: 1,
        verified: true,
      }),
    ]);
  });

  it('returns argument-aware confirmations for both direct and plan claims', async () => {
    const world = makeS27DispatchWorld();
    const direct = await call(world, 'work_items:claim', { row: 'WI-503' });
    const plan = await call(world, 'plans:set-status', {
      slug: planSlug,
      itemId: 'P-004',
      status: 'wip',
    });
    const declared = await call(world, 'coord:declare-intent', {
      intent: 'claim the dispatched lane',
      current_plan_slug: planSlug,
      items: planItems,
    });

    expect(direct).toMatchObject({ id: 'WI-503', workItem: { id: 'WI-503', state: 'wip' } });
    expect(plan).toMatchObject({ itemId: 'P-004', oldStatus: 'todo', newStatus: 'wip' });
    expect(declared.claims.claimed).toEqual(['P-001', 'P-002']);
    expect(declared.claims.alreadyHeld).toEqual(['P-003', 'P-004']);

    const [oriented, rereadPlan, rereadWork] = await Promise.all([
      call(world, 'coord:orient', { intent: 'verify pickup persisted' }),
      call(world, 'plans:get', { slug: planSlug }),
      call(world, 'work_items:get', { id: 'WI-503' }),
    ]);
    expect(oriented.me.agents[0].claims).toEqual(expect.arrayContaining(planItems));
    expect(rereadPlan.items.find((item: any) => item.id === 'P-004').status).toBe('wip');
    expect(rereadWork.results[0].workItem).toMatchObject({ id: 'WI-503', state: 'wip', assignee: 'su-self' });
  });

  it('isolates authored state between matrix arms and passes unrelated tools through', async () => {
    const first = makeS27DispatchWorld();
    const second = makeS27DispatchWorld();
    await call(first, 'docs:author', {
      slug: 'playbook/fleet-dispatch-wake-clarity',
      body: '# first arm',
    });
    expect((await call(first, 'docs:get', { slugs: ['playbook/fleet-dispatch-wake-clarity'] })).count).toBe(1);
    expect((await call(second, 'docs:get', { slugs: ['playbook/fleet-dispatch-wake-clarity'] })).count).toBe(0);
    expect(await S27_DISPATCH_WORLD.override('audit:list', {})).toBe(PASS_THROUGH);
  });
});
