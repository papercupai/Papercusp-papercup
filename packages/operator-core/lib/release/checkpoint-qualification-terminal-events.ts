/** Pending terminal wakes share the exact verdict's existing pipeline row. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { executeDurableReaction } from '@papercusp/event-reaction';
import { getOrgPg } from '@papercusp/db-org';
import type { GateVerdictTarget } from './gate-verdict-target';
import { readStoredQualification } from './checkpoint-qualification-transaction';
import { claimReaction, releaseReaction, markReactionFailed, reactionOutcome,
  completeReaction, markReactionUncertain } from '../events/reaction-dedup';

export interface CheckpointTerminalEvent {
  key: string; summary: string; payload: unknown; cancelSiblingKeysFor?: string[];
}
type TerminalIdentity = GateVerdictTarget & {
  attemptId: string; candidate: string; runId: string; green: boolean; candidates: string[];
};
export interface CheckpointTerminalDelivery {
  schemaVersion: 1; batchId: string; identity: TerminalIdentity; pending: boolean;
  events: Array<CheckpointTerminalEvent & { id: string }>; accepted: Record<string, boolean>;
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function checkpointTerminalDelivery(identity: TerminalIdentity, events: CheckpointTerminalEvent[]): CheckpointTerminalDelivery {
  if ([identity.workspaceId, identity.installSlug, identity.attemptId, identity.candidate, identity.runId]
      .some(value => typeof value !== 'string' || !value.trim()) || !events.length || events.length > 4 ||
      typeof identity.green !== 'boolean' || !Array.isArray(identity.candidates) || !identity.candidates.includes(identity.candidate))
    throw new Error('checkpoint terminal wake identity/population is unmeasured');
  const keys = new Set<string>();
  const bound = events.map(event => {
    const payload = event.payload as Record<string, unknown> | null;
    const family = identity.green ? 'release:green' : 'green-checkpoint:red';
    if (![family, family + ':' + identity.installSlug].includes(event.key) || keys.has(event.key) || !payload ||
        typeof payload.sha !== 'string' || !identity.candidates.includes(payload.sha) ||
        payload.runId !== identity.runId || typeof event.summary !== 'string')
      throw new Error('checkpoint terminal wake fence mismatch');
    keys.add(event.key);
    return { ...event, id: 'checkpoint-terminal:' + fingerprint({ identity, event }) };
  });
  return { schemaVersion: 1, batchId: fingerprint({ identity, events: bound }), identity,
    pending: true, events: bound, accepted: {} };
}

/** An exact replay may attach a batch omitted by an earlier same-run recorder. */
export async function attachCheckpointTerminalDelivery(target: GateVerdictTarget, delivery: CheckpointTerminalDelivery): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql`
    WITH exact AS MATERIALIZED (
      SELECT id FROM harness_shared.pipeline_events WHERE workspace_id = ${target.workspaceId}
        AND install_slug = ${target.installSlug} AND kind = 'green_checkpoint'
        AND detail->>'attemptId' = ${delivery.identity.attemptId}
        AND detail->>'runId' = ${delivery.identity.runId} AND detail->>'fullCandidate' = ${delivery.identity.candidate}
        AND detail->'green' = ${JSON.stringify(delivery.identity.green)}::jsonb
      LIMIT 2
    )
    UPDATE harness_shared.pipeline_events SET detail = jsonb_set(detail, '{terminalDelivery}',
      COALESCE(detail->'terminalDelivery', ${JSON.stringify(delivery)}::jsonb))
    WHERE id IN (SELECT id FROM exact) AND (SELECT count(*) FROM exact) = 1
      AND (detail->'terminalDelivery' IS NULL OR detail->'terminalDelivery'->>'batchId' = ${delivery.batchId})
    RETURNING id`;
  return rows.length === 1;
}

/**
 * Recover admission to the existing event engine, not recipient delivery or a
 * deployed artifact. A completed reaction receipt avoids a repeated emission;
 * an interrupted claim without that receipt remains uncertain and pending.
 */
