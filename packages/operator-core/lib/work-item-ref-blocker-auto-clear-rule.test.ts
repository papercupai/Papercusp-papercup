/**
 * Reaction wiring for the blocker auto-clear
 * (plan derived-status-not-hand-written-2026-10-12#P-011).
 */
import { describe, expect, it } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import './work-item-ref-blocker-auto-clear-rule';
import { finishedWorkItemIdOf } from './work-item-ref-blocker-auto-clear-rule';
import { matchReactions, reactionRulesFor } from './events/registry';
import { isBuiltinReactionAction, WORK_ITEM_REF_BLOCKER_AUTO_CLEAR_ACTION } from './events/builtin-actions';
import type { ToolInvocationEvent } from './events/types';

const ctx = { uiClientId: 'agent-1', harnessSlug: 'papercusp' } as unknown as UnifiedToolContext;

function event(tool: string, workItem: unknown, ok = true): ToolInvocationEvent {
  return { tool, args: {}, result: { ok, data: { ok, workItem } }, ctx };
}

describe('finishedWorkItemIdOf', () => {
  it('returns the id of a work item left in any terminal state', () => {
    for (const state of ['done', 'dropped', 'closed', 'resolved', 'passed', 'deprecated']) {
      expect(finishedWorkItemIdOf(event('work_items:set_state', { id: 'WI-9', state }))).toBe('WI-9');
    }
  });

  it('returns null for a non-terminal or malformed result', () => {
    expect(finishedWorkItemIdOf(event('work_items:set_state', { id: 'WI-9', state: 'wip' }))).toBeNull();
    expect(finishedWorkItemIdOf(event('work_items:set_state', { id: 'WI-9', state: 'blocked' }))).toBeNull();
    expect(finishedWorkItemIdOf(event('work_items:set_state', { id: '', state: 'done' }))).toBeNull();
    expect(finishedWorkItemIdOf(event('work_items:set_state', null))).toBeNull();
    expect(finishedWorkItemIdOf({ tool: 'work_items:complete', args: {}, result: { ok: true, data: undefined }, ctx })).toBeNull();
  });
});

describe('blocker auto-clear rules', () => {
  it('are registered on complete and set_state and fire a built-in action', () => {
    expect(reactionRulesFor('work_items:complete').map((r) => r.id)).toContain('blocker-auto-clear:complete');
    expect(reactionRulesFor('work_items:set_state').map((r) => r.id)).toContain('blocker-auto-clear:set-state');
    expect(isBuiltinReactionAction(WORK_ITEM_REF_BLOCKER_AUTO_CLEAR_ACTION)).toBe(true);
  });

  it('match with the finished id, including a complete whose finish leg failed after the close', () => {
    for (const [tool, ok] of [['work_items:complete', true], ['work_items:complete', false], ['work_items:set_state', true]] as const) {
      const fired = matchReactions(event(tool, { id: 'WI-9', state: 'done' }, ok)).filter(
        (m) => m.fire === WORK_ITEM_REF_BLOCKER_AUTO_CLEAR_ACTION,
      );
      expect(fired).toHaveLength(1);
      expect(fired[0]!.args).toEqual({ ids: ['WI-9'] });
    }
  });

  it('do not match a non-terminal result', () => {
    const fires = (e: ToolInvocationEvent) =>
      matchReactions(e).filter((m) => m.fire === WORK_ITEM_REF_BLOCKER_AUTO_CLEAR_ACTION);
    expect(fires(event('work_items:complete', { id: 'WI-9', state: 'wip' }, false))).toEqual([]);
    expect(fires(event('work_items:set_state', { id: 'WI-9', state: 'open' }))).toEqual([]);
  });

  it('gate set_state on success but let a complete with a failed finish leg through', () => {
    // matchReactions does not apply onlyOnSuccess (the engine does at dispatch),
    // so the flag itself is the contract.
    const rule = (tool: string, id: string) => reactionRulesFor(tool).find((r) => r.id === id)!;
    expect(rule('work_items:set_state', 'blocker-auto-clear:set-state').onlyOnSuccess).toBe(true);
    expect(rule('work_items:complete', 'blocker-auto-clear:complete').onlyOnSuccess).toBe(false);
  });
});
