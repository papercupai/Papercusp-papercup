import { afterEach, expect, it, vi } from 'vitest';
import { OperatorTarget } from '../targets/operator';

afterEach(() => vi.unstubAllGlobals());

it('captures actual public result summaries and errors from SSE with secret redaction', async () => {
  const events = [
    ['tool_call', { name: 'docs:get', input: { slugs: ['faq'] } }],
    ['tool_result', { name: 'docs:get', summary: JSON.stringify({ marker: 'PUBLIC-ORCHARD', token: 'secret-fixture' }), ok: true }],
    ['tool_result', { name: 'docs:search', summary: 'public manual unavailable', ok: false }],
    ['tool_result', { name: 'malformed', summary: 42 }],
    ['delta', { text: 'Consult the manual.' }],
    ['done', { costUsd: 0 }],
  ];
  const wire = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } })));
  const session = await new OperatorTarget({ baseUrl: 'http://fixture.test', hostTrust: 'public' }).open({ runId: 'public-results-fixture', workspaceMode: 'real', transport: 'http-sse' });
  try {
    const result = await session.send({ messages: [{ role: 'user', content: 'Help' }], trigger: 'user_message' });
    expect(result.finishReason).toBe('done');
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults[0]).toMatchObject({ name: 'docs:get', isError: false });
    expect(result.toolResults[0].output).toContain('PUBLIC-ORCHARD');
    expect(result.toolResults[0].output).not.toContain('secret-fixture');
    expect(result.toolResults[1]).toMatchObject({ name: 'docs:search', isError: true });
  } finally { await session.close(); }
});
