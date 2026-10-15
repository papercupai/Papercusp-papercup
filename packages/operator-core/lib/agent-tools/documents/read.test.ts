import { beforeEach, describe, expect, it, vi } from 'vitest';
const identity = vi.hoisted(() => ({ subject: vi.fn(() => 'reader-one') }));
const summary = vi.hoisted(() => ({ requests: [] as { promptText: string }[] }));
vi.mock('../_disclosure-subject', () => ({ disclosureSubject: identity.subject }));
vi.mock('../../agent-chat-stream', () => ({ runAgentChat: async function* (request: { promptText: string }) {
  summary.requests.push(request);
  yield { type: 'result', finalText: 'A concise report.', costUsd: 0, tokensIn: 10, tokensOut: 4, stopReason: 'end_turn' };
} }));
vi.mock('../../operator-budget', () => ({ checkBudget: async () => ({ exceeded: false }), recordSpend: async () => {} }));
vi.mock('../../inference-gateway/local-backend-store', () => ({ listLocalBackends: async () => [] }));
vi.mock('../../cache/instance', () => ({ getOperatorCache: () => ({ getOrSet: async (_workspace: string, _key: string, factory: () => Promise<unknown>) => factory() }) }));
import tool from './read';
const ctx = { workspaceId: 'workspace-one' } as never;

beforeEach(() => { identity.subject.mockReturnValue('reader-one'); summary.requests.length = 0; });
describe('documents:read entry path', () => {
  it('classifies original extraction as read and paid summarization as write', () => {
    const content = { kind: 'text' as const, text: 'source' };
    expect(tool.effectForCall?.({ content })).toBe('read');
    expect(tool.effectForCall?.({ content, operation: 'summarize' })).toBe('write');
  });
  it('returns original text and provenance through the registered tool handler', async () => {
    expect(tool.name).toBe('documents:read');
    const content = { kind: 'text' as const, text: 'Original\n' + 'x'.repeat(4500) + '\nTAIL', ref: 'source:one' };
    const result = await tool.handler({ content, maxChars: 6000 }, ctx);
    expect(result).toMatchObject({ data: { ok: true, text: content.text, sourceRefs: ['source:one'], access: { readerId: 'reader-one', workspaceId: 'workspace-one' }, coverage: { complete: true } } });
    expect(summary.requests).toHaveLength(0);
  });
  it('flags the default response boundary and upstream partial input', async () => {
    const result = await tool.handler({ content: { kind: 'text', text: 'x'.repeat(5000), partial: true } }, ctx);
    expect(result).toMatchObject({ data: { ok: true, text: 'x'.repeat(4000), coverage: { complete: false, warnings: ['source-partial', 'character-limit'] } } });
  });
  it('extracts selected HTML without following its links or source ref', async () => {
    const result = await tool.handler({ content: { kind: 'html', html: '<p>one</p><p>two</p>', ref: 'https://private.example.test' } }, ctx);
    expect(result).toMatchObject({ data: { ok: true, text: 'one\n\ntwo', sourceRefs: ['https://private.example.test'], coverage: { complete: true } } });
  });
  it('refuses an unresolved identity or workspace before content processing', async () => {
    identity.subject.mockReturnValue('');
    expect(await tool.handler({ content: { kind: 'text', text: 'secret' } }, ctx)).toMatchObject({ data: { ok: false, error: 'unauthorized' } });
    identity.subject.mockReturnValue('reader-one');
    expect(await tool.handler({ content: { kind: 'text', text: 'secret' } }, { workspaceId: '*' } as never)).toMatchObject({ data: { ok: false, error: 'unauthorized' } });
  });
  it('rejects reference-only requests and malformed PDF encoding at the schema boundary', () => {
    expect(tool.args.safeParse({ content: { kind: 'reference', ref: 'private:other' } }).success).toBe(false);
    expect(tool.args.safeParse({ content: { kind: 'pdf', base64: 'not base64!!' } }).success).toBe(false);
  });
  it('exposes unreadable input and request cancellation as honest failures', async () => {
    expect(await tool.handler({ content: { kind: 'html', html: '<script>no text</script>' } }, ctx)).toMatchObject({ data: { ok: false, error: 'unreadable' } });
    const controller = new AbortController(); controller.abort();
    expect(await tool.handler({ content: { kind: 'text', text: 'source' } }, { workspaceId: 'workspace-one', signal: controller.signal } as never)).toMatchObject({ data: { ok: false, error: 'cancelled' } });
  });
  it('summarizes full input beyond the read-response limit and keeps source coverage', async () => {
    const text = 'Report. '.repeat(9000) + 'FINAL TAIL';
    const result = await tool.handler(tool.args.parse({ operation: 'summarize', content: { kind: 'text', text, ref: 'source:whole', partial: true }, summary: { allowCloud: true }, maxChars: 10 }), ctx);
    expect(result).toMatchObject({ data: { ok: true, operation: 'summarize', summary: 'A concise report.', sourceRefs: ['source:whole'], coverage: { complete: false, characters: text.length, warnings: ['source-partial'] } } });
    const leaves = summary.requests.map(r => JSON.parse(r.promptText)).filter(r => r.phase.startsWith('source chunk'));
    expect(leaves.map(r => r.quotedSource).join('')).toBe(text);
  });
  it('checks access before touching any summary or cached private result', async () => {
    identity.subject.mockReturnValue('');
    expect(await tool.handler(tool.args.parse({ operation: 'summarize', content: { kind: 'text', text: 'private source' }, summary: { allowCloud: true } }), ctx)).toMatchObject({ data: { ok: false, error: 'unauthorized' } });
    expect(summary.requests).toHaveLength(0);
  });
});
