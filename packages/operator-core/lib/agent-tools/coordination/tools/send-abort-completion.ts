/**
 * Resolve the durable effect of a `coord:send` handler that returned after its
 * dispatch deadline. Message ids in the completed response are the append
 * receipts; ambiguous or malformed rows stay explicitly unresolved.
 */
import type { AbortCompletionContext, AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { asRecord, completedResultPayload } from '../../abort-completion-payload';

// These outcomes are returned before sendMessage persists anything. Other
// failures are deliberately not treated as proof: an exception can race a
// write, and a future post-persist path may report an error without an id.
const PRE_PERSIST_REFUSALS = new Set([
  'ambiguous_hive_scope',
  'body_exceeds_inbox_cap',
  'fleet_scoped_cue_allhive_contradiction',
  'goal-owner-report-incomplete',
  'goal-owner-report-over-cap',
  'goal-owner-report-untruthful',
  'no_hive_scope',
  'related_msg_ambiguous',
  'related_msg_not_found',
  'report_invalid',
  'report_reference_unavailable',
  'relay_origin_not_found',
  'request_aborted',
  'unknown_hive',
  'unknown_recipient',
]);

function incomplete(
  reason: string,
  failures: readonly string[],
  diagnostics?: Record<string, unknown>,
): AbortCompletionReceipt {
  return {
    status: 'recovery-incomplete',
    reason,
    failures,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export function coordSendPhaseTimingDiagnostics(rows: readonly unknown[]): Record<string, unknown> | undefined {
  const phaseTimings = rows.flatMap((value, itemIndex) => {
    const row = asRecord(value);
    const timing = asRecord(row?.phaseTimingsMs);
    if (!timing) return [];
    const readMs = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
    const prePersistMs = readMs(timing.prePersistMs);
    const persistMs = readMs(timing.persistMs);
    const postPersistMs = readMs(timing.postPersistMs);
    if (prePersistMs === null && persistMs === null && postPersistMs === null) return [];
    return [{ itemIndex, prePersistMs, persistMs, postPersistMs }];
  });
  return phaseTimings.length > 0 ? { coordSendPhaseTimingsMs: phaseTimings } : undefined;
}

export function coordSendAbortCompletionReceipt(
  _args: unknown,
  result: ToolResult,
  context: AbortCompletionContext,
): AbortCompletionReceipt {
  if (context.toolName !== 'coord:send' || !context.callId.trim()) {
    return incomplete('coord:send receipt is missing its dispatch attempt identity', ['missing-attempt-identity']);
  }

  const payload = completedResultPayload(result);
  if (!payload || !Array.isArray(payload.results) || payload.results.length === 0) {
    return incomplete('coord:send result did not contain per-message completion rows', ['missing-message-results']);
  }

  const recordedIds: string[] = [];
  const unresolvedRows: number[] = [];
  const rows = payload.results as unknown[];
  const diagnostics = coordSendPhaseTimingDiagnostics(rows);
  rows.forEach((value, index) => {
    const row = asRecord(value);
    if (!row) {
      unresolvedRows.push(index);
      return;
    }
    const msgId = typeof row.msg_id === 'string' ? row.msg_id.trim() : '';
    if (msgId) {
      recordedIds.push(msgId);
      return;
    }
    const error = typeof row.error === 'string' ? row.error.trim() : '';
    if (row.ok !== false || !PRE_PERSIST_REFUSALS.has(error)) unresolvedRows.push(index);
  });

  const effects = [...new Set(recordedIds)];
  const effectRef = effects.length > 0 ? `coord:send:${effects.join(',')}` : undefined;
  if (unresolvedRows.length > 0) {
    return {
      ...incomplete(
        `coord:send returned ${effects.length} persisted message id(s), but rows ${unresolvedRows.join(', ')} do not prove whether they were appended`,
        ['unresolved-message-outcomes'],
        diagnostics,
      ),
      ...(effectRef ? { effectRef } : {}),
    };
  }
  if (effects.length > 0) {
    return {
      status: 'recorded',
      effectRef,
      ...(diagnostics ? { diagnostics } : {}),
      ...(effects.length < rows.length
        ? { reason: `coord:send appended ${effects.length} of ${rows.length} message(s); see the completed result for pre-persist refusals` }
        : {}),
    };
  }
  return {
    status: 'not-recorded',
    reason: 'every coord:send result row is an explicit pre-persist refusal',
    ...(diagnostics ? { diagnostics } : {}),
  };
}
