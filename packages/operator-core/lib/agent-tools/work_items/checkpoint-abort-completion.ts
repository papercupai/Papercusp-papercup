/**
 * Completion receipt for `work_items:checkpoint`.
 *
 * The checkpoint body is persisted before the handler finishes its verify/read and
 * advisory tail. If the dispatch deadline aborts after that write, the caller used
 * to receive only a generic timeout and could append the same note again. A per-row
 * success or `writeCommitted:true` result is durable evidence that the checkpoint
 * landed; rows whose result does not prove either outcome stay recovery-incomplete.
 */
import type { AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { asRecord, completedResultPayload } from '../abort-completion-payload';

/** Error codes emitted before the checkpoint store commits anything. */
const EXPLICIT_NO_COMMIT_ERRORS = new Set([
  'attestation_conflicting_args',
  'attestation_hash_required',
  'checkpoint_replace_would_drop_rows',
  'checkpoint_required',
  'checkpoint_retire_ids_mismatch',
  'checkpoint_retire_ids_requires_replace',
  'clear_with_checkpoint',
  'empty_checkpoint_requires_confirmation',
  'terminal_item',
  'timeout',
  'work_item_not_found',
]);

function effectRef(ids: readonly string[]): string {
  return `work-item-checkpoint:${[...new Set(ids)].join(',')}`;
}

export function workItemsCheckpointAbortCompletionReceipt(
  _args: unknown,
  result: ToolResult,
): AbortCompletionReceipt {
  const payload = completedResultPayload(result);
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  if (rows.length === 0) {
    return {
      status: 'recovery-incomplete',
      reason: 'work_items:checkpoint result did not contain per-item outcomes after abort',
      failures: ['no-checkpoint-results'],
    };
  }

  const recordedIds: string[] = [];
  const explicitNoCommitRows: number[] = [];
  const unresolvedRows: number[] = [];

  rows.forEach((value, index) => {
    const row = asRecord(value);
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!row || !id) {
      unresolvedRows.push(index);
      return;
    }

    // A failed verify/read is still a committed checkpoint. The handler marks this
    // explicitly so a caller never retries an append merely because visibility was
    // unavailable after the write.
    if (row.writeCommitted === true || row.ok === true) {
      recordedIds.push(id);
      return;
    }

    const errorCode = typeof row.errorCode === 'string' ? row.errorCode : '';
    if (row.writeCommitted === false || EXPLICIT_NO_COMMIT_ERRORS.has(errorCode)) {
      explicitNoCommitRows.push(index);
      return;
    }

    // A generic runBulk error may have happened after the store write. Do not infer
    // that it was harmless; force a read before any retry.
    unresolvedRows.push(index);
  });

  if (unresolvedRows.length > 0) {
    const committed = recordedIds.length > 0 ? { effectRef: effectRef(recordedIds) } : {};
    return {
      status: 'recovery-incomplete',
      reason:
        `work_items:checkpoint recorded ${recordedIds.length} checkpoint row(s), but ` +
        `row(s) ${unresolvedRows.join(', ')} do not prove whether their writes committed`,
      failures: ['unresolved-checkpoint-outcomes'],
      ...committed,
    };
  }

  if (recordedIds.length > 0) {
    return { status: 'recorded', effectRef: effectRef(recordedIds) };
  }

  if (explicitNoCommitRows.length === rows.length) {
    return {
      status: 'not-recorded',
      reason: 'every work_items:checkpoint row explicitly completed without a committed write',
    };
  }

  return {
    status: 'recovery-incomplete',
    reason: 'work_items:checkpoint result did not prove whether its write committed',
    failures: ['checkpoint-effect-unproven'],
  };
}
