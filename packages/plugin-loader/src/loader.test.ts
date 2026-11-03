/**
 * Tests for the plugin loader. Run with:
 *   cd packages/papercusp-plugin-loader && npx tsx --test src/loader.test.ts
 */
import { describe, it, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginFromDir, loadPlugins } from './index.ts';

const ROOT = join(tmpdir(), `papercusp-loader-test-${process.pid}`);

async function makePlugin(opts: {
  name: string;
  version?: string;
  manifestVersion?: string;
  noManifest?: boolean;
  noEntry?: boolean;
  manifestVersionMismatch?: boolean;
}): Promise<string> {
  const dir = join(ROOT, opts.name);
  await fs.mkdir(dir, { recursive: true });
  const version = opts.version ?? '0.1.0';
  const manifestVersion = opts.manifestVersionMismatch ? '0.9.9' : (opts.manifestVersion ?? version);

  if (!opts.noManifest) {
    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: opts.name, version: manifestVersion }), 'utf8');
  }

  if (!opts.noEntry) {
    const entry = `
      export default {
        name: ${JSON.stringify(opts.name)},
        version: ${JSON.stringify(version)},
        papercusp: '^0.1.0',
        capabilities: [],
        hooks: {
          afterDone: async () => {},
        },
      };
    `;
    await fs.writeFile(join(dir, 'index.mjs'), entry, 'utf8');
  }
  return dir;
}

before(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
});

