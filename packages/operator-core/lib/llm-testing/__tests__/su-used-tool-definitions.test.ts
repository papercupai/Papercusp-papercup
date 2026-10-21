import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactInputSchema, summaryGuidanceDescription } from '@papercusp/tooldef';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import { LEARNING_MODEL_SPEC } from '../../learning/model-policy';
import { parseSuConfigDelta, SuTarget } from '../targets/su';
import { buildCatalog } from '../targets/su-catalog';

const fixture = vi.hoisted(() => ({ entries: [
  'tools:find', 'tools:invoke', 'docs:get', 'plans:get', 'work_items:list',
].map(name => ({ name, description: `Read ${name}. Keep this original FULL guidance after actual use.`,
  input: { type: 'object', properties: { name: { type: 'string', description: 'Original argument guidance', default: 'fixture' } } },
})) }));

vi.mock('../targets/su-compact-catalog', async () => {
  const { buildCatalog } = await import('../targets/su-catalog');
  const { compactInputSchema, summaryGuidanceDescription } = await import('@papercusp/tooldef');
  return {
    buildShippingSeedCatalog: async (tier: string) => ({ catalog: buildCatalog(fixture.entries.map(entry => ({
      ...entry, ...(tier === 'compact' ? { description: summaryGuidanceDescription(entry.description),
        input: compactInputSchema(entry.input) as Record<string, unknown> } : {}),
    }))) }),
    projectCatalogToCompactTier: vi.fn(() => { throw new Error('Unexpected curated projection'); }),
  };
});

afterEach(() => vi.unstubAllEnvs());

