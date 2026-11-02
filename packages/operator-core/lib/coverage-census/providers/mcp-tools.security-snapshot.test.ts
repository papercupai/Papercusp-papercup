import { expect, it, vi } from 'vitest';
import { listAllProjectedTools, registerProjectedTool, unregisterProjectedToolsForPlugin } from '@papercusp/tooldef';
import { enumerateProjectedHandlerSurfaces } from './mcp-tools';

// Restoring the former eager import must fail even if other provider tests
// happened to initialize the catalog before their snapshot assertion.
vi.mock('../../agent-tools/index', () => { throw Error('snapshot-imported-tool-barrel'); });

it('reads only registered handlers without importing their barrel or executing them', async () => {
  const pluginName = 'security-snapshot-no-load-fixture', handler = vi.fn(async () => ({ content: [] }));
  registerProjectedTool({ pluginName, description: 'snapshot fixture', capabilities: [],
    inputSchema: { type: 'object' }, expose: { http: { path: '/__security_snapshot_no_load', method: 'GET' } }, fn: handler });
  try {
    const before = listAllProjectedTools().length;
    const captured = await enumerateProjectedHandlerSurfaces({ workspaceId: 'test', harnessSlug: 'test',
      repoRoot: process.cwd(), config: {} });
    expect(captured).toHaveLength(before);
    expect(listAllProjectedTools()).toHaveLength(before);
    expect(handler).not.toHaveBeenCalled();
    expect(captured.find(row => row.surfaceId === 'http:/__security_snapshot_no_load')?.attrs).toMatchObject({
      loadedFunctionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), actualEffectCoverage: 'unknown',
    });
  } finally { unregisterProjectedToolsForPlugin(pluginName); }
});
