/**
 * plan-drain-rule.test.ts — P-004 of
 * deterministic-plan-state-derivation-2026-08-31.
 *
 * Pins the rules to the REAL dispatch path: `plans:set-status` and
 * `plans:add-item` return BULK envelopes, the engine FANS them into one event
 * per item, and the carrier is never matched. Initial lifecycle writes through
 * `plans:new`, `plans:set-frontmatter`, and `plans:set-plan-status` are reconciled
 * after success. A rule reading `data.results[]`
 * therefore has a `when` that is always false and silently never fires.
 *
 * FALSIFIABILITY. Every "fires" assertion is paired with a control event
 * differing in one status field where it must NOT fire, so a matcher stuck at
 * `true` fails a control and one stuck at `false` fails a positive.
 */
import { describe, it, expect, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import './plan-drain-rule'; // registers plan-drain:terminality-changed
import { planWhoseDrainStateMayHaveChanged } from './plan-drain-rule';
import { matchReactions, reactionRulesFor } from '../events/registry';
import { fanOutBulkEvent } from '../events/engine';
import { PLAN_DRAIN_TRANSITION_ACTION, fireBuiltinReactionAction } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';

const transition = vi.hoisted(() => vi.fn().mockResolvedValue({ applied: true }));
vi.mock('../agent-tools/plans/plan-drain-transition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/plans/plan-drain-transition')>()),
  applyPlanDrainTransition: transition,
}));

const RULE_ID = 'plan-drain:terminality-changed';
const ADD_RULE_ID = 'plan-drain:item-added';
const CREATE_RULE_ID = 'plan-drain:plan-created';
const FRONTMATTER_RULE_ID = 'plan-drain:legacy-plan-converted';
const PLAN_STATUS_RULE_ID = 'plan-drain:plan-readied';
const CONTENT_RULE_IDS = {
  'plans:set-content': 'plan-drain:content-rewritten',
  'plans:edit': 'plan-drain:content-edited',
  'plans:set-content-chunk': 'plan-drain:content-chunk-committed',
} as const;
const ctx = {
  uiClientId: 'agent-1',
  spawnId: 'spawn-1',
  harnessSlug: 'papercusp',
  runId: 'run-1',
} as unknown as UnifiedToolContext;

/** One fanned PER-ITEM plans:set-status result — what the engine dispatches. */
function perItemEvent(item: Record<string, unknown>): ToolInvocationEvent {
  return {
    tool: 'plans:set-status',
    args: { slug: item.slug, item: item.itemId, status: item.newStatus },
    result: { ok: item.ok !== false, data: item },
    ctx,
  };
}

/** The RAW bulk envelope plans:set-status actually returns. */
function bulkEvent(items: Record<string, unknown>[]): ToolInvocationEvent {
  const ok = items.filter((i) => i.ok !== false).length;
  return {
    tool: 'plans:set-status',
    args: { items: items.map((i) => ({ slug: i.slug, item: i.itemId, status: i.newStatus })) },
    result: {
      ok: true,
      data: { ok: true, results: items, counts: { ok, failed: items.length - ok } },
    },
    ctx,
  };
}

/** The RAW bulk envelope plans:add-item actually returns. */
function addItemBulkEvent(items: Record<string, unknown>[]): ToolInvocationEvent {
  const ok = items.filter((i) => i.ok !== false).length;
  return {
    tool: 'plans:add-item',
    args: { items: items.map((i) => ({ slug: i.slug, text: i.text })) },
    result: {
      ok: true,
      data: { ok: true, results: items, counts: { ok, failed: items.length - ok } },
    },
    ctx,
  };
}

/** The RAW bulk envelope plans:set-plan-status actually returns. */
function planStatusBulkEvent(items: Record<string, unknown>[]): ToolInvocationEvent {
  const ok = items.filter((i) => i.ok !== false).length;
  return {
    tool: 'plans:set-plan-status',
    args: { slugs: items.map((i) => i.slug), status: 'ready' },
    result: {
      ok: true,
      data: { ok: true, results: items, counts: { ok, failed: items.length - ok } },
    },
    ctx,
  };
}