export async function recoverCheckpointTerminalEvents(target: GateVerdictTarget, deps: {
  emit?: (event: CheckpointTerminalEvent & { id: string }) => Promise<{
    ok: boolean; latchRecorded?: boolean; notified?: string[]; msgId?: string | null;
  }>;
} = {}): Promise<{ failed: string[] }> {
  const { sql } = getOrgPg();
  const failed: string[] = [];
  const rows = await sql<Array<{ id: string; detail: Record<string, unknown> }>>`
    SELECT id::text, detail FROM harness_shared.pipeline_events
    WHERE workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug} AND kind = 'green_checkpoint'
      AND detail->'terminalDelivery'->'pending' = 'true'::jsonb
    ORDER BY detail->'terminalDelivery'->>'lastAttemptAt' NULLS FIRST, id LIMIT 8`;
  for (const row of rows) {
    try {
      const delivery = row.detail.terminalDelivery as CheckpointTerminalDelivery;
      // Rebuild the immutable batch to validate JSONB before any effect.
      if (delivery.schemaVersion !== 1 || delivery.identity.workspaceId !== target.workspaceId ||
          delivery.identity.installSlug !== target.installSlug || row.detail.attemptId !== delivery.identity.attemptId ||
          row.detail.runId !== delivery.identity.runId || row.detail.fullCandidate !== delivery.identity.candidate ||
          row.detail.green !== delivery.identity.green)
        throw new Error('stored checkpoint terminal wake identity mismatch');
      const rebuilt = checkpointTerminalDelivery(delivery.identity, delivery.events.map(({ id: _id, ...event }) => event));
      if (rebuilt.batchId !== delivery.batchId || canonicalJson(rebuilt.events) !== canonicalJson(delivery.events))
        throw new Error('stored checkpoint terminal wake batch changed');
      for (const event of delivery.events) {
        if (delivery.accepted[event.id] === true) {
          if (await reactionOutcome(event.id) !== 'completed') throw new Error('terminal wake projection has no receiver receipt');
          continue;
        }
        await executeDurableReaction({ fire: 'event:' + event.key, args: {}, parent: { workspaceId: target.workspaceId },
          cause: { rootRunId: event.id, ruleId: 'checkpoint-terminal-wake', depth: 0, chain: [] },
          ruleId: 'checkpoint-terminal-wake', triggerTool: 'checkpoint:terminal', dedupId: event.id }, {
          store: { claim: claimReaction, release: releaseReaction, markFailed: markReactionFailed,
            outcome: reactionOutcome, complete: completeReaction, uncertain: markReactionUncertain },
          fire: async () => {
            // A stored historical batch cannot wake or cancel a successor's
            // current waiters. Re-read immediately before the external seam.
            const current = await readStoredQualification(target);
            if (current.status !== 'present' || current.transaction.phase !== 'terminal' ||
                current.transaction.attemptId !== delivery.identity.attemptId ||
                current.transaction.runId !== delivery.identity.runId ||
                current.transaction.candidate !== delivery.identity.candidate ||
                current.transaction.outcome.kind !== (delivery.identity.green ? 'green' : 'red'))
              throw new Error('checkpoint terminal wake superseded or current authority unmeasured');
            const emitted = deps.emit ? await deps.emit(event) : await (await import('../events/await/engine')).emitAwaitedEvent({
              ...event, workspaceId: target.workspaceId, source: 'green-checkpoint',
              cause: { rootRunId: event.id, ruleId: 'checkpoint-terminal-wake', depth: 0, chain: [] },
            });
            if (emitted.ok !== true || emitted.latchRecorded !== true || !Array.isArray(emitted.notified) ||
                (emitted.notified.length > 0 && !emitted.msgId)) throw new Error('checkpoint terminal wake admission unacknowledged');
            return { ok: true };
          },
        });
        // The reaction receipt precedes this projection. A crash here re-reads
        // that receipt automatically without re-emitting to any subscriber.
        await sql`UPDATE harness_shared.pipeline_events SET detail = jsonb_set(detail,
          ${['terminalDelivery', 'accepted', event.id]}::text[], 'true'::jsonb)
          WHERE id = ${row.id} AND workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
            AND detail->'terminalDelivery'->>'batchId' = ${delivery.batchId}`;
      }
      await sql`UPDATE harness_shared.pipeline_events SET detail = jsonb_set(detail, '{terminalDelivery,pending}', 'false'::jsonb)
        WHERE id = ${row.id} AND workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
          AND detail->'terminalDelivery'->>'batchId' = ${delivery.batchId}
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(detail->'terminalDelivery'->'events') AS event
            WHERE detail->'terminalDelivery'->'accepted'->>(event->>'id') IS DISTINCT FROM 'true')`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(row.id + ': ' + message);
      // Persist the diagnostic and rotate failed rows behind untouched batches.
      // This is a retry order, never an execution-age or custody cutoff.
      await sql`UPDATE harness_shared.pipeline_events SET detail = jsonb_set(detail, '{terminalDelivery}',
        (detail->'terminalDelivery') || ${JSON.stringify({ lastAttemptAt: new Date().toISOString(), lastError: message })}::jsonb)
        WHERE id = ${row.id} AND workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
          AND detail->'terminalDelivery' = ${JSON.stringify(row.detail.terminalDelivery)}::jsonb`;
    }
  }
  return { failed };
}
