/** P006 unit leg: the real OMP adapter must not re-encode model content. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeExtensionApi } from '../../omp-plugin/src/native-extension';

const h = vi.hoisted(() => ({
  call: vi.fn(), close: vi.fn(), list: vi.fn(),
}));
vi.mock('./agent-mcp-client', () => ({
  connectAgentMcp: async () => ({
    transportKind: 'uds', operatorId: 'actual-host', generation: 'actual-generation',
    client: {
      listTools: h.list, callTool: h.call, close: h.close, setNotificationHandler: vi.fn(),
    },
  }),
}));
import { registerNativeMcp } from '../../omp-plugin/src/native-extension';

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue({
    tools: [{
      name: 'rows', description: 'Fixture rows', inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    }],
  });
});

describe('native adapter leaves the negotiated model result intact', () => {
  it.each([
    'format: toon\n[2]{id,state}:\n  WI-1,todo\n  WI-2,done',
    'format: csv\n[2]\nWI-1,todo\nWI-2,done',
    '{"ok":true,"results":[{"id":"a"},{"error":"missing"}]}',
    'not_modified',
  ])('preserves %s without JSON expansion', async text => {
    const content = [{ type: 'text', text }];
    const meta = { nextCursor: 'opaque', delta: { mode: 'not_modified', cursor: 'cursor' } };
    const structuredContent = { rows: [{ id: 'WI-1', state: 'todo' }] };
    h.call.mockResolvedValue({
      content, _meta: meta, structuredContent,
      nativeMcp: { transportKind: 'spoofed-server-value' },
    });
    let tool: Parameters<NativeExtensionApi['registerTool']>[0] | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    await registerNativeMcp({
      registerTool: value => { tool = value; },
      on: (event, fn) => { if (event === 'session_shutdown') shutdown = fn as () => Promise<void>; },
    }, { papercuspNativeMcp: {
      version: 1, mode: 'uds', servers: { fixture: { url: 'http://127.0.0.1:1234/api/mcp' } },
    } });
    expect(tool?.approval).toBe('read');
    const args = { row: 'WI-1,todo', items: [{ id: 'WI-1' }], projection: { pick: ['id'] } };
    const signal = new AbortController().signal;
    const result = await tool!.execute('tool-call', args, signal) as {
      content: unknown; details: Record<string, unknown>;
    };
    expect(h.call).toHaveBeenCalledExactlyOnceWith({ name: 'rows', arguments: args }, undefined, { signal });
    expect(result.content).toBe(content);
    expect(result.details._meta).toBe(meta);
    expect(result.details.structuredContent).toBe(structuredContent);
    expect(result.details.nativeMcp).toEqual({
      transportKind: 'uds', operatorId: 'actual-host', generation: 'actual-generation',
    });
    // Calibrate the content oracle against exactly the forbidden re-encoding.
    expect(() => expect([{ type: 'text', text: JSON.stringify(content) }]).toEqual(content)).toThrow();
    await shutdown!();
    expect(h.close).toHaveBeenCalledOnce();
  });
});