function contentWriteEvent(
  tool: keyof typeof CONTENT_RULE_IDS,
  planDrainTransitionChanged = true,
  ok = true,
): ToolInvocationEvent {
  return {
    tool,
    args: { slug: 'p-content' },
    result: {
      ok,
      data: { ok, slug: 'p-content', planDrainTransitionChanged },
    },
    ctx,
  };
}

function newPlanEvent(status: string | undefined, ok = true): ToolInvocationEvent {
  return {
    tool: 'plans:new',
    args: { slug: 'p-created', ...(status ? { status } : {}) },
    result: { ok, data: { ok, slug: 'p-created' } },
    ctx,
  };
}

function setFrontmatterEvent(status: string | undefined, ok = true): ToolInvocationEvent {
  return {
    tool: 'plans:set-frontmatter',
    args: { slug: 'p-legacy', ...(status ? { status } : {}) },
    result: { ok, data: { ok, slug: 'p-legacy' } },
    ctx,
  };
}

const flip = (
  slug: string,
  itemId: string,
  oldStatus: string | null,
  newStatus: string,
  ok = true,
) => ({ ok, slug, itemId, oldStatus, newStatus });

describe('automatic acceptance carry accountability', () => {
  it('carries the authenticated finishing actor through the reaction action', async () => {
    transition.mockClear();
    const event = contentWriteEvent('plans:edit');
    event.ctx = { ...ctx, isSuperuser: true, uiClientId: 'su-finishing-agent' };
    // A payload field cannot choose the next accountable actor.
    event.args = { slug: 'p-content', accountableOwnerId: 'su-unrelated-agent' };
    const action = matchReactions(event).find((a) => a.ruleId === CONTENT_RULE_IDS['plans:edit'])!;
    await fireBuiltinReactionAction(action.fire, action.args, 'papercusp-workspace');
    expect(transition).toHaveBeenCalledWith('p-content', 'papercusp', {
      workspaceId: 'papercusp-workspace',
      accountableOwnerId: 'su-finishing-agent',
    });
  });

  it.each(['system:plan-drain', 'mcp-call-123', 'harness:papercusp'])('does not assign a carry to %s', async (ownerId) => {
    transition.mockClear();
    const event = contentWriteEvent('plans:edit');
    event.ctx = { ...ctx, isSuperuser: true, uiClientId: ownerId };
    const action = matchReactions(event).find((a) => a.ruleId === CONTENT_RULE_IDS['plans:edit'])!;
    await fireBuiltinReactionAction(action.fire, action.args, 'papercusp-workspace');
    expect(transition).toHaveBeenCalledWith('p-content', 'papercusp', {
      workspaceId: 'papercusp-workspace',
    });
  });

  it('keeps a clientless superuser carry claimable', async () => {
    transition.mockClear();
    const event = contentWriteEvent('plans:edit');
    event.ctx = { ...ctx, isSuperuser: true, uiClientId: undefined };
    const action = matchReactions(event).find((a) => a.ruleId === CONTENT_RULE_IDS['plans:edit'])!;
    await fireBuiltinReactionAction(action.fire, action.args, 'papercusp-workspace');
    expect(transition).toHaveBeenCalledWith('p-content', 'papercusp', {
      workspaceId: 'papercusp-workspace',
    });
  });
});

