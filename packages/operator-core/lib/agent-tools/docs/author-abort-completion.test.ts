import type { ToolResult } from '@papercusp/tooldef';
import { describe, expect, it } from 'vitest';
import docsAuthor from './author';

function result(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const args = {
  slug: 'late-write',
  title: 'Late write',
  description: 'A test document.',
  body: 'A test body.',
};
const attempt = { callId: 'call-doc-1', toolName: 'docs:author' };

describe('docs:author abort-completion receipt', () => {
  it('identifies the canonical document even when projection reports a warning', () => {
    expect(docsAuthor.abortCompletionReceipt?.(
      args,
      result({
        ok: true,
        storageHarness: 'papercusp',
        ref: 'agent-insights/late-write',
        path: 'agent-insights/late-write.mdx',
        warnings: ['the .mdx projection failed to write'],
      }),
      attempt,
    )).toEqual({
      status: 'recorded',
      effectRef: 'docs-author:papercusp:agent-insights/late-write',
    });
  });

  it('fails closed when the result does not prove that a canonical document was saved', () => {
    expect(docsAuthor.abortCompletionReceipt?.(args, result({ ok: false, error: 'doc_not_saved' }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-saved-doc-ref'],
    });
    expect(docsAuthor.abortCompletionReceipt?.(args, result({ ok: true, path: 'agent-insights/late-write.mdx' }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-saved-doc-ref'],
    });
  });
});
