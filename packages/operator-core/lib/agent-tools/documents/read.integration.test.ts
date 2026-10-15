import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
const summaryTransport = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[], stalled: false }));
vi.mock('../../agent-chat-stream', () => ({
  runAgentChat: async function* (request: Record<string, unknown>) {
    summaryTransport.requests.push(request);
    if (summaryTransport.stalled) await new Promise(() => {});
    const input = JSON.parse(request.promptText as string);
    yield { type: 'result', finalText: input.quotedSource.includes('TAIL-942') ? 'Includes TAIL-942.' : 'Intermediate report.',
      costUsd: 0, tokensIn: 10, tokensOut: 4, stopReason: 'end_turn', servedAccount: 'integration-account' };
  },
}));
vi.mock('../../operator-budget', () => ({ checkBudget: async () => ({ exceeded: false }), recordSpend: async () => {} }));
vi.mock('../../inference-gateway/local-backend-store', () => ({ listLocalBackends: async () => [] }));
vi.mock('../../cache/instance', () => ({ getOperatorCache: () => ({
  getOrSet: async (_workspace: string, _key: string, factory: () => Promise<unknown>) => factory(),
}) }));
import './read';

function context(overrides: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return {
    log: () => {}, progress: () => {}, emit: () => {},
    signal: new AbortController().signal, role: 'operator', runId: 'content-read-fixture',
    workspaceId: 'content-read-private-fixture', uiClientId: 'su-content-read-fixture', isSuperuser: true,
    principal: { slug: 'content-reader', workspaceId: 'content-read-private-fixture', capabilities: new Set(['search:read']) },
    transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    ...overrides,
  };
}
const projected = lookupByMcpName('documents:read');
if (!projected) throw new Error('documents:read must be registered');
const dispatch = (args: unknown, ctx = context()) => dispatchProjectedTool(projected, 'documents:read', args, ctx, {});
beforeEach(() => { summaryTransport.requests.length = 0; summaryTransport.stalled = false; });

describe('documents:read projection and intake integration', () => {
  it('preserves bounded summary failure diagnostics through the real projection', async () => {
    summaryTransport.stalled = true;
    const response = await dispatch({ operation: 'summarize', content: { kind: 'text', text: 'PRIVATE SOURCE-938' },
      summary: { allowCloud: true, timeoutMs: 100 } });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: false, error: 'budget-exceeded',
      diagnostics: { stage: 'model-wait', phase: 'source chunk 1/1', calls: 1 } });
    expect(JSON.stringify(response.result?.structuredContent)).not.toContain('PRIVATE SOURCE-938');
  });
  it('runs the real registry, input schema, identity and HTML reader together', async () => {
    const response = await dispatch({ content: { kind: 'html', html: '<title>Source title</title><p>FIRST</p><p>TAIL</p>', ref: 'already-read:article' } });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: true, text: 'FIRST\n\nTAIL', title: 'Source title', sourceRefs: ['already-read:article'], access: { workspaceId: 'content-read-private-fixture', readerId: 'su-content-read-fixture' }, coverage: { complete: true } });
  });
  it('validates source references as provenance without creating a source-fetch route', async () => {
    const response = await dispatch({ content: { kind: 'reference', ref: 'private:unread' } });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_input');
  });
  it('keeps role and capability denial ahead of the reader', async () => {
    const args = { content: { kind: 'text', text: 'private content' } };
    const roleDenied = await dispatch(args, context({ role: 'unapproved-role' }));
    expect(roleDenied.ok).toBe(false);
    expect(roleDenied.error?.code).toBe('role_not_allowed');
    const capabilityDenied = await dispatch(args, context({ principal: { slug: 'content-reader', workspaceId: 'content-read-private-fixture', capabilities: new Set() } }));
    expect(capabilityDenied.ok).toBe(false);
    expect(capabilityDenied.error?.code).toBe('missing_capability');
  });
  it('serializes incomplete coverage through the real result projection', async () => {
    const response = await dispatch({ content: { kind: 'selection', text: 'first\nlast', partial: true }, maxChars: 6 });
    expect(response.ok).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: true, text: 'first\n', coverage: { complete: false, warnings: ['source-partial', 'character-limit'] } });
  });
  it('accepts a bounded provided-source collection through the real tool schema', async () => {
    const response = await dispatch({ content: { kind: 'collection', sources: [
      { kind: 'text', text: 'FIRST', ref: 'provided:one' },
      { kind: 'html', html: '<p>FINAL</p>', ref: 'provided:two', partial: true },
    ] } });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: true, text: 'FIRST\n\nFINAL', sourceRefs: ['provided:one', 'provided:two'], coverage: { complete: false, warnings: ['source-partial'] } });
    const denied = await dispatch({ content: { kind: 'collection', sources: [{ kind: 'reference', ref: 'private:unread' }] } });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('invalid_input');
  });
  it('summarizes the complete provided sources through registry, schema, intake and summary routing', async () => {
    const first = ('😀 Café.\n').repeat(3500);
    const final = 'FINAL TAIL-942';
    const response = await dispatch({ operation: 'summarize', maxChars: 6,
      content: { kind: 'collection', sources: [
        { kind: 'text', text: first, ref: 'provided:one' },
        { kind: 'html', html: `<p>${final}</p>`, ref: 'provided:two', partial: true },
      ] },
      summary: { allowCloud: true, model: 'integration-model', account: 'integration-account',
        length: 'short', audience: 'engineers', focus: 'coverage', format: 'bullets', language: 'Spanish', maxCalls: 20 },
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: true, operation: 'summarize',
      summary: 'Includes TAIL-942.', sourceRefs: ['provided:one', 'provided:two'],
      coverage: { complete: false, characters: first.length + 2 + final.length, warnings: ['source-partial'] },
      servedAccounts: ['integration-account'],
    });
    const inputs = summaryTransport.requests.map(request => JSON.parse(request.promptText as string));
    const leaves = inputs.filter(input => input.phase.startsWith('source chunk'));
    expect(leaves.length).toBeGreaterThan(1);
    expect(leaves.map(input => input.quotedSource).join('')).toBe(first + '\n\n' + final);
    expect(inputs).toHaveLength(leaves.length + 1);
    expect(inputs.at(-1).quotedSource).toContain('Includes TAIL-942.');
    for (const request of summaryTransport.requests) {
      expect(request).toMatchObject({ backend: 'anthropic-direct', model: 'integration-model',
        routeAccountId: 'integration-account', maxTokens: 256 });
      expect(JSON.parse(request.promptText as string)).toMatchObject({ audience: 'engineers', focus: 'coverage',
        format: 'bullets', language: 'Spanish', sourceRefs: ['provided:one', 'provided:two'], sourceCoverage: { complete: false } });
    }
  });
});
