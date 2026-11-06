/**
 * `executeDurableReaction` — the body a DBOS reaction step runs (D-004 / D-007).
 *
 * The generic claim → dispatch → release-on-failure control flow lives in
 * `@papercusp/event-reaction`; this is the Papercusp binding that injects the
 * idempotency store (the PG dedup ledger) and the dispatcher (rebuilding the
 * reaction's scope from the serializable parent, then firing in-process). Kept
 * here (not in the DBOS module) so it is unit-testable with PG + the dispatcher
 * mocked, and so the DBOS module stays a thin durable wrapper.
 */

import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import {
  executeDurableReaction as genericExecuteDurableReaction,
  type DurableReactionPayload as GenericDurableReactionPayload,
} from '@papercusp/event-reaction';
import { fireReactionInProcess, reactionBackgroundActivityAllowed } from './dispatch-reaction';
import { claimReaction, releaseReaction, markReactionFailed, reactionOutcome, completeReaction, markReactionUncertain } from './reaction-dedup';
import type { SerializableReactionParent } from './reaction-id';
import { reconcileGateActionReceipt } from '../release/gate-action-receipt';

/** The JSON-serializable workflow payload for one durable reaction. */
export type DurableReactionPayload = GenericDurableReactionPayload<SerializableReactionParent>;

/** Bind a receiver receipt to the entire immutable request, not just a rule's dedup id. */
function reactionExecutionId(payload: DurableReactionPayload): string {
  return `reaction-execution:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

export async function executeDurableReaction(payload: DurableReactionPayload): Promise<void> {
  if (payload.ruleId !== payload.cause.ruleId) return;
  // Read at actual execution, not enqueue time. A queued or recovered reaction
  // withheld by policy must not consume a claim or pretend an effect completed.
  // notify-classification: {"id":"packages/operator-core/lib/events/durable-exec.ts#<module>/executeDurableReaction:89cdbf4853cbe29c6593:1","classification":"durable","reason":"Execution-time policy/bootstrap may reach mandatory notices; retain custody in the awaited durable reaction and its terminal consequence.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009 must prove the shared reaction/notification terminal path across restart","deliveryState":"unverified"}
  if (payload.parent.workspaceId
    && !await reactionBackgroundActivityAllowed(payload.parent.workspaceId, payload.fire, payload.ruleId)) return;
  // notify-classification: {"id":"packages/operator-core/lib/events/durable-exec.ts#<module>/executeDurableReaction:4fe9eb5d488ece25a7b0:1","classification":"durable","reason":"The reaction wrapper owns the persisted claim and awaited dispatch, including mandatory notifications reached by the injected store and fire callbacks.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009 must prove this shared reaction's terminal effects survive restart without duplicate delivery","deliveryState":"unverified"}
  await genericExecuteDurableReaction(payload, {
    // The PG idempotency ledger (migration 153) — `harness_shared.event_reactions`.
    store: { claim: claimReaction, release: releaseReaction, markFailed: markReactionFailed,
      outcome: reactionOutcome, complete: completeReaction, uncertain: markReactionUncertain },
    // This receipt proves the short launch boundary only. It never proves that
    // the detached deploy finished or that an exact artifact shipped.
    // Force deploy has further mandatory side effects after launch; a launch
    // receipt cannot acknowledge that entire action.
    reconcile: p => p.fire === 'release:deploy' && p.args.op === 'trigger'
      ? reconcileGateActionReceipt({ workspaceId: p.parent.workspaceId!, action: p.fire,
          executionId: reactionExecutionId(p) })
      : Promise.resolve('uncertain'),
    // Rebuild the reaction's scope from the serializable parent and dispatch.
    fire: (p) =>
      fireReactionInProcess({
        fire: p.fire,
        args: p.args,
        parentCtx: { ...p.parent } as UnifiedToolContext,
        cause: p.cause,
        capability: p.capability,
        executionId: reactionExecutionId(p),
      }),
    log: (msg) => console.warn(`[events] ${msg}`),
  });
}