describe('planWhoseDrainStateMayHaveChanged — relevant lifecycle writes', () => {
  it('matches an item going todo -> done (a plan can newly drain)', () => {
    expect(planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'todo', 'done'))))
      .toEqual({ planSlug: 'p1', harnessSlug: 'papercusp' });
  });

  it('matches an item going done -> todo (a drained plan can un-drain)', () => {
    // The reverse edge is what keeps the stored status invertible; a
    // forward-only matcher would strand plans at awaiting-acceptance.
    expect(planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'done', 'todo'))))
      .toEqual({ planSlug: 'p1', harnessSlug: 'papercusp' });
  });

  it('CONTROL: ignores todo -> wip, which cannot change whether the plan is drained', () => {
    expect(
      planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'todo', 'wip'))),
    ).toBeNull();
  });

  it('CONTROL: ignores done -> dropped, where BOTH sides are terminal', () => {
    // Both terminal, so the drained bit is unchanged. Reacting would cost a
    // locked plan read to discover nothing.
    expect(
      planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'done', 'dropped'))),
    ).toBeNull();
  });

  it('CONTROL: ignores a FAILED flip', () => {
    expect(
      planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'todo', 'done', false))),
    ).toBeNull();
  });

  it('treats a first-ever status (oldStatus null) going terminal as a crossing', () => {
    expect(
      planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', null, 'done'))),
    ).not.toBeNull();
  });

  it('matches a successful add-item result because the new item may reopen the plan', () => {
    const event: ToolInvocationEvent = {
      tool: 'plans:add-item',
      args: { slug: 'p-added', phase: 'Phase 1', text: 'new item' },
      result: { ok: true, data: { ok: true, slug: 'p-added', itemId: 'P-003' } },
      ctx,
    };
    expect(planWhoseDrainStateMayHaveChanged(event)).toEqual({
      planSlug: 'p-added',
      harnessSlug: 'papercusp',
    });
  });

  it('ignores a failed add-item result', () => {
    const event: ToolInvocationEvent = {
      tool: 'plans:add-item',
      args: { slug: 'p-failed', phase: 'Phase 1', text: 'bad item' },
      result: { ok: false, data: { ok: false, slug: 'p-failed', error: 'busy' } },
      ctx,
    };
    expect(planWhoseDrainStateMayHaveChanged(event)).toBeNull();
  });

  it('matches content writers only when the shared evaluator sees a changed transition target', () => {
    for (const tool of Object.keys(CONTENT_RULE_IDS) as Array<keyof typeof CONTENT_RULE_IDS>) {
      expect(planWhoseDrainStateMayHaveChanged(contentWriteEvent(tool))).toEqual({
        planSlug: 'p-content',
        harnessSlug: 'papercusp',
      });
      expect(planWhoseDrainStateMayHaveChanged(contentWriteEvent(tool, false))).toBeNull();
      expect(planWhoseDrainStateMayHaveChanged(contentWriteEvent(tool, true, false))).toBeNull();
    }
  });

  it('matches successful plans:new writes with a non-draft initial status', () => {
    expect(planWhoseDrainStateMayHaveChanged(newPlanEvent('ready'))).toEqual({
      planSlug: 'p-created',
      harnessSlug: 'papercusp',
    });
    expect(planWhoseDrainStateMayHaveChanged(newPlanEvent('active'))).toEqual({
      planSlug: 'p-created',
      harnessSlug: 'papercusp',
    });
    expect(planWhoseDrainStateMayHaveChanged(newPlanEvent(undefined))).toBeNull();
    expect(planWhoseDrainStateMayHaveChanged(newPlanEvent('draft'))).toBeNull();
    expect(planWhoseDrainStateMayHaveChanged(newPlanEvent('ready', false))).toBeNull();
  });

  it('matches successful legacy conversions with a non-draft initial status', () => {
    expect(planWhoseDrainStateMayHaveChanged(setFrontmatterEvent('ready'))).toEqual({
      planSlug: 'p-legacy',
      harnessSlug: 'papercusp',
    });
    expect(planWhoseDrainStateMayHaveChanged(setFrontmatterEvent(undefined))).toBeNull();
    expect(planWhoseDrainStateMayHaveChanged(setFrontmatterEvent('draft'))).toBeNull();
    expect(planWhoseDrainStateMayHaveChanged(setFrontmatterEvent('ready', false))).toBeNull();
  });

  it('carries no harness when the ctx has none, rather than guessing one', () => {
    // EI-8970: re-reading under the operator-home harness would resolve a
    // DIFFERENT plan row for a plan that lives elsewhere. Absent is honest.
    const e = perItemEvent(flip('p1', 'P-001', 'todo', 'done'));
    const bare = { ...e, ctx: {} as unknown as UnifiedToolContext };
    expect(planWhoseDrainStateMayHaveChanged(bare)?.harnessSlug).toBeNull();
  });
});