after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('loadPluginFromDir', () => {
  it('loads a valid plugin', async () => {
    const dir = await makePlugin({ name: 'happy-path' });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok(!('error' in r), `expected success, got ${JSON.stringify(r)}`);
    if ('plugin' in r) {
      assert.equal(r.plugin.name, 'happy-path');
      assert.equal(r.plugin.version, '0.1.0');
      assert.equal(r.source, 'project');
    }
  });

  it('rejects when manifest is missing', async () => {
    const dir = await makePlugin({ name: 'no-manifest', noManifest: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /papercusp\.json/);
    }
  });

  it('rejects when entry point is missing but the manifest declares tools', async () => {
    // Tool handlers live on the entry's `tools` export — a tools-declaring
    // manifest with no entry is a broken plugin, not a manifest-only one.
    const dir = join(ROOT, 'no-entry-with-tools');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'papercusp.json'),
      JSON.stringify({
        name: 'no-entry-with-tools',
        version: '0.1.0',
        tools: [{ name: 'pack', capabilities: ['tools:pack'] }],
      }),
      'utf8',
    );
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /entry point/);
    }
  });

  it('rejects a pack with no entry point (a pack exists to provide tool handlers)', async () => {
    const dir = join(ROOT, 'no-entry-pack');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'papercusp.json'),
      JSON.stringify({
        name: 'no-entry-pack',
        version: '0.1.0',
        kind: 'pack',
        tools: [{ name: 'pack', capabilities: ['tools:pack'] }],
      }),
      'utf8',
    );
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /entry point/);
    }
  });

  it('loads a manifest-only plugin (no entry, no tools — provision/roles/config only)', async () => {
    // The cloudflare-stack shape: a fully declarative plugin (provision
    // scripts, manifest-declared roles, configSchema) with no code at all.
    const dir = await makePlugin({ name: 'manifest-only', noEntry: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok(!('error' in r) && !('skipped' in r), `expected success, got ${JSON.stringify(r)}`);
    if ('plugin' in r) {
      assert.equal(r.plugin.name, 'manifest-only');
      assert.equal((r.plugin as unknown as { __runtime?: string }).__runtime, 'manifest-only');
      assert.deepEqual(r.toolDefinitions, []);
    }
  });

  it('loads a manifest-only trigger pack and preserves its discovery descriptor', async () => {
    const dir = join(ROOT, 'email-draft-responder');
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ];
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'plan.md'), `---
title: Email draft responder
slug: email-draft-responder
status: draft
---
# Email draft responder
## Phase 1 — Draft
- **P-001** \`todo\` Draft the reply.
`, 'utf8');
    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({
      name: 'email-draft-responder',
      version: '0.1.0',
      kind: 'plugin',
      capabilities: [],
      oauth: [{ provider: 'google', scopes, fieldName: 'googleWorkspace' }],
      configSchema: {
        type: 'object',
        properties: {
          googleWorkspace: {
            type: 'string',
            secret: true,
            shareable: false,
            snapshotPolicy: 'strip',
            oauth: { provider: 'google', scopes },
          },
        },
      },
      triggerPack: {
        inputs: { type: 'object', properties: {} },
        targets: [{
          id: 'draft-reply',
          kind: 'plan',
          path: 'plan.md',
          inputSchema: { type: 'object', properties: {} },
        }],
        bindings: [{
          id: 'gmail-to-draft',
          source: { kind: 'external', sourceKind: 'gmail', oauthField: 'googleWorkspace' },
          target: 'draft-reply',
          eventPattern: 'ext:gmail:message.received',
          mapping: { mode: 'payload-context' },
        }],
        edges: [],
      },
    }), 'utf8');

    const r = await loadPluginFromDir(dir, 'project');
    assert.ok(!('error' in r) && !('skipped' in r), `expected success, got ${JSON.stringify(r)}`);
    if ('plugin' in r) {
      assert.equal((r.plugin as unknown as { __runtime?: string }).__runtime, 'manifest-only');
      assert.deepEqual(r.triggerPack, {
        inputs: { type: 'object', properties: {} },
        targets: [{
          id: 'draft-reply',
          kind: 'plan',
          path: 'plan.md',
          inputSchema: { type: 'object', properties: {} },
        }],
        bindings: [{
          id: 'gmail-to-draft',
          source: { kind: 'external', sourceKind: 'gmail', oauthField: 'googleWorkspace' },
          target: 'draft-reply',
          eventPattern: 'ext:gmail:message.received',
          mapping: { mode: 'payload-context' },
        }],
        edges: [],
      });
      assert.deepEqual(r.plugin.triggerPack, r.triggerPack);
    }
  });

  it('rejects a trigger pack whose OAuth field is not snapshot-safe', async () => {
    const dir = join(ROOT, 'leaky-trigger-pack');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'plan.md'), '# plan', 'utf8');
    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({
      name: 'leaky-trigger-pack',
      version: '0.1.0',
      configSchema: { type: 'object', properties: { token: { type: 'string' } } },
      oauth: [{ provider: 'google', scopes: ['gmail.readonly'], fieldName: 'token' }],
      triggerPack: {
        inputs: { type: 'object', properties: {} },
        targets: [{
          id: 'draft-reply',
          kind: 'plan',
          path: 'plan.md',
          inputSchema: { type: 'object' },
        }],
        bindings: [{
          id: 'gmail-to-draft',
          source: { kind: 'external', sourceKind: 'gmail', oauthField: 'token' },
          target: 'draft-reply',
          eventPattern: 'ext:gmail:message.received',
          mapping: { mode: 'payload-context' },
        }],
        edges: [],
      },
    }), 'utf8');
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) assert.match(r.error, /secret must be true/);
  });

  it('rejects when manifest.version != plugin.version', async () => {
    const dir = await makePlugin({ name: 'version-mismatch', manifestVersionMismatch: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /version/);
    }
  });

  it('rejects when papercusp range excludes the runtime version', async () => {
    // Runtime is 0.1.0; ^99.0.0 is incompatible.
    const dir = join(ROOT, 'incompatible-runtime');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'papercusp.json'),
      JSON.stringify({ name: 'incompatible-runtime', version: '0.1.0' }),
      'utf8',
    );
    await fs.writeFile(
      join(dir, 'index.mjs'),
      `export default {
        name: 'incompatible-runtime',
        version: '0.1.0',
        papercusp: '^99.0.0',
        capabilities: [],
        hooks: {},
      };`,
      'utf8',
    );
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /papercusp runtime/);
    }
  });
});

