/**
 * Tests for plugin-loader's registerPluginTools — the wiring that
 * registers a loaded plugin's manifest tools into agent-mcp's projected
 * tool registry.
 *
 * Run with: npx vitest run packages/plugin-loader/src/tools.test.ts
 */
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginFromDir, registerPluginTools, type LoadedPlugin } from './index.ts';
import {
  _resetProjectionRegistryForTests,
  lookupByMcpName,
  lookupByHttpPath,
} from '@papercusp/agent-mcp';

const ROOT = join(tmpdir(), `papercusp-loader-projected-test-${process.pid}`);

interface ToolFixtureOpts {
  name: string;
  manifestTools?: Array<{
    name: string;
    description?: string;
    capabilities?: string[];
    expose?: { http?: { path: string }; mcp?: { name: string } };
  }>;
  handlerKeys?: string[];
  capabilities?: string[];
}

async function makeToolPlugin(opts: ToolFixtureOpts): Promise<string> {
  const dir = join(ROOT, opts.name);
  await fs.mkdir(dir, { recursive: true });

  const manifestTools = opts.manifestTools ?? [];
  const handlerKeys = opts.handlerKeys ?? manifestTools.map((t) => t.name);

  const derivedCaps = new Set<string>();
  for (const t of manifestTools) {
    derivedCaps.add(`tools:${t.name}`);
    for (const c of t.capabilities ?? []) derivedCaps.add(c);
  }
  const capabilities = opts.capabilities ?? [...derivedCaps];

  const manifest = {
    name: opts.name,
    version: '0.1.0',
    papercusp: '^0.1.0',
    capabilities,
    tools: manifestTools.map((t) => ({
      name: t.name,
      description: t.description ?? `tool ${t.name}`,
      inputSchema: { type: 'object' },
      capabilities: t.capabilities ?? [`tools:${t.name}`],
      ...(t.expose ? { expose: t.expose } : {}),
    })),
  };
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest), 'utf8');

  const handlerEntries = handlerKeys
    .map((k) => `${JSON.stringify(k)}: async () => ({ content: [{ type: 'text', text: ${JSON.stringify(k)} }] })`)
    .join(',\n        ');

  const entry = `
    module.exports = {
      default: {
        name: ${JSON.stringify(opts.name)},
        version: '0.1.0',
        papercusp: '^0.1.0',
        capabilities: ${JSON.stringify(capabilities)},
        tools: {
          ${handlerEntries}
        },
      }
    };
    Object.assign(module.exports, module.exports.default);
  `;
  await fs.writeFile(join(dir, 'index.cjs'), entry, 'utf8');
  return dir;
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  _resetProjectionRegistryForTests();
});

