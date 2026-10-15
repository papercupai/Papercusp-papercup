/**
 * Integration tests for Phase 4 T3.2 — plugin events from JSON
 * manifests, end-to-end through registerPluginTools.
 *
 * Covers:
 *   - A plugin declaring valid JSON-Schema events lands in the
 *     projected registry with the right wire kinds.
 *   - The same tool surfaces its events block in MCP tools/list.
 *   - A plugin declaring an unsupported keyword fails registration
 *     with a clear error (no silent drop).
 *   - A plugin declaring a reserved name (chunk/done/etc) fails
 *     registration.
 *   - A plugin can mix multiple wire kinds in one tool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _resetProjectionRegistryForTests,
  lookupByMcpName,
  listMcpProjections,
} from '@papercusp/agent-mcp';
import { registerPluginTools } from './index.ts';
import type { LoadedPlugin } from './index.ts';

function makeLoadedPlugin(opts: {
  name: string;
  toolName: string;
  events?: Record<string, Record<string, unknown>>;
}): LoadedPlugin {
  const handler = async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => ({
    content: [{ type: 'text', text: 'ok' }],
  });
  return {
    path: '/tmp/never',
    source: 'project',
    plugin: {
      name: opts.name,
      version: '0.1.0',
      papercusp: '^0.1.0',
      capabilities: [],
      tools: { [opts.toolName]: handler },
    } as never,
    toolDefinitions: [
      {
        name: opts.toolName,
        description: `${opts.toolName} test tool`,
        capabilities: [],
        inputSchema: { type: 'object' },
        ...(opts.events ? { events: opts.events } : {}),
      } as never,
    ],
  };
}

beforeEach(() => {
  _resetProjectionRegistryForTests();
});
afterEach(() => {
  _resetProjectionRegistryForTests();
});

describe('plugin events from JSON manifests (T3.2)', () => {
  it('registers a plugin tool with declared events; wire kinds computed correctly', async () => {
    const lp = makeLoadedPlugin({
      name: 'demo-plugin',
      toolName: 'stream',
      events: {
        delta: { type: 'string' },
        tool_call: { type: 'object', properties: { name: { type: 'string' } } },
        chunk_payload: { type: 'string', contentEncoding: 'base64' },
      },
    });
    const result = await registerPluginTools([lp]);
    expect(result.errors).toEqual([]);
    expect(result.registered).toBe(1);

    const tool = lookupByMcpName('demo-plugin.stream');
    expect(tool).toBeDefined();
    expect(tool!.eventsJsonSchema).toEqual({
      delta: { type: 'string' },
      tool_call: { type: 'object', properties: { name: { type: 'string' } } },
      chunk_payload: { type: 'string', contentEncoding: 'base64' },
    });
    expect(tool!.eventWireKinds).toEqual({
      delta: 'string',
      tool_call: 'json',
      chunk_payload: 'binary',
    });
  });

  it('surfaces plugin events in MCP tools/list discoverability', async () => {
    const lp = makeLoadedPlugin({
      name: 'demo-plugin',
      toolName: 'stream',
      events: { delta: { type: 'string' } },
    });
    await registerPluginTools([lp]);

    const listings = listMcpProjections();
    const stream = listings.find((t) => t.name === 'demo-plugin.stream');
    expect(stream).toBeDefined();
    expect(stream!.events).toEqual({ delta: { type: 'string' } });
  });

  it('rejects unsupported JSON-Schema keywords with a clear error', async () => {
    const lp = makeLoadedPlugin({
      name: 'demo-plugin',
      toolName: 'bad-format',
      events: { delta: { type: 'string', format: 'date-time' } },
    });
    const result = await registerPluginTools([lp]);
    expect(result.registered).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].plugin).toBe('demo-plugin');
    expect(result.errors[0].tool).toBe('bad-format');
    expect(result.errors[0].error).toMatch(/events validation failed.*format/);
  });

  it('rejects reserved event names (chunk/done/heartbeat/result)', async () => {
    for (const reserved of ['done', 'heartbeat', 'result', 'chunk']) {
      _resetProjectionRegistryForTests();
      const lp = makeLoadedPlugin({
        name: `plugin-${reserved}`,
        toolName: 'bad-reserved',
        events: { [reserved]: { type: 'string' } },
      });
      const result = await registerPluginTools([lp]);
      expect(result.registered).toBe(0);
      expect(result.errors[0].error).toMatch(/reserved event name/);
      // chunk error message should point at largeOutput
      if (reserved === 'chunk') {
        expect(result.errors[0].error).toMatch(/largeOutput/);
      }
    }
  });

  it('accepts non-reserved progress + error (D2/D3 carve-out)', async () => {
    const lp = makeLoadedPlugin({
      name: 'demo-plugin',
      toolName: 'stream',
      events: {
        progress: { type: 'object', properties: { percent: { type: 'number' } } },
        error: { type: 'object', properties: { message: { type: 'string' } } },
      },
    });
    const result = await registerPluginTools([lp]);
    expect(result.errors).toEqual([]);
    expect(result.registered).toBe(1);
  });

  it('one bad tool does not block sibling tools in the same plugin', async () => {
    const handler = async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => ({
      content: [{ type: 'text', text: 'ok' }],
    });
    const lp: LoadedPlugin = {
      path: '/tmp/never',
      source: 'project',
      plugin: {
        name: 'demo-plugin',
        version: '0.1.0',
        papercusp: '^0.1.0',
        capabilities: [],
        tools: { good: handler, bad: handler },
      } as never,
      toolDefinitions: [
        {
          name: 'good',
          description: 'fine tool',
          capabilities: [],
          inputSchema: { type: 'object' },
          events: { delta: { type: 'string' } },
        } as never,
        {
          name: 'bad',
          description: 'broken tool',
          capabilities: [],
          inputSchema: { type: 'object' },
          events: { delta: { type: 'string', format: 'date-time' } },
        } as never,
      ],
    };
    const result = await registerPluginTools([lp]);
    expect(result.registered).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].tool).toBe('bad');
    expect(lookupByMcpName('demo-plugin.good')).toBeDefined();
    expect(lookupByMcpName('demo-plugin.bad')).toBeUndefined();
  });

  it('plugin tools without events still register cleanly (back-compat)', async () => {
    const lp = makeLoadedPlugin({ name: 'demo-plugin', toolName: 'simple' });
    const result = await registerPluginTools([lp]);
    expect(result.errors).toEqual([]);
    expect(result.registered).toBe(1);
    const tool = lookupByMcpName('demo-plugin.simple');
    expect(tool).toBeDefined();
    expect(tool!.eventsJsonSchema).toBeUndefined();
    expect(tool!.eventWireKinds).toBeUndefined();
  });
});
