/**
 * Reaction rules for the blocker auto-clear
 * (plan derived-status-not-hand-written-2026-10-12#P-011).
 *
 * When `work_items:complete` or `work_items:set_state` leaves a work item in a
 * terminal state, fire the built-in action
 * `work-item.clearBlockersNamingFinished { ids:[<id>] }`, which clears every
 * live-dependency blocker naming that id once all the ids it names are
 * terminal, and wakes the blocked items' holders. See
 * work-item-ref-blocker-auto-clear.ts.
 *
 * The matcher is pure (no I/O): it reads the post-write `workItem` the tools
 * return, exactly as plan-items/reflect-rules.ts does. It only decides whether
 * to fire. The action re-reads every named id's state from the database, so a
 * late or duplicate reaction cannot clear a blocker on work that was reopened.
 *
 * `complete` fires with `onlyOnSuccess:false` for the same reason reflect-rules
 * does: a finish leg can fail after the item already closed, and then the
 * returned workItem is terminal while the call reads ok:false. A refused
 * completion returns the unchanged, non-terminal item, so it never matches.
 *
 * Registered on import from agent-tools/index.ts.
 */
import { registerReactionRule } from './events';
import { WORK_ITEM_REF_BLOCKER_AUTO_CLEAR_ACTION } from './events/builtin-actions';
import type { ToolInvocationEvent } from './events/types';
import { isTerminalWorkItemState } from './work-item-ref-blocker-auto-clear';

/** The id of the work item this event left terminal, or null. Pure. */
export function finishedWorkItemIdOf(e: ToolInvocationEvent): string | null {
  const workItem = (e.result?.data as { workItem?: { id?: unknown; state?: unknown } | null } | undefined)?.workItem;
  if (!workItem || typeof workItem.id !== 'string' || workItem.id.trim() === '') return null;
  if (typeof workItem.state !== 'string' || !isTerminalWorkItemState(workItem.state)) return null;
  return workItem.id;
}

function autoClearArgs(e: ToolInvocationEvent): Record<string, unknown> {
  return { ids: [finishedWorkItemIdOf(e)!] };
}

registerReactionRule({
  id: 'blocker-auto-clear:complete',
  on: 'work_items:complete',
  when: (e) => finishedWorkItemIdOf(e) !== null,
  fire: WORK_ITEM_REF_BLOCKER_AUTO_CLEAR_ACTION,
  args: autoClearArgs,
  onlyOnSuccess: false,
  source: 'blocker-auto-clear',
});

registerReactionRule({
  id: 'blocker-auto-clear:set-state',
  on: 'work_items:set_state',
  when: (e) => finishedWorkItemIdOf(e) !== null,
  fire: WORK_ITEM_REF_BLOCKER_AUTO_CLEAR_ACTION,
  args: autoClearArgs,
  onlyOnSuccess: true,
  source: 'blocker-auto-clear',
});