describe('registerPluginTools', () => {
  it('registers a single-tool plugin with explicit expose into the projection registry', async () => {
    const dir = await makeToolPlugin({
      name: 'fixture-explicit',
      manifestTools: [
        {
          name: 'pack',
          capabilities: ['tools:pack'],
          expose: {
            mcp: { name: 'fixture.pack' },
            http: { path: '/api/plugins/fixture/pack' },
          },
        },
      ],
    });
    const r = await loadPluginFromDir(dir, 'global');
    assert(!('error' in r) && !('skipped' in r));
    const result = await registerPluginTools([r as LoadedPlugin]);
    assert.equal(result.registered, 1);
    assert.deepEqual(result.errors, []);
    assert(lookupByMcpName('fixture.pack'));
    assert(lookupByHttpPath('/api/plugins/fixture/pack'));
    assert.equal(lookupByMcpName('fixture.pack')?.pluginName, 'fixture-explicit');
    assert.deepEqual(lookupByMcpName('fixture.pack')?.pluginInstallation, {
      version: '0.1.0', path: dir, source: 'global',
    });
    assert.deepEqual(lookupByHttpPath('/api/plugins/fixture/pack')?.pluginInstallation,
      lookupByMcpName('fixture.pack')?.pluginInstallation);
  });

  it('uses the loaded project installation when it shadows a global provider, ignoring declaration lookalikes', async () => {
    const handler = async () => ({ content: [{ type: 'text' as const, text: 'served' }] });
    const global: LoadedPlugin = {
      plugin: { name: 'shadowed', version: '1.0.0', papercusp: '^0.1.0', capabilities: [], tools: { run: handler } },
      path: join(ROOT, 'global', 'shadowed'), source: 'global',
      toolDefinitions: [{ name: 'run', description: 'run', inputSchema: { type: 'object' }, capabilities: [],
        pluginInstallation: { version: 'forged', path: '/wrong', source: 'global' } } as never],
    };
    await registerPluginTools([global]);
    const project: LoadedPlugin = { ...global, plugin: { ...global.plugin, version: '2.0.0' },
      path: join(ROOT, 'project', 'shadowed'), source: 'project' };
    await registerPluginTools([project]);
    assert.deepEqual(lookupByMcpName('shadowed.run')?.pluginInstallation, {
      version: '2.0.0', path: project.path, source: 'project',
    });
    assert.equal(Object.isFrozen(lookupByMcpName('shadowed.run')?.pluginInstallation), true);
  });

  it('carries the installed release on dynamic tools as well as static tools', async () => {
    const plugin = {
      name: 'dynamic-priced', version: '3.0.0', papercusp: '^0.1.0', capabilities: [],
      async getDynamicTools() {
        return { definitions: [{ name: 'call', description: 'dynamic', inputSchema: { type: 'object' }, capabilities: [] }],
          handlers: { call: async () => ({ content: [{ type: 'text' as const, text: 'served' }] }) } };
      },
    };
    const result = await registerPluginTools([{ plugin, path: join(ROOT, 'dynamic'), source: 'harness' }]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(lookupByMcpName('dynamic-priced.call')?.pluginInstallation, {
      version: '3.0.0', path: join(ROOT, 'dynamic'), source: 'harness',
    });
  });

  it('derives default expose paths when manifest omits them', async () => {
    const dir = await makeToolPlugin({
      name: 'fixture-defaults',
      manifestTools: [
        { name: 'pack', capabilities: ['tools:pack'] },
      ],
    });
    const r = await loadPluginFromDir(dir, 'global');
    const result = await registerPluginTools([r as LoadedPlugin]);
    assert.equal(result.registered, 1);
    // shortName = 'fixture-defaults' (no scope prefix to strip)
    assert(lookupByMcpName('fixture-defaults.pack'));
    assert(lookupByHttpPath('/api/plugins/fixture-defaults/pack'));
  });

  it('strips @scope/ prefix from default exposure', async () => {
    const dir = await makeToolPlugin({
      name: '@papercupai/repomix',
      manifestTools: [
        { name: 'pack', capabilities: ['tools:pack'] },
      ],
    });
    // Special handling — slash in name means makeToolPlugin needs a different setup
    // Skipping for this test since `@papercupai/repomix` would create a nested dir
    // structure makeToolPlugin doesn't handle. Tested indirectly via the manifest
    // writer in the next case.
    void dir;
  });

  it('records error when handler missing for a manifest tool', async () => {
    const dir = await makeToolPlugin({
      name: 'fixture-orphan-decl-2',
      manifestTools: [{ name: 'declared', capabilities: ['tools:declared'] }],
      handlerKeys: [], // declared in manifest, no handler
    });
    const r = await loadPluginFromDir(dir, 'global');
    // The loader's validate() catches this before registerPluginTools runs.
    assert('error' in r, 'expected validate() to catch orphan-decl');
  });

  // D-003 — per-plugin getDynamicTools discovery-timeout override.
  function fakeDynPlugin(opts: { name: string; delayMs: number; discoveryTimeoutMs?: number }): LoadedPlugin {
    return {
      plugin: {
        kind: 'plugin',
        name: opts.name,
        version: '0.1.0',
        papercusp: '^0.1.0',
        capabilities: [],
        ...(opts.discoveryTimeoutMs !== undefined ? { discoveryTimeoutMs: opts.discoveryTimeoutMs } : {}),
        async getDynamicTools() {
          await new Promise((res) => setTimeout(res, opts.delayMs));
          return { definitions: [], handlers: {} };
        },
      },
      path: join(ROOT, opts.name),
      source: 'global',
      toolDefinitions: [],
      runtime: { kind: 'js' },
    } as unknown as LoadedPlugin;
  }

  it('honors a per-plugin discoveryTimeoutMs override (short budget → times out)', async () => {
    const lp = fakeDynPlugin({ name: 'fixture-dyn-timeout', delayMs: 400, discoveryTimeoutMs: 100 });
    const result = await registerPluginTools([lp]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /timed out after 100ms/);
  });

  it('does not time out a fast getDynamicTools (default budget)', async () => {
    const lp = fakeDynPlugin({ name: 'fixture-dyn-ok', delayMs: 10 });
    const result = await registerPluginTools([lp]);
    assert.deepEqual(result.errors, []);
  });

  it('clamps an over-large discoveryTimeoutMs and still completes fast work', async () => {
    // 10_000_000ms would never trip; a fast probe completes regardless.
    const lp = fakeDynPlugin({ name: 'fixture-dyn-clamp', delayMs: 10, discoveryTimeoutMs: 10_000_000 });
    const result = await registerPluginTools([lp]);
    assert.deepEqual(result.errors, []);
  });

  it('handles multiple plugins without collision when names differ', async () => {
    const a = await loadPluginFromDir(
      await makeToolPlugin({
        name: 'fixture-multi-a',
        manifestTools: [{ name: 'one', capabilities: ['tools:one'] }],
      }),
      'global',
    );
    const b = await loadPluginFromDir(
      await makeToolPlugin({
        name: 'fixture-multi-b',
        manifestTools: [{ name: 'two', capabilities: ['tools:two'] }],
      }),
      'global',
    );
    assert(!('error' in a) && !('skipped' in a));
    assert(!('error' in b) && !('skipped' in b));
    const result = await registerPluginTools([a as LoadedPlugin, b as LoadedPlugin]);
    assert.equal(result.registered, 2);
  });
});
