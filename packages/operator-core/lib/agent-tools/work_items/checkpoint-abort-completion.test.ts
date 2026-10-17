import type { ToolResult } from '@papercusp/tooldef';
import { describe, expect, it } from 'vitest';

import checkpoint from './checkpoint';
import { workItemsCheckpointAbortCompletionReceipt } from './checkpoint-abort-completion';

function result(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ data: payload }) }],
  } as ToolResult;
}

describe('work_items:checkpoint abort-completion receipt', () => {
  it('records a successful checkpoint write and an explicit clear', () => {
    expect(
      workItemsCheckpointAbortCompletionReceipt(
        {},
        result({ results: [{ ok: true, id: 'WI-1', cleared: false, contentHash: 'abc' }] }),
      ),
    ).toEqual({ status: 'recorded', effectRef: 'work-item-checkpoint:WI-1' });

    expect(
      workItemsCheckpointAbortCompletionReceipt(
        {},
        result({ results: [{ ok: true, id: 'WI-2', cleared: true, contentHash: null }] }),
      ),
    ).toEqual({ status: 'recorded', effectRef: 'work-item-checkpoint:WI-2' });
  });

  it('records a write whose post-commit verify/read failed', () => {
    expect(
      workItemsCheckpointAbortCompletionReceipt(
        {},
        result({
          results: [
            {
              ok: false,
              id: 'WI-verify',
              errorCode: 'checkpoint_verify_unavailable',
              writeCommitted: true,
            },
          ],
        }),
      ),
    ).toEqual({ status: 'recorded', effectRef: 'work-item-checkpoint:WI-verify' });
  });

  it('records landed rows while preserving the full late result for explicit no-commit rows', () => {
    expect(
      workItemsCheckpointAbortCompletionReceipt(
        {},
        result({
          results: [
            { ok: true, id: 'WI-landed', cleared: false },
            { ok: false, id: 'WI-timeout', errorCode: 'timeout', writeCommitted: false },
          ],
        }),
      ),
    ).toEqual({ status: 'recorded', effectRef: 'work-item-checkpoint:WI-landed' });
  });

  it('reports an all-refusal result as not-recorded', () => {
    expect(
      workItemsCheckpointAbortCompletionReceipt(
        {},
        result({
          results: [
            { ok: false, id: 'WI-A', errorCode: 'terminal_item' },
            { ok: false, id: 'WI-B', errorCode: 'timeout' },
          ],
        }),
      ),
    ).toEqual({
      status: 'not-recorded',
      reason: 'every work_items:checkpoint row explicitly completed without a committed write',
    });
  });

  it('fails closed when a row could have committed but does not prove it', () => {
    expect(
      workItemsCheckpointAbortCompletionReceipt(
        {},
        result({ results: [{ ok: false, id: 'WI-unknown', error: 'post-write handler failure' }] }),
      ),
    ).toMatchObject({ status: 'recovery-incomplete', failures: ['unresolved-checkpoint-outcomes'] });

    expect(
      workItemsCheckpointAbortCompletionReceipt({}, result({ results: [{ ok: true, cleared: false }] })),
    ).toMatchObject({ status: 'recovery-incomplete', failures: ['unresolved-checkpoint-outcomes'] });
  });

  it('fails closed on an empty or malformed completed result', () => {
    expect(workItemsCheckpointAbortCompletionReceipt({}, result({ results: [] }))).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['no-checkpoint-results'],
    });
    expect(workItemsCheckpointAbortCompletionReceipt({}, { content: [] } as unknown as ToolResult)).toMatchObject({
      status: 'recovery-incomplete',
    });
  });

  it('declares the resolver on the live tool contract', () => {
    expect(checkpoint.abortCompletionReceipt).toBe(workItemsCheckpointAbortCompletionReceipt);
  });
});
