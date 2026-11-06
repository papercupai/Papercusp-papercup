/**
 * `executeDurableReaction` — the body a durable reaction step runs.
 *
 * Serializable-friendly: it takes the JSON-shaped payload a durable runner
 * enqueued (the live event isn't serializable, so the host extracts a
 * serializable `parent` scope + a precomputed dedup id). It:
 *   1. claims the dedup id; only a recorded completion makes replay a no-op;
 *   2. dispatches via the injected `fire` port (the host rebuilds its call scope
 *      from `payload.parent`);
 *   3. records completion, or retains uncertainty for reconciliation. A claim
 *      without a completion never authorizes a second non-idempotent effect.
 *
 * Generic over the serializable parent shape; the only requirement is a
 * `workspaceId` to scope the claim.
 */

import type { ReactionCause } from './types';
import type { ReactionStore } from './dedup';

/** The JSON-serializable workflow payload for one durable reaction. */
export interface DurableReactionPayload<TParent extends { workspaceId?: string } = { workspaceId?: string }> {
  fire: string;
  args: Record<string, unknown>;
  /** The serializable scope the host rebuilds its call ctx from. */
  parent: TParent;
  cause: ReactionCause;
  ruleId: string;
  triggerTool: string;
  dedupId: string;
  /** Capability scope for a sandboxed rule. Unset ⇒ first-party trusted. */
  capability?: string;
  /** Who contributed the rule (`rule.source`) — the claim's attribution key. */
  contributor?: string | null;
}

export interface ExecuteDurableReactionDeps<TParent extends { workspaceId?: string }> {
  /** The idempotency ledger. */
  store: ReactionStore & {
    /** Only a recorded completion proves that a previous dispatch finished. */
    outcome(dedupId: string): Promise<'completed' | 'uncertain'>;
    complete(dedupId: string): Promise<void>;
    uncertain(dedupId: string, reason: string): Promise<void>;
  };
  /** Dispatch the reaction (host rebuilds its scope from `payload.parent`). */
  fire: (payload: DurableReactionPayload<TParent>) => Promise<{
    ok: boolean; error?: string;
    /** Trusted executor rejected admission before attempting ANY effect. */
    withheld?: boolean;
  }>;
  /** Independently read a receiver's exact durable receipt; never repeat its effect. */
  reconcile?: (payload: DurableReactionPayload<TParent>) => Promise<'completed' | 'uncertain'>;
  /** Optional logger for the no-workspace skip. */
  log?: (msg: string) => void;
}

export async function executeDurableReaction<TParent extends { workspaceId?: string }>(
  payload: DurableReactionPayload<TParent>,
  deps: ExecuteDurableReactionDeps<TParent>,
): Promise<void> {
  const workspaceId = payload.parent.workspaceId;
  if (!workspaceId) {
    deps.log?.(`durable reaction ${payload.ruleId} has no workspace; skipping`);
    return;
  }

  // A claim is intent, not proof that the effect completed. Never turn an
  // interrupted claim into a successful no-op or blindly repeat its effect.
  const fresh = await deps.store.claim({
    dedupId: payload.dedupId,
    workspaceId,
    ruleId: payload.ruleId,
    fire: payload.fire,
    triggerTool: payload.triggerTool,
    causeRootRunId: payload.cause.rootRunId ?? null,
    depth: payload.cause.depth,
    contributor: payload.contributor ?? null,
  });
  if (!fresh) {
    if (await deps.store.outcome(payload.dedupId) === 'completed') return;
    // A receiver can commit its own receipt before this runner acknowledges it.
    // Only that receiver's positive evidence may close the interrupted claim.
    try {
      if (await deps.reconcile?.(payload) === 'completed') {
        await deps.store.complete(payload.dedupId);
        return;
      }
    } catch (error) {
      const reason = `reaction ${payload.dedupId} needs reconciliation: receipt read or acknowledgment failed: ${error instanceof Error ? error.message : String(error)}`;
      await deps.store.uncertain(payload.dedupId, reason);
      throw new Error(reason, { cause: error });
    }
    const reason = `reaction ${payload.dedupId} needs reconciliation: prior dispatch has no recorded completion`;
    await deps.store.uncertain(payload.dedupId, reason);
    throw new Error(reason);
  }

  try {
    const r = await deps.fire(payload);
    if (!r.ok) throw new Error(r.error ?? 'dispatch failed');
    if (r.withheld === true) {
      // This positive no-effect receipt is distinct from an ambiguous failure.
      // Leave a later authorized execution eligible, without recording a start.
      await deps.store.release(payload.dedupId);
      return;
    }
    // Persist independently of the DBOS result, covering a crash between the
    // effect's completion receipt and its step checkpoint.
    await deps.store.complete(payload.dedupId);
  } catch (error) {
    const reason = `reaction ${payload.dedupId} needs reconciliation: ${error instanceof Error ? error.message : String(error)}`;
    await deps.store.uncertain(payload.dedupId, reason);
    throw new Error(reason, { cause: error });
  }
}
