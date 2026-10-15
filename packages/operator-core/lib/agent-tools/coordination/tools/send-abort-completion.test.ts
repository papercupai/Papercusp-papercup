import type { ToolResult } from '@papercusp/tooldef';
import { describe, expect, it } from 'vitest';
import { coordSendAbortCompletionReceipt } from './send-abort-completion';

function result(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const attempt = { callId: 'call-send-1', toolName: 'coord:send' };

describe('coord:send abort-completion receipt', () => {
  it('returns the persisted message ids, including when another bulk row refused before persistence', () => {
    expect(coordSendAbortCompletionReceipt({}, result({
      ok: false,
      partial: true,
      results: [
        {
          ok: true,
          to: ['peer-1'],
          msg_id: 'm-landed',
          phaseTimingsMs: { prePersistMs: 8, persistMs: 12, postPersistMs: 5 },
        },
        { ok: false, to: ['missing-peer'], error: 'unknown_recipient' },
      ],
    }), attempt)).toEqual({
      status: 'recorded',
      effectRef: 'coord:send:m-landed',
      diagnostics: {
        coordSendPhaseTimingsMs: [{ itemIndex: 0, prePersistMs: 8, persistMs: 12, postPersistMs: 5 }],
      },
      reason: 'coord:send appended 1 of 2 message(s); see the completed result for pre-persist refusals',
    });
  });

  it('confirms an explicit request-aborted row was not appended', () => {
    expect(coordSendAbortCompletionReceipt({}, result({
      ok: false,
      results: [{ ok: false, to: ['peer-1'], error: 'request_aborted' }],
    }), attempt)).toEqual({
      status: 'not-recorded',
      reason: 'every coord:send result row is an explicit pre-persist refusal',
    });
  });

  it('confirms known scope and relay refusals happened before persistence', () => {
    expect(coordSendAbortCompletionReceipt({}, result({
      ok: false,
      results: [
        { ok: false, error: 'unknown_hive' },
        { ok: false, error: 'ambiguous_hive_scope' },
        { ok: false, error: 'relay_origin_not_found' },
      ],
    }), attempt)).toMatchObject({
      status: 'not-recorded',
    });
  });

  it('fails closed for an error row without a persisted id or a known pre-persist refusal', () => {
    expect(coordSendAbortCompletionReceipt({}, result({
      ok: false,
      results: [{ ok: false, to: ['peer-1'], error: 'database deadline expired' }],
    }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['unresolved-message-outcomes'],
    });
  });

  it('fails closed for malformed results and the wrong attempt identity', () => {
    expect(coordSendAbortCompletionReceipt({}, result({ ok: true }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-message-results'],
    });
    expect(coordSendAbortCompletionReceipt({}, result({ results: [{ ok: true, msg_id: 'm1' }] }), {
      ...attempt,
      toolName: 'coord:other',
    })).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-attempt-identity'],
    });
  });
});
