/**
 * Loader validation for kind='pack' code-tool packs
 * (tool-distribution-granularity-2026-06-05 D-001/D-004).
 *
 * Asserts: the shipped reference pack (example-tool-pack) loads cleanly; a
 * pack declaring any runtime-bearing surface (ui / roles / routines / actions
 * / hooks / non-js runtime / getDynamicTools) is rejected; a pack with zero
 * tools is rejected; and a plain plugin with the same surfaces still loads
 * (the purity rule is pack-only).
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginFromDir, type LoadedPlugin } from './index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/plugin-loader/src → repo root is three levels up.
const REPO_ROOT = resolve(__dirname, '../../..');
const REFERENCE_PACK = resolve(REPO_ROOT, 'libs/papercusp/plugins/example-tool-pack');

const ROOT = join(tmpdir(), `papercusp-pack-test-${process.pid}`);

interface SynthOpts {
  kind?: string;
  capabilities?: string[];
  tools?: Array<{ name: string; capabilities?: string[] }>;
  manifestExtra?: Record<string, unknown>;
  entryExtra?: string;
}

let seq = 0;
async function makeUnit(opts: SynthOpts): Promise<string> {
  const name = `synth-pack-${seq++}`;
  const dir = join(ROOT, name);
  await fs.mkdir(dir, { recursive: true });
  const capabilities = opts.capabilities ?? [];
  const tools = opts.tools ?? [{ name: 'noop' }];
  const manifest = {
    name,
    version: '0.1.0',
    papercusp: '^0.1.0',
    ...(opts.kind ? { kind: opts.kind } : {}),
    capabilities,
    tools,
    ...(opts.manifestExtra ?? {}),
  };
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest), 'utf8');
  const handlers = tools.map((t) => `${JSON.stringify(t.name)}: async () => ({ content: [] })`).join(', ');
  const entry =
    `module.exports = { name: ${JSON.stringify(name)}, version: '0.1.0', papercusp: '^0.1.0', ` +
    `${opts.kind ? `kind: ${JSON.stringify(opts.kind)}, ` : ''}` +
    `capabilities: ${JSON.stringify(capabilities)}, tools: { ${handlers} }${opts.entryExtra ? `, ${opts.entryExtra}` : ''} };`;
  await fs.writeFile(join(dir, 'index.cjs'), entry, 'utf8');
  return dir;
}

function expectError(r: Awaited<ReturnType<typeof loadPluginFromDir>>, pattern: RegExp) {
  assert('error' in r, `expected a load error matching ${pattern}, got a clean load`);
  assert.match((r as { error: string }).error, pattern);
}

function expectClean(r: Awaited<ReturnType<typeof loadPluginFromDir>>): LoadedPlugin {
  assert(!('error' in r), `expected clean load, got: ${(r as { error?: string }).error}`);
  assert(!('skipped' in r), 'expected clean load, got skipped');
  return r as LoadedPlugin;
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('pack manifest validation (kind=pack)', () => {
  it('loads the shipped reference pack (example-tool-pack) cleanly', async () => {
    const lp = expectClean(await loadPluginFromDir(REFERENCE_PACK, 'global'));
    assert.equal((lp.plugin as { kind?: string }).kind, 'pack');
    assert.equal(lp.toolDefinitions?.length, 2);
    assert.deepEqual(
      (lp.toolDefinitions ?? []).map((t) => t.name).sort(),
      ['slugify', 'word_count'],
    );
    assert.equal(lp.runtime?.kind, 'js');
  });

  it('accepts a synthetic tools-only pack', async () => {
    const dir = await makeUnit({ kind: 'pack', tools: [{ name: 'alpha' }, { name: 'beta' }] });
    const lp = expectClean(await loadPluginFromDir(dir, 'global'));
    assert.equal(lp.toolDefinitions?.length, 2);
  });

  it('rejects a pack declaring a ui contribution', async () => {
    const dir = await makeUnit({
      kind: 'pack',
      capabilities: ['ui:tui-pane'],
      manifestExtra: { ui: [{ type: 'tui-pane', slug: 'x', label: 'X', command: ['sh', 'x.sh'] }] },
      entryExtra: `ui: [{ type: 'tui-pane', slug: 'x', label: 'X', command: ['sh', 'x.sh'] }]`,
    });
    expectError(await loadPluginFromDir(dir, 'global'), /pack .* runtime-bearing surface.*ui/);
  });

  it('rejects a pack with roles / routines / actions / hooks', async () => {
    const roleDir = await makeUnit({
      kind: 'pack',
      capabilities: ['roles:register:helper'],
      entryExtra: `roles: { helper: { description: 'x' } }`,
    });
    expectError(await loadPluginFromDir(roleDir, 'global'), /runtime-bearing surface.*roles/);

    const hooksDir = await makeUnit({ kind: 'pack', entryExtra: `hooks: { onLoad: async () => {} }` });
    expectError(await loadPluginFromDir(hooksDir, 'global'), /runtime-bearing surface.*hooks/);

    const actionsDir = await makeUnit({
      kind: 'pack',
      entryExtra: `actions: [{ name: 'do-it' }]`,
    });
    expectError(await loadPluginFromDir(actionsDir, 'global'), /runtime-bearing surface.*actions/);
  });

  it('rejects a pack with a non-js runtime', async () => {
    const dir = await makeUnit({
      kind: 'pack',
      manifestExtra: { runtime: { kind: 'daemon', daemonCommand: ['sleep', '1'] } },
    });
    expectError(await loadPluginFromDir(dir, 'global'), /runtime-less|runtime\.kind/);
  });

  it('rejects a pack implementing getDynamicTools', async () => {
    const dir = await makeUnit({
      kind: 'pack',
      tools: [],
      entryExtra: `getDynamicTools: async () => ({ definitions: [], handlers: {} })`,
    });
    expectError(await loadPluginFromDir(dir, 'global'), /getDynamicTools/);
  });

  it('rejects a pack with zero tools', async () => {
    const dir = await makeUnit({ kind: 'pack', tools: [] });
    expectError(await loadPluginFromDir(dir, 'global'), /declares no tools/);
  });

  it('accepts a pack declaring provides.events + dependencies.events (pure data, no runtime)', async () => {
    // events-as-a-dependency axis (D-003 / P-005): a runtime-less pack MAY
    // declare what event families it provides/requires — they are data, not a
    // runtime-bearing surface, so pack purity allows them.
    const dir = await makeUnit({
      kind: 'pack',
      tools: [{ name: 'alpha' }],
      manifestExtra: {
        provides: {
          events: [
            {
              family: 'alpha-done',
              keyTemplate: 'alpha:done:<id>',
              params: [{ name: 'id', required: true, describe: 'the id' }],
            },
          ],
        },
        dependencies: { events: [{ family: 'upstream-thing', optional: true }] },
      },
    });
    const lp = expectClean(await loadPluginFromDir(dir, 'global'));
    assert.equal(lp.toolDefinitions?.length, 1);
  });

  it('rejects a pack declaring reactions (event REACTIONS are plugin runtime)', async () => {
    // The reaction carries its events:listen cap so it clears reaction-capability
    // validation and reaches the pack-purity check — which rejects `reactions`
    // as a runtime-bearing surface (a pack contributes tools only).
    const dir = await makeUnit({
      kind: 'pack',
      capabilities: ['events:listen:alpha:done'],
      manifestExtra: { reactions: [{ id: 'r1', on: 'alpha:done', fire: 'alpha.noop' }] },
    });
    expectError(await loadPluginFromDir(dir, 'global'), /runtime-bearing surface.*reactions/);
  });

  it('rejects a pack whose provides.events keyTemplate placeholder has no matching param', async () => {
    // The semantic validator (validateManifestEventDeclarations) runs at load
    // for every manifest — a mis-declared family is a hard load failure.
    const dir = await makeUnit({
      kind: 'pack',
      manifestExtra: { provides: { events: [{ family: 'alpha-done', keyTemplate: 'alpha:done:<id>' }] } },
    });
    expectError(await loadPluginFromDir(dir, 'global'), /placeholder "<id>" has no matching params/);
  });

  it('a plain plugin (kind omitted) with the same runtime surfaces still loads', async () => {
    const dir = await makeUnit({
      capabilities: ['ui:tui-pane'],
      manifestExtra: { ui: [{ type: 'tui-pane', slug: 'x', label: 'X', command: ['sh', 'x.sh'] }] },
      entryExtra: `ui: [{ type: 'tui-pane', slug: 'x', label: 'X', command: ['sh', 'x.sh'] }]`,
    });
    expectClean(await loadPluginFromDir(dir, 'global'));
  });
});
