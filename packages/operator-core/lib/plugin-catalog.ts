/**
 * Plugin catalog helpers — manifest discovery off disk.
 *
 * Manifest-only: reads `papercusp.json` from each plugin's directory but
 * does not dynamically import the plugin's index. Instantiation + hook
 * firing happens in node-side runners, keeping the bundle simple.
 *
 * Search paths (in priority order):
 *   1. <project>/plugins/<name>/papercusp.json          (project-scoped)
 *   2. ~/.papercusp/harnesses/<harness-slug>/plugins/<name>/papercusp.json
 *   3. ~/.papercusp/global-plugins/<name>/papercusp.json
 *
 * Relocated from `app/api/_hono/plugins.ts` (endpoint-hono-elimination
 * -2026-05-21 A3) when that Hono router was migrated to `defineTool`.
 * `listPluginsIn` is consumed by the `plugins/*` route modules and by
 * `plugin-configs-pg` / `plugin-enables-pg` mirroring.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginManifest } from '@papercusp/plugin-sdk';

import { papercuspRoot } from './papercusp-root';

export function HARNESSES_DIR(): string { return join(papercuspRoot(), 'harnesses'); }
export function GLOBAL_PLUGINS_DIR(): string { return join(papercuspRoot(), 'global-plugins'); }

/**
 * A manifest found on disk plus where it was found. The shape is plugin-sdk's
 * `PluginManifest` (the one authority — EI-21114087507786980). This reader
 * does not schema-validate; the plugin loader does, so a listed manifest may
 * still be refused at load time.
 */
export type ListedPluginManifest = PluginManifest & { source: string; path: string };

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

/**
 * List every plugin manifest under `parent`, deduped by manifest `name`.
 * Accepts directories AND symlinks-to-dirs (dev-mode pattern). When a
 * dirname looks like an npm scope (`@papercupai`), recurses one level —
 * `papercusp install <scoped-name>` extracts scoped packages into
 * `<scope>/<name>/`.
 */
export async function listPluginsIn(
  parent: string,
  source: 'project' | 'harness' | 'global',
): Promise<ListedPluginManifest[]> {
  const out: ListedPluginManifest[] = [];
  if (!existsSync(parent)) return out;
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    // Accept directories AND symlinks (dev-mode pattern: symlinking a
    // plugin's repo dir into ~/.papercusp/global-plugins/).
    let isDirOrLinkToDir = e.isDirectory();
    if (!isDirOrLinkToDir && e.isSymbolicLink()) {
      const target = await fs.stat(join(parent, e.name)).catch(() => null);
      isDirOrLinkToDir = target?.isDirectory() ?? false;
    }
    if (!isDirOrLinkToDir) continue;
    const dir = join(parent, e.name);
    const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
    if (m?.name && m?.version) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        out.push({ ...m, source, path: dir });
      }
      continue;
    }
    // No manifest at this level. If the dirname looks like an npm scope
    // (e.g. `@papercupai`), recurse one level — `papercusp install <slug>`
    // extracts scoped packages into `<scope>/<name>/`. Matches the runtime
    // loader's behaviour (loader.test.ts > recurses into @scope/ dirs).
    if (!e.name.startsWith('@')) continue;
    const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const sub of inner) {
      if (sub.name.startsWith('.')) continue;
      let subIsDir = sub.isDirectory();
      if (!subIsDir && sub.isSymbolicLink()) {
        const t = await fs.stat(join(dir, sub.name)).catch(() => null);
        subIsDir = t?.isDirectory() ?? false;
      }
      if (!subIsDir) continue;
      const subDir = join(dir, sub.name);
      const subM = await readJson<PluginManifest>(join(subDir, 'papercusp.json'));
      if (!subM?.name || !subM?.version) continue;
      if (seen.has(subM.name)) continue;
      seen.add(subM.name);
      out.push({ ...subM, source, path: subDir });
    }
  }
  return out;
}

/** Resolve a registered harness slug to its on-disk project path. */
export async function resolveProjectPath(slug: string): Promise<string | null> {
  const { loadHarnessRegistry } = await import('./harness-registry');
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}
