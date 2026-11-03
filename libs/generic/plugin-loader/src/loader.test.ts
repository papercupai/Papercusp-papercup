import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginLoader, type ManifestError, type LoadedPlugin } from './loader';

// ── A synthetic host: a fake plugin shape + manifest + ports. Proves the
//    kernel orchestrates discovery/load/validate/dedupe without knowing
//    anything about the host's domain. ──────────────────────────────────

interface FakePlugin {
  name: string;
  version: string;
  special?: boolean;
}

interface FakeManifest {
  name: string;
  version: string;
  runtime?: 'special';
  /** When set, runtimeDispatch returns an error (simulates a bad alt-runtime). */
  brokenSpecial?: boolean;
}

const ROOT = join(tmpdir(), `generic-loader-test-${process.pid}`);

async function makePlugin(opts: {
  name: string;
  version?: string;
  manifestVersion?: string;
  noManifest?: boolean;
  noEntry?: boolean;
  badManifest?: boolean;
  runtime?: 'special';
  brokenSpecial?: boolean;
  atDir?: string;
}): Promise<string> {
  const dir = opts.atDir ?? join(ROOT, opts.name);
  await fs.mkdir(dir, { recursive: true });
  const version = opts.version ?? '0.1.0';

  if (!opts.noManifest) {
    const manifest: Record<string, unknown> = opts.badManifest
      ? { name: opts.name, version: opts.manifestVersion ?? version, __bad: true }
      : { name: opts.name, version: opts.manifestVersion ?? version };
    if (opts.runtime) manifest.runtime = opts.runtime;
    if (opts.brokenSpecial) manifest.brokenSpecial = true;
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  }
  // 'special' runtime plugins carry no JS entry (dispatched before import).
  if (!opts.noEntry && opts.runtime !== 'special') {
    await fs.writeFile(
      join(dir, 'index.cjs'),
      `module.exports = ${JSON.stringify({ name: opts.name, version })};`,
      'utf8',
    );
  }
  return dir;
}

const loader = createPluginLoader<FakePlugin, FakeManifest>({
  invalidManifestError: 'missing or invalid manifest.json',
  noEntryError: 'no entry point found (looked for index.cjs)',
  async readManifest(dir) {
    try {
      const raw = await fs.readFile(join(dir, 'manifest.json'), 'utf8');
      const parsed = JSON.parse(raw) as FakeManifest & { __bad?: boolean };
      if (!parsed?.name || !parsed?.version) return null;
      if (parsed.__bad) return { __error: 'manifest invalid: __bad set' } satisfies ManifestError;
      return parsed;
    } catch {
      return null;
    }
  },
  async locateEntry(dir) {
    const p = join(dir, 'index.cjs');
    return existsSync(p) ? p : null;
  },
  async runtimeDispatch(manifest, path, source) {
    if (manifest.runtime !== 'special') return null; // fall through to JS path
    if (manifest.brokenSpecial) return { error: 'special runtime misconfigured', path };
    const plugin: FakePlugin = { name: manifest.name, version: manifest.version, special: true };
    return { plugin, manifest, path, source } satisfies LoadedPlugin<FakePlugin, FakeManifest>;
  },
  validatePlugin(plugin, manifest) {
    if (plugin.name !== manifest.name) return `name mismatch: ${plugin.name} != ${manifest.name}`;
    if (plugin.name === 'rejectme') return 'plugin rejectme is not allowed';
    return null;
  },
  pluginName: (p) => p.name,
});

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('loadFromDir', () => {
  it('loads a valid plugin', async () => {
    const dir = await makePlugin({ name: 'happy-path' });
    const r = await loader.loadFromDir(dir, 'project');
    expect('plugin' in r).toBe(true);
    if ('plugin' in r) {
      expect(r.plugin.name).toBe('happy-path');
      expect(r.source).toBe('project');
      expect(r.manifest.name).toBe('happy-path');
    }
  });

  it('skips a dir with neither manifest nor entry (not-a-plugin)', async () => {
    const dir = await makePlugin({ name: 'stub', noManifest: true, noEntry: true });
    const r = await loader.loadFromDir(dir, 'project');
    expect('skipped' in r && r.skipped === 'not-a-plugin').toBe(true);
  });

  it('errors when an entry exists but the manifest is missing', async () => {
    const dir = await makePlugin({ name: 'no-manifest', noManifest: true });
    const r = await loader.loadFromDir(dir, 'project');
    expect('error' in r && /manifest\.json/.test(r.error)).toBe(true);
  });

  it('surfaces a present-but-invalid manifest as an error', async () => {
    const dir = await makePlugin({ name: 'bad-manifest', badManifest: true });
    const r = await loader.loadFromDir(dir, 'project');
    expect('error' in r && /__bad set/.test(r.error)).toBe(true);
  });

  it('errors when entry point is missing', async () => {
    const dir = await makePlugin({ name: 'no-entry', noEntry: true });
    const r = await loader.loadFromDir(dir, 'project');
    expect('error' in r && /entry point/.test(r.error)).toBe(true);
  });

  it('runs validatePlugin and returns its error', async () => {
    const dir = await makePlugin({ name: 'rejectme' });
    const r = await loader.loadFromDir(dir, 'project');
    expect('error' in r && /not allowed/.test(r.error)).toBe(true);
  });

  it('dispatches an alternate-runtime manifest without importing an entry', async () => {
    const dir = await makePlugin({ name: 'wasmy', runtime: 'special' });
    const r = await loader.loadFromDir(dir, 'project');
    expect('plugin' in r).toBe(true);
    if ('plugin' in r) {
      expect(r.plugin.special).toBe(true);
      expect(r.plugin.name).toBe('wasmy');
    }
  });

  it('surfaces an alternate-runtime dispatch error', async () => {
    const dir = await makePlugin({ name: 'broken-wasm', runtime: 'special', brokenSpecial: true });
    const r = await loader.loadFromDir(dir, 'project');
    expect('error' in r && /misconfigured/.test(r.error)).toBe(true);
  });
});