describe('manifest/export declaration reconciliation', () => {
  async function writeReconciliationPlugin(
    name: string,
    manifestExtra: Record<string, unknown>,
    entryBody: string,
  ): Promise<string> {
    const dir = join(ROOT, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'papercusp.json'),
      JSON.stringify({ name, version: '0.1.0', papercusp: '^0.1.0', ...manifestExtra }),
      'utf8',
    );
    await fs.writeFile(join(dir, 'index.cjs'), entryBody, 'utf8');
    return dir;
  }

  function loadedPlugin(result: Awaited<ReturnType<typeof loadPluginFromDir>>): Record<string, unknown> {
    assert.ok(!('error' in result) && !('skipped' in result), `expected load, got ${JSON.stringify(result)}`);
    return result.plugin as unknown as Record<string, unknown>;
  }

  it('projects manifest-only capabilities, actions, and UI declarations onto the live plugin', async () => {
    const name = 'manifest-to-live-declarations';
    const dir = await writeReconciliationPlugin(
      name,
      {
        capabilities: ['ui:tui-pane', 'compute:exec:sh', 'ui:dashboard-tab', 'ui:sidebar-item'],
        actions: [{ name: 'declared-action', label: 'Declared action' }],
        ui: [{ type: 'tui-pane', slug: 'declared-pane', label: 'Declared pane', command: ['sh', 'render.sh'] }],
        dashboardTabs: [{ id: 'declared-tab', label: 'Declared tab', iframeUrl: '/tab' }],
        sidebarItems: [{ id: 'declared-nav', label: 'Declared nav', href: '/nav' }],
      },
      `module.exports = { name: ${JSON.stringify(name)}, version: '0.1.0', papercusp: '^0.1.0', capabilities: [] };`,
    );

    const plugin = loadedPlugin(await loadPluginFromDir(dir, 'project'));
    assert.deepEqual(plugin.capabilities, ['ui:tui-pane', 'compute:exec:sh', 'ui:dashboard-tab', 'ui:sidebar-item']);
    assert.deepEqual((plugin.actions as Array<{ name: string }>).map((entry) => entry.name), ['declared-action']);
    assert.deepEqual((plugin.ui as Array<{ slug: string }>).map((entry) => entry.slug), ['declared-pane']);
    assert.deepEqual((plugin.dashboardTabs as Array<{ id: string }>).map((entry) => entry.id), ['declared-tab']);
    assert.deepEqual((plugin.sidebarItems as Array<{ id: string }>).map((entry) => entry.id), ['declared-nav']);
  });

  it('drops export-only declarations while retaining runtime functions for manifest identities', async () => {
    const name = 'live-to-manifest-declarations';
    const dir = await writeReconciliationPlugin(
      name,
      {
        capabilities: ['ui:harness-route', 'ui:dashboard-tab', 'ui:sidebar-item'],
        actions: [{ name: 'declared-action', label: 'Manifest action' }],
        ui: [{ type: 'react', slug: 'declared-pane', label: 'Manifest pane' }],
        dashboardTabs: [{ id: 'declared-tab', label: 'Manifest tab' }],
        sidebarItems: [{ id: 'declared-nav', label: 'Manifest nav', href: '/manifest' }],
      },
      `
        const component = async () => ({ default: () => null });
        module.exports = {
          name: ${JSON.stringify(name)},
          version: '0.1.0',
          papercusp: '^0.1.0',
          capabilities: ['ui:harness-route', 'ui:dashboard-tab', 'ui:sidebar-item', 'export-only:permission'],
          actions: [
            { name: 'declared-action', label: 'Export action', handler: () => 'kept' },
            { name: 'export-only-action', handler: () => 'dropped' },
          ],
          ui: [
            { slug: 'declared-pane', label: 'Export pane', component },
            { slug: 'export-only-pane', label: 'Dropped pane', component },
          ],
          dashboardTabs: [
            { id: 'declared-tab', label: 'Export tab', component: () => null },
            { id: 'export-only-tab', label: 'Dropped tab', component: () => null },
          ],
          sidebarItems: [
            { id: 'declared-nav', label: 'Export nav', href: '/export', badge: async () => 1 },
            { id: 'export-only-nav', label: 'Dropped nav', href: '/dropped' },
          ],
        };
      `,
    );

    const plugin = loadedPlugin(await loadPluginFromDir(dir, 'project'));
    assert.deepEqual(plugin.capabilities, ['ui:harness-route', 'ui:dashboard-tab', 'ui:sidebar-item']);

    const actions = plugin.actions as Array<Record<string, unknown>>;
    assert.deepEqual(actions.map((entry) => entry.name), ['declared-action']);
    assert.equal(actions[0]!.label, 'Manifest action');
    assert.equal(typeof actions[0]!.handler, 'function');

    const ui = plugin.ui as Array<Record<string, unknown>>;
    assert.deepEqual(ui.map((entry) => entry.slug), ['declared-pane']);
    assert.equal(ui[0]!.label, 'Manifest pane');
    assert.equal(typeof ui[0]!.component, 'function');

    const tabs = plugin.dashboardTabs as Array<Record<string, unknown>>;
    assert.deepEqual(tabs.map((entry) => entry.id), ['declared-tab']);
    assert.equal(tabs[0]!.label, 'Manifest tab');
    assert.equal(typeof tabs[0]!.component, 'function');

    const sidebar = plugin.sidebarItems as Array<Record<string, unknown>>;
    assert.deepEqual(sidebar.map((entry) => entry.id), ['declared-nav']);
    assert.equal(sidebar[0]!.label, 'Manifest nav');
    assert.equal(sidebar[0]!.href, '/manifest');
    assert.equal(typeof sidebar[0]!.badge, 'function');
  });

  it('rejects a manifest-declared React surface with no same-slug runtime component', async () => {
    const name = 'react-manifest-without-live-component';
    const dir = await writeReconciliationPlugin(
      name,
      {
        capabilities: ['ui:harness-route'],
        ui: [{ type: 'react', slug: 'declared-pane', label: 'Declared pane' }],
      },
      `module.exports = { name: ${JSON.stringify(name)}, version: '0.1.0', papercusp: '^0.1.0', capabilities: ['ui:harness-route'] };`,
    );

    const result = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in result);
    assert.match(result.error, /manifest\.ui slug "declared-pane".*runtime component/);
  });
});