describe('the rule on the real dispatch path', () => {
  it('is registered on plans:set-status', () => {
    expect(reactionRulesFor('plans:set-status').map((r) => r.id)).toContain(RULE_ID);
  });

  it('is registered on plans:add-item', () => {
    expect(reactionRulesFor('plans:add-item').map((r) => r.id)).toContain(ADD_RULE_ID);
  });

  it('registers the transition-change reaction on every whole-content writer', () => {
    for (const [tool, ruleId] of Object.entries(CONTENT_RULE_IDS) as Array<
      [keyof typeof CONTENT_RULE_IDS, string]
    >) {
      expect(reactionRulesFor(tool).map((r) => r.id)).toContain(ruleId);
    }
  });

  it('registers the creation-time drain reaction on plans:new', () => {
    expect(reactionRulesFor('plans:new').map((r) => r.id)).toContain(CREATE_RULE_ID);
  });

  it('registers the conversion-time drain reaction on plans:set-frontmatter', () => {
    expect(reactionRulesFor('plans:set-frontmatter').map((r) => r.id)).toContain(FRONTMATTER_RULE_ID);
  });

  it('registers the ready-transition drain reaction on plans:set-plan-status', () => {
    expect(reactionRulesFor('plans:set-plan-status').map((r) => r.id)).toContain(PLAN_STATUS_RULE_ID);
  });

  it('matches the FANNED per-item events and NOT the bulk carrier', () => {
    const bulk = bulkEvent([
      flip('p1', 'P-001', 'todo', 'done'), // crosses
      flip('p1', 'P-002', 'todo', 'wip'), // does not
    ]);

    // 1. the carrier itself is never matched (the EI-6960 trap).
    expect(matchReactions(bulk).find((a) => a.ruleId === RULE_ID)).toBeUndefined();

    // 2. the engine fans it into one event per result item.
    const fanned = fanOutBulkEvent(bulk);
    expect(fanned).not.toBeNull();
    expect(fanned!).toHaveLength(2);

    // 3. only the boundary-crossing one fires, and it names the PLAN.
    const crossed = matchReactions(fanned![0]!).find((a) => a.ruleId === RULE_ID);
    expect(crossed).toBeDefined();
    expect(crossed!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
    expect(crossed!.args.plans).toEqual([{ planSlug: 'p1', harnessSlug: 'papercusp' }]);

    expect(matchReactions(fanned![1]!).find((a) => a.ruleId === RULE_ID)).toBeUndefined();
  });

  it('a SINGLE-item call is also enveloped, fans out, and fires', () => {
    // Every plans:set-status call runs through runBulk, so "I only flipped one
    // item" is still a bulk envelope — the assumption that broke reconcile-rule.
    const fanned = fanOutBulkEvent(bulkEvent([flip('p2', 'P-042', 'wip', 'done')]));
    expect(fanned!).toHaveLength(1);
    const action = matchReactions(fanned![0]!).find((a) => a.ruleId === RULE_ID);
    expect(action).toBeDefined();
    expect(action!.args.plans).toEqual([{ planSlug: 'p2', harnessSlug: 'papercusp' }]);
  });

  it('matches successful fanned add-item results and ignores failed siblings', () => {
    const bulk = addItemBulkEvent([
      { ok: true, slug: 'p-added', itemId: 'P-003', text: 'new item' },
      { ok: false, slug: 'p-failed', error: 'busy', text: 'bad item' },
    ]);

    expect(matchReactions(bulk).find((a) => a.ruleId === ADD_RULE_ID)).toBeUndefined();

    const fanned = fanOutBulkEvent(bulk);
    expect(fanned).not.toBeNull();
    expect(fanned!).toHaveLength(2);

    const added = matchReactions(fanned![0]!).find((a) => a.ruleId === ADD_RULE_ID);
    expect(added).toBeDefined();
    expect(added!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
    expect(added!.args.plans).toEqual([{ planSlug: 'p-added', harnessSlug: 'papercusp' }]);
    expect(matchReactions(fanned![1]!).find((a) => a.ruleId === ADD_RULE_ID)).toBeUndefined();
  });

  it('fires lifecycle reconciliation for direct content writes that change the drain target', () => {
    for (const [tool, ruleId] of Object.entries(CONTENT_RULE_IDS) as Array<
      [keyof typeof CONTENT_RULE_IDS, string]
    >) {
      const action = matchReactions(contentWriteEvent(tool)).find((a) => a.ruleId === ruleId);
      expect(action).toBeDefined();
      expect(action!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
      expect(action!.args.plans).toEqual([{ planSlug: 'p-content', harnessSlug: 'papercusp' }]);
      expect(matchReactions(contentWriteEvent(tool, false)).find((a) => a.ruleId === ruleId)).toBeUndefined();
    }
  });

  it('fires lifecycle reconciliation for a successful non-draft plan creation', () => {
    const action = matchReactions(newPlanEvent('ready')).find((a) => a.ruleId === CREATE_RULE_ID);
    expect(action).toBeDefined();
    expect(action!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
    expect(action!.args.plans).toEqual([{ planSlug: 'p-created', harnessSlug: 'papercusp' }]);
    expect(matchReactions(newPlanEvent('draft')).find((a) => a.ruleId === CREATE_RULE_ID)).toBeUndefined();
  });

  it('fires lifecycle reconciliation for a successful ready legacy-plan conversion', () => {
    const action = matchReactions(setFrontmatterEvent('ready')).find((a) => a.ruleId === FRONTMATTER_RULE_ID);
    expect(action).toBeDefined();
    expect(action!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
    expect(action!.args.plans).toEqual([{ planSlug: 'p-legacy', harnessSlug: 'papercusp' }]);
    expect(matchReactions(setFrontmatterEvent('draft')).find((a) => a.ruleId === FRONTMATTER_RULE_ID)).toBeUndefined();
  });

  it('fires after a changed ready status write, only for the successful changed row', () => {
    const bulk = planStatusBulkEvent([
      { ok: true, slug: 'p-readied', newStatus: 'ready', changed: true },
      { ok: false, slug: 'p-failed', newStatus: 'ready', changed: false },
      { ok: true, slug: 'p-noop', newStatus: 'ready', changed: false },
      { ok: true, slug: 'p-shipped', newStatus: 'shipped', changed: true },
    ]);

    expect(matchReactions(bulk).find((a) => a.ruleId === PLAN_STATUS_RULE_ID)).toBeUndefined();
    const fanned = fanOutBulkEvent(bulk);
    expect(fanned).not.toBeNull();
    const action = matchReactions(fanned![0]!).find((a) => a.ruleId === PLAN_STATUS_RULE_ID);
    expect(action).toBeDefined();
    expect(action!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
    expect(action!.args.plans).toEqual([{ planSlug: 'p-readied', harnessSlug: 'papercusp' }]);
    for (const event of fanned!.slice(1)) {
      expect(matchReactions(event).find((a) => a.ruleId === PLAN_STATUS_RULE_ID)).toBeUndefined();
    }
  });
});