describe('loadAll', () => {
  it('retains filesystem failures instead of presenting an empty configured population', async () => {
    const missing = join(ROOT, 'missing-root'), notDirectory = join(ROOT, 'not-directory');
    await fs.writeFile(notDirectory, 'fixture');
    const r = await loader.loadAll([{ pluginsDir: missing, source: 'project' }, { pluginsDir: notDirectory, source: 'global' }]);
    expect(r.loaded).toEqual([]);
    expect(r.discovery.unavailable).toEqual([{ path: missing, code: 'ENOENT' }, { path: notDirectory, code: 'ENOTDIR' }]);
  });

  it('walks a root and loads all candidates', async () => {
    const proj = join(ROOT, 'walk-proj', 'plugins');
    await makePlugin({ name: 'walk-a', atDir: join(proj, 'walk-a') });
    await makePlugin({ name: 'walk-b', atDir: join(proj, 'walk-b') });
    const r = await loader.loadAll([{ pluginsDir: proj, source: 'project' }]);
    expect(r.errors.length).toBe(0);
    expect(r.loaded.map((l) => l.plugin.name).sort()).toEqual(['walk-a', 'walk-b']);
    expect(r.loaded.every((l) => l.source === 'project')).toBe(true);
    expect(r.discovery.roots).toEqual([{ pluginsDir: proj, source: 'project' }]);
    expect(r.discovery.candidates.map(c => [c.pluginName, c.status]).sort())
      .toEqual([['walk-a', 'loaded'], ['walk-b', 'loaded']]);
  });

  it('recurses into @scope/ dirs when scopeRecurse is set', async () => {
    const globalDir = join(ROOT, 'scoped-global');
    await makePlugin({ name: 'inside-scope', atDir: join(globalDir, '@acme', 'inside-scope') });
    const r = await loader.loadAll([{ pluginsDir: globalDir, source: 'global', scopeRecurse: true }]);
    expect(r.errors.length).toBe(0);
    expect(r.loaded.map((l) => l.plugin.name)).toContain('inside-scope');
  });

  it('does NOT recurse scope dirs without scopeRecurse', async () => {
    const dir = join(ROOT, 'unscoped-global');
    await makePlugin({ name: 'hidden', atDir: join(dir, '@acme', 'hidden') });
    const r = await loader.loadAll([{ pluginsDir: dir, source: 'global' }]);
    // The @acme dir has no manifest+entry of its own → skipped, plugin unseen.
    expect(r.loaded.map((l) => l.plugin.name)).not.toContain('hidden');
  });

  it('dedupes by plugin name with first-root-wins precedence', async () => {
    const projDir = join(ROOT, 'dedupe-proj', 'plugins');
    await makePlugin({ name: 'dup', version: '1.0.0', atDir: join(projDir, 'dup') });
    const globalDir = join(ROOT, 'dedupe-global');
    await makePlugin({ name: 'dup', version: '0.0.1', atDir: join(globalDir, 'dup') });

    const r = await loader.loadAll([
      { pluginsDir: projDir, source: 'project' },
      { pluginsDir: globalDir, source: 'global', scopeRecurse: true },
    ]);
    expect(r.loaded.length).toBe(1);
    expect(r.loaded[0].plugin.version).toBe('1.0.0'); // project wins
    expect(r.loaded[0].source).toBe('project');
    expect(r.discovery.candidates.map(c => [c.source, c.status]))
      .toEqual([['project', 'loaded'], ['global', 'shadowed']]);
  });

  it('collects load errors without aborting the walk', async () => {
    const dir = join(ROOT, 'mixed', 'plugins');
    await makePlugin({ name: 'ok-one', atDir: join(dir, 'ok-one') });
    await makePlugin({ name: 'bad-one', badManifest: true, atDir: join(dir, 'bad-one') });
    const r = await loader.loadAll([{ pluginsDir: dir, source: 'project' }]);
    expect(r.loaded.map((l) => l.plugin.name)).toContain('ok-one');
    expect(r.errors.some((e) => /__bad set/.test(e.error))).toBe(true);
    expect(r.discovery.candidates).toContainEqual(expect.objectContaining({
      path: join(dir, 'bad-one'), source: 'project', status: 'error', error: 'manifest invalid: __bad set',
    }));
  });

  it('snapshots valid declarations before runtime code and retains them when loading fails', async () => {
    const root = join(ROOT, 'manifest-snapshot');
    await makePlugin({ name: 'declared', atDir: join(root, 'declared') });
    const manifest = { name: 'declared', version: '1.0.0', tools: [{ name: 'original' }] };
    const order: string[] = [];
    const snapshotLoader = createPluginLoader<FakePlugin, typeof manifest>({
      async readManifest() { order.push('parse'); return manifest; },
      describeManifest(parsed) { order.push('snapshot'); return structuredClone(parsed); },
      async locateEntry() { order.push('locate'); return '/fake/entry.cjs'; },
      async importEntry() {
        order.push('import'); manifest.tools[0]!.name = 'mutated';
        return { error: 'entry failed after mutation' };
      },
      pluginName: plugin => plugin.name,
    });
    const result = await snapshotLoader.loadAll([{ pluginsDir: root, source: 'project' }]);
    expect(order).toEqual(['parse', 'snapshot', 'locate', 'import']);
    expect(result.loaded).toEqual([]);
    expect(result.discovery.candidates).toEqual([{
      path: join(root, 'declared'), source: 'project', status: 'error',
      error: 'import threw at /fake/entry.cjs: entry failed after mutation',
      manifest: { name: 'declared', version: '1.0.0', tools: [{ name: 'original' }] },
    }]);
  });
});