describe('loadPlugins', () => {
  it('honors PAPERCUSP_WORKSPACES_ROOT when HOME is remapped', async () => {
    const canonicalRoot = join(ROOT, 'workspace-root');
    const remappedHome = join(ROOT, 'remapped-home');
    const workspaceId = 'workspace-a';
    const harnessSlug = 'root-env-harness';
    const pluginDir = join(
      canonicalRoot,
      workspaceId,
      '.papercusp',
      'harnesses',
      harnessSlug,
      'plugins',
      'root-env-plugin',
    );

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(join(canonicalRoot, 'empty-global'), { recursive: true });
    await fs.writeFile(
      join(canonicalRoot, 'registry.json'),
      JSON.stringify({ current: workspaceId, workspaces: [] }),
      'utf8',
    );
    await fs.writeFile(
      join(pluginDir, 'papercusp.json'),
      JSON.stringify({ name: 'root-env-plugin', version: '0.1.0' }),
      'utf8',
    );
    await fs.writeFile(
      join(pluginDir, 'index.cjs'),
      `module.exports = {
        name: 'root-env-plugin',
        version: '0.1.0',
        papercusp: '^0.1.0',
        capabilities: [],
        hooks: { afterDone: async () => {} },
      };`,
      'utf8',
    );

    const previousHome = process.env.HOME;
    const previousRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
    const previousPapercuspHome = process.env.PAPERCUSP_HOME;
    process.env.HOME = remappedHome;
    process.env.PAPERCUSP_WORKSPACES_ROOT = canonicalRoot;
    delete process.env.PAPERCUSP_HOME;

    try {
      const r = await loadPlugins({
        harnessSlugs: [harnessSlug],
        globalPluginsDir: join(canonicalRoot, 'empty-global'),
      });
      assert.equal(r.errors.length, 0, `got errors: ${JSON.stringify(r.errors)}`);
      assert.deepEqual(r.loaded.map((plugin) => plugin.plugin.name), ['root-env-plugin']);
      assert.equal(r.loaded[0]?.source, 'harness');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
      else process.env.PAPERCUSP_WORKSPACES_ROOT = previousRoot;
      if (previousPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = previousPapercuspHome;
    }
  });

  it('walks projectDir/plugins/', async () => {
    const projectDir = join(ROOT, 'walked-project');
    await fs.mkdir(join(projectDir, 'plugins'), { recursive: true });
    // Override the global dir to an empty temp path so the test doesn't
    // pick up plugins the developer happens to have installed in
    // ~/.papercusp/global-plugins/.
    const globalDir = join(ROOT, 'walked-empty-global');
    await fs.mkdir(globalDir, { recursive: true });
    // Move two plugins under the project
    for (const name of ['plugin-a', 'plugin-b']) {
      const src = await makePlugin({ name });
      await fs.cp(src, join(projectDir, 'plugins', name), { recursive: true });
    }
    const r = await loadPlugins({ projectDir, globalPluginsDir: globalDir });
    assert.equal(r.errors.length, 0);
    const names = r.loaded.map((l) => l.plugin.name).sort();
    assert.deepEqual(names, ['plugin-a', 'plugin-b']);
    for (const lp of r.loaded) assert.equal(lp.source, 'project');
  });

  it('skips dirs with neither manifest nor entry (not-a-plugin)', async () => {
    // pi/ dir at ~/.papercusp/global-plugins/pi/ holds extension.ts for
    // pi-omp integration; it's not a papercusp plugin. Loader should skip
    // silently rather than emit a loud error.
    const dir = await makePlugin({ name: 'omp-stub', noManifest: true, noEntry: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('skipped' in r, `expected skipped, got ${JSON.stringify(r)}`);
    if ('skipped' in r) assert.equal(r.skipped, 'not-a-plugin');
  });

  it('recurses into @scope/ dirs as plugin candidates', async () => {
    const globalDir = join(ROOT, 'scoped-global');
    await fs.mkdir(join(globalDir, '@papercupai'), { recursive: true });
    const innerSrc = await makePlugin({ name: 'inside-scope' });
    await fs.cp(innerSrc, join(globalDir, '@papercupai', 'inside-scope'), { recursive: true });
    const r = await loadPlugins({ globalPluginsDir: globalDir });
    assert.equal(r.errors.length, 0, `got errors: ${JSON.stringify(r.errors)}`);
    const names = r.loaded.map((l) => l.plugin.name);
    assert.ok(names.includes('inside-scope'));
  });

  it('dedupes by plugin name across sources', async () => {
    const projectDir = join(ROOT, 'dedupe-project');
    await fs.mkdir(join(projectDir, 'plugins/dedupe-a'), { recursive: true });
    const projectVersion = await makePlugin({ name: 'dedupe-a', version: '1.0.0' });
    await fs.cp(projectVersion, join(projectDir, 'plugins/dedupe-a'), { recursive: true, force: true });

    const globalDir = join(ROOT, 'dedupe-global');
    await fs.mkdir(join(globalDir, 'dedupe-a'), { recursive: true });
    const globalVersion = await makePlugin({ name: 'dedupe-a', version: '0.0.1' });
    await fs.cp(globalVersion, join(globalDir, 'dedupe-a'), { recursive: true, force: true });

    const r = await loadPlugins({ projectDir, globalPluginsDir: globalDir });
    assert.equal(r.loaded.length, 1);
    assert.equal(r.loaded[0].plugin.name, 'dedupe-a');
    // Project wins.
    assert.equal(r.loaded[0].plugin.version, '1.0.0');
    assert.equal(r.loaded[0].source, 'project');
  });
});

// cupboard-distributable-integrations-2026-10-10 D-015: a `distribution: "cupboard"` package is
// never loaded from the bundled (project) root, and that copy never shadows the installed one.
describe('distribution: "cupboard"', () => {
  it('retains excluded and failed declarations without exposing config or importing an excluded entry', async () => {
    const projectDir = join(ROOT, 'manifest-discovery'), plugins = join(projectDir, 'plugins');
    const excluded = join(plugins, 'excluded'), failed = join(plugins, 'failed');
    const marker = join(projectDir, 'entry-executed');
    const tools = [{ name: 'unloaded-tool', description: 'fixture', inputSchema: { type: 'object' }, capabilities: [] }];
    for (const dir of [excluded, failed]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({
        name: dir === excluded ? 'excluded' : 'failed', version: '1.0.0', tools,
        ...(dir === excluded ? { distribution: 'cupboard' } : {}),
        config: { token: 'fixture-config-must-not-appear' },
        defaultConfig: { token: 'fixture-default-must-not-appear' },
      }));
    }
    await fs.writeFile(join(excluded, 'index.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw Error('excluded entry');`);
    const result = await loadPlugins({ projectDir, globalPluginsDir: join(projectDir, 'absent-global') });
    const byPath = new Map(result.discovery.candidates.map(candidate => [candidate.path, candidate]));
    assert.equal(byPath.get(excluded)?.status, 'excluded');
    assert.match(byPath.get(excluded)?.reason ?? '', /Cupboard install/);
    assert.equal(byPath.get(failed)?.status, 'error');
    assert.match(byPath.get(failed)?.error ?? '', /entry point/);
    for (const path of [excluded, failed]) {
      const manifest = byPath.get(path)?.manifest;
      assert.deepEqual(manifest?.tools, tools);
      assert.deepEqual(manifest?.runtime, { kind: 'js' });
      assert.equal(manifest?.config, undefined); assert.equal(manifest?.defaultConfig, undefined);
    }
    assert.equal(await fs.access(marker).then(() => true, () => false), false);
    assert.equal(result.loaded.length, 0);
  });

  async function cupboardPlugin(dir: string, name: string, version: string) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'papercusp.json'),
      JSON.stringify({ name, version, distribution: 'cupboard' }),
      'utf8',
    );
    await fs.writeFile(
      join(dir, 'index.mjs'),
      `export default { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, papercusp: '^0.1.0', capabilities: [] };`,
      'utf8',
    );
  }

  it('skips the bundled copy and loads the installed (global) one', async () => {
    const projectDir = join(ROOT, 'cupboard-project');
    const globalDir = join(ROOT, 'cupboard-global');
    await cupboardPlugin(join(projectDir, 'plugins', 'chat-pkg'), 'chat-pkg', '9.0.0');
    const plain = await makePlugin({ name: 'plain-bundled' });
    await fs.cp(plain, join(projectDir, 'plugins', 'plain-bundled'), { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });

    const before = await loadPlugins({ projectDir, globalPluginsDir: globalDir });
    assert.deepEqual(before.errors, []);
    assert.deepEqual(before.loaded.map((l) => l.plugin.name), ['plain-bundled']);

    await cupboardPlugin(join(globalDir, 'chat-pkg'), 'chat-pkg', '1.0.0');
    const after = await loadPlugins({ projectDir, globalPluginsDir: globalDir });
    const pkg = after.loaded.find((l) => l.plugin.name === 'chat-pkg');
    assert.equal(pkg?.source, 'global');
    assert.equal(pkg?.plugin.version, '1.0.0');
  });

  it('the delivered provider packages load only from an installed root', async () => {
    const plugins = fileURLToPath(new URL('../../../libs/papercusp/plugins/', import.meta.url));
    for (const name of [
      'slack', 'bug-triage', 'facebook', 'google-contacts', 'facebook-pages', 'instagram',
      'x', 'threads', 'tiktok', 'linkedin', 'linkedin-company', 'youtube', 'mastodon',
      'reddit', 'bluesky', 'devto', 'hashnode', 'discord',
    ]) {
      const r = await loadPluginFromDir(join(plugins, name), 'project');
      assert.ok('skipped' in r && r.skipped === 'excluded', `${name}: ${JSON.stringify(r)}`);
      const installed = await loadPluginFromDir(join(plugins, name), 'global');
      assert.ok('plugin' in installed, `${name}: ${JSON.stringify(installed)}`);
    }
  });
});
