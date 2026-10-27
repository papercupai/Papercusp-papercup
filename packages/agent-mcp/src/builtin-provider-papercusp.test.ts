import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  builtinToolProvider, defineTool, listAllProjectedTools, listMcpProjections,
  projectedToolProviderVersion, setBuiltinToolProvider, unregisterProjectedToolsForPlugin,
} from '@papercusp/tooldef';
import packageMetadata from '../package.json' with { type: 'json' };
import './builtin-provider-papercusp';

const loadedProvider = builtinToolProvider();
afterEach(() => {
  unregisterProjectedToolsForPlugin('agent-mcp');
  setBuiltinToolProvider(loadedProvider);
});

describe('loaded builtin provider metadata', () => {
  it.each([false, true])('binds the loaded package to the defineTool principal variant %s', (requirePrincipal) => {
    const name = `provider-fixture:loaded-${requirePrincipal}`;
    const definition = {
      name, capability: 'test:read', args: z.object({}),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    };
    if (requirePrincipal) defineTool(definition);
    else defineTool({ ...definition, requirePrincipal: false });
    const tool = listAllProjectedTools().find(tool => tool.expose.mcp?.name === name)!;
    expect(tool.builtinProvider).toEqual({
      pluginName: 'agent-mcp', packageName: packageMetadata.name, version: packageMetadata.version,
    });
    expect(tool.pluginInstallation).toBeUndefined();
    expect(projectedToolProviderVersion(tool)).toBe(packageMetadata.version);
    expect(listMcpProjections().find(tool => tool.name === name)?._meta?.['papercusp/provider']).toEqual({
      pluginName: 'agent-mcp', packageName: packageMetadata.name, version: packageMetadata.version, kind: 'builtin',
    });
    setBuiltinToolProvider({ pluginName: 'agent-mcp', packageName: packageMetadata.name, version: '99.0.0' });
    expect(projectedToolProviderVersion(tool)).toBe(packageMetadata.version);
    expect(Object.isFrozen(tool.builtinProvider)).toBe(true);
  });

  it('refuses missing, mixed and foreign metadata and preserves actual installed-plugin versions', () => {
    const builtinProvider = loadedProvider!;
    const tool = { pluginName: 'agent-mcp', builtinProvider };
    expect(projectedToolProviderVersion({ pluginName: 'agent-mcp' })).toBeNull();
    expect(projectedToolProviderVersion({ ...tool, pluginName: 'foreign' })).toBeNull();
    const pluginInstallation = { version: '3.2.1', path: '/fixture/plugin', source: 'global' as const };
    expect(projectedToolProviderVersion({ ...tool, pluginInstallation })).toBeNull();
    expect(projectedToolProviderVersion({ pluginName: 'plugin', pluginInstallation })).toBe('3.2.1');
    expect(() => setBuiltinToolProvider({ ...builtinProvider, version: '' })).toThrow(/loaded package identity and version/);
  });
});