// A host that refuses manifests marked `globalOnly` from its 'project' root
// (the Papercusp `distribution: "cupboard"` rule, in the kernel's own terms).
describe('admitManifest', () => {
  type GatedManifest = FakeManifest & { globalOnly?: boolean };
  let entryLookups: string[] = [];
  const gated = createPluginLoader<FakePlugin, GatedManifest>({
    async readManifest(dir) {
      try {
        const parsed = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as GatedManifest;
        return parsed?.name && parsed?.version ? parsed : null;
      } catch {
        return null;
      }
    },
    async locateEntry(dir) {
      entryLookups.push(dir);
      const p = join(dir, 'index.cjs');
      return existsSync(p) ? p : null;
    },
    admitManifest: (manifest, source) =>
      manifest.globalOnly && source === 'project' ? 'globalOnly: installed copies only' : null,
    describeManifest: manifest => ({ ...structuredClone(manifest) }),
    pluginName: (p) => p.name,
  });

  async function gatedPlugin(dir: string, name: string, version: string, globalOnly: boolean) {
    await makePlugin({ name, version, atDir: dir });
    const manifest: GatedManifest = { name, version, ...(globalOnly ? { globalOnly: true } : {}) };
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  }

  it('skips an excluded manifest with its reason, before locating or importing an entry', async () => {
    entryLookups = [];
    const dir = join(ROOT, 'admit-single', 'plugins', 'gated');
    await gatedPlugin(dir, 'gated', '1.0.0', true);
    const r = await gated.loadFromDir(dir, 'project');
    expect(r).toEqual({ skipped: 'excluded', path: dir, reason: 'globalOnly: installed copies only' });
    expect(entryLookups).toEqual([]);
    const fromGlobal = await gated.loadFromDir(dir, 'global');
    expect('plugin' in fromGlobal && fromGlobal.plugin.name).toBe('gated');
  });

  it('an excluded higher-precedence copy never shadows the same name in a later root', async () => {
    const projDir = join(ROOT, 'admit-proj', 'plugins');
    const globalDir = join(ROOT, 'admit-global');
    await gatedPlugin(join(projDir, 'shared'), 'shared', '9.9.9', true);
    await gatedPlugin(join(globalDir, 'shared'), 'shared', '1.2.3', true);
    await gatedPlugin(join(projDir, 'plain'), 'plain', '1.0.0', false);

    const r = await gated.loadAll([
      { pluginsDir: projDir, source: 'project' },
      { pluginsDir: globalDir, source: 'global' },
    ]);
    const byName = Object.fromEntries(r.loaded.map((l) => [l.plugin.name, l]));
    expect(Object.keys(byName).sort()).toEqual(['plain', 'shared']);
    expect(byName.shared.source).toBe('global');
    expect(byName.shared.plugin.version).toBe('1.2.3');
    expect(byName.plain.source).toBe('project');
    expect(r.errors).toEqual([]);
    expect(r.discovery.candidates).toContainEqual({ path: join(projDir, 'shared'), source: 'project', status: 'excluded',
      reason: 'globalOnly: installed copies only', manifest: { name: 'shared', version: '9.9.9', globalOnly: true } });
  });
});