function response(output: unknown[]): Response {
  return new Response(`data: ${JSON.stringify({ type: 'response.completed',
    response: { output, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } });
}

describe('D-058 actual-use definition delivery in both SUT provider loops', () => {
  it('rejects ambiguous or silently ignored candidate configuration', () => {
    for (const fullDefinitionsAfterUse of ['true', 1, null]) {
      expect(() => parseSuConfigDelta({ fullDefinitionsAfterUse })).toThrow('must be a boolean');
    }
    expect(() => parseSuConfigDelta({ fullDefinitionsAfterUse: true })).toThrow('requires compact shipping-seed');
    expect(() => parseSuConfigDelta({ fullDefinitionsAfterUse: true, catalogSource: 'shipping-seed',
      toolDefinitionTier: 'full' })).toThrow('requires compact shipping-seed');
    expect(parseSuConfigDelta({})).not.toHaveProperty('fullDefinitionsAfterUse');
  });

  it.each(['anthropic', 'codex'] as const)('%s promotes direct and nested use, retains across turns, and records exact wire manifests', async provider => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-only-key');
    vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', 'https://example.test');
    const requests: Array<{ tools: Array<Record<string, unknown>> }> = [];
    const names = ['tools__find', 'docs__get', 'tools__invoke'];
    const inputs = [{ query: 'Read a plan' }, {}, { name: 'work_items:list', args: {} }];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const index = requests.length - 1;
      if (provider === 'codex') return response(index < names.length ? [{ type: 'function_call',
        id: `fc_${index}`, call_id: `call_${index}`, name: names[index], arguments: JSON.stringify(inputs[index]) }] : [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
      ]);
      return new Response(JSON.stringify({ id: `msg_${index}`, type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-6', content: index < names.length ? [{ type: 'tool_use', id: `tu_${index}`,
          name: names[index], input: inputs[index] }] : [{ type: 'text', text: 'Done.' }],
        stop_reason: index < names.length ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    });
    const target = new SuTarget({ catalog: buildCatalog([]), loadSystemPrompt: () => 'Read and report.',
      codexFetch: fetchImpl as typeof fetch, anthropicFetch: fetchImpl as typeof fetch });
    const options = { runId: `used-${provider}`, sutModel: provider === 'codex' ? LEARNING_MODEL_SPEC : 'claude-sonnet-4-6',
      workspaceMode: 'isolated' as const, transport: 'in-process' as const,
      variant: { id: `candidate-${provider}`, configDelta: { catalogSource: 'shipping-seed',
        toolDefinitionTier: 'compact', fullDefinitionsAfterUse: true } },
      dispatchOverride: { override: async (name: string) => name.includes('tools:invoke') ? PASS_THROUGH :
        ({ content: [{ text: JSON.stringify(name.includes('find') ? { tools: [{ name: 'plans:get' }] } : { ok: true }) }] }) } };
    const session = await target.open(options);
    const input = { trigger: 'user_message' as const, messages: [{ role: 'user' as const, content: 'Read and report.' }] };
    const first = await session.send(input);
    expect(first.finishReason, first.error).toBe('done');
    expect(requests).toHaveLength(4);
    const definition = (request: number, name: string) => requests[request].tools.find(tool => tool.name === name)!;
    const schema = (tool: Record<string, unknown>) => tool[provider === 'codex' ? 'parameters' : 'input_schema'];
    const docs = fixture.entries.find(entry => entry.name === 'docs:get')!;
    expect(schema(definition(0, 'docs__get'))).toEqual(compactInputSchema(docs.input));
    expect(definition(0, 'docs__get').description).toBe(summaryGuidanceDescription(docs.description));
    expect(definition(1, 'docs__get')).toEqual(definition(0, 'docs__get')); // discovery is not use
    expect(schema(definition(2, 'docs__get'))).toEqual(docs.input);
    expect(definition(2, 'docs__get').description).toBe(docs.description);
    const nested = fixture.entries.find(entry => entry.name === 'work_items:list')!;
    expect(schema(definition(2, 'work_items__list'))).toEqual(compactInputSchema(nested.input));
    expect(schema(definition(3, 'work_items__list'))).toEqual(nested.input);
    expect(definition(3, 'work_items__list').description).toBe(nested.description);
    expect(definition(3, 'plans__get')).toEqual(definition(0, 'plans__get'));
    const manifests = first.rawSseTape.filter(event => event.name === 'tool_definition_manifest');
    expect(manifests).toHaveLength(requests.length);
    for (const [index, event] of manifests.entries()) {
      const manifest = event.data as { definitions: unknown; sha256: string; bytes: number; usedCanonicalNames: string[] };
      expect(manifest.definitions).toEqual(requests[index].tools);
      const serialized = JSON.stringify(manifest.definitions);
      expect(manifest.sha256).toBe(createHash('sha256').update(serialized).digest('hex'));
      expect(manifest.bytes).toBe(Buffer.byteLength(serialized));
      if (index === 3) expect(manifest.usedCanonicalNames).toEqual(expect.arrayContaining(['docs:get', 'work_items:list']));
    }
    expect((await session.send(input)).finishReason).toBe('done');
    expect(definition(4, 'docs__get')).toEqual(definition(3, 'docs__get'));
    const fresh = await target.open({ ...options, runId: `fresh-${provider}` });
    expect((await fresh.send(input)).finishReason).toBe('done');
    expect(definition(5, 'docs__get')).toEqual(definition(0, 'docs__get'));
    await session.close(); await fresh.close();
  });

  it.each(['full', 'compact'] as const)('leaves the historical static %s configuration unchanged', async tier => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-only-key');
    const requests: Array<{ tools: unknown[] }> = [];
    const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return response(requests.length === 1 ? [{ type: 'function_call', id: 'fc', call_id: 'call',
        name: 'docs__get', arguments: '{}' }] : [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }] }]);
    });
    const session = await new SuTarget({ loadSystemPrompt: () => 'Read.', codexFetch: send as typeof fetch }).open({
      runId: `historical-${tier}`, sutModel: LEARNING_MODEL_SPEC, workspaceMode: 'isolated', transport: 'in-process',
      variant: { id: `static-${tier}`, configDelta: { catalogSource: 'shipping-seed', toolDefinitionTier: tier } },
      dispatchOverride: { override: async () => ({ content: [{ text: '{"ok":true}' }] }) },
    });
    expect((await session.send({ trigger: 'user_message', messages: [{ role: 'user', content: 'Read.' }] })).finishReason).toBe('done');
    expect(requests).toHaveLength(2);
    expect(requests[1].tools).toEqual(requests[0].tools);
    await session.close();
  });
});
