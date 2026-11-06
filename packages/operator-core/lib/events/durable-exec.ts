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
import {
  executeDurableReaction as genericExecuteDurableReaction,
  type DurableReactionPayload as GenericDurableReactionPayload,
} from '@papercusp/event-reaction';
import { fireReactionInProcess, reactionBackgroundActivityAllowed } from './dispatch-reaction';
import { claimReaction, releaseReaction, markReactionFailed, reactionOutcome, completeReaction, markReactionUncertain } from './reaction-dedup';
import type { SerializableReactionParent } from './reaction-id';

/** The JSON-serializable workflow payload for one durable reaction. */
export type DurableReactionPayload = GenericDurableReactionPayload<SerializableReactionParent>;

export async function executeDurableReaction(payload: DurableReactionPayload): Promise<void> {
  if (payload.ruleId !== payload.cause.ruleId) return;
  // Read at actual execution, not enqueue time. A queued or recovered reaction
  // withheld by policy must not consume a claim or pretend an effect completed.
  // notify-classification: {"id":"packages/operator-core/lib/events/durable-exec.ts#<module>/executeDurableReaction:89cdbf4853cbe29c6593:1","classification":"durable","reason":"Execution-time policy/bootstrap may reach mandatory notices; retain custody in the awaited durable reaction and its terminal consequence.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009 must prove the shared reaction/notification terminal path across restart","deliveryState":"unverified"}
  if (payload.parent.workspaceId
    && !await reactionBackgroundActivityAllowed(payload.parent.workspaceId, payload.fire, payload.ruleId)) return;
  await genericExecuteDurableReaction(payload, {
    // The PG idempotency ledger (migration 153) — `harness_shared.event_reactions`.
    store: { claim: claimReaction, release: releaseReaction, markFailed: markReactionFailed,
      outcome: reactionOutcome, complete: completeReaction, uncertain: markReactionUncertain },
    // Rebuild the reaction's scope from the serializable parent and dispatch.
    fire: (p) =>
      fireReactionInProcess({
        fire: p.fire,
        args: p.args,
        parentCtx: { ...p.parent } as UnifiedToolContext,
        cause: p.cause,
        capability: p.capability,
      }),
    log: (msg) => console.warn(`[events] ${msg}`),
  });
}
