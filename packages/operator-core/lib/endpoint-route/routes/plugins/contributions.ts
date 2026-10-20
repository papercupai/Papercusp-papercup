/**
 * GET /api/plugins/:slug/contributions — manifest-only contribution metadata.
 * Returns dashboardTabs, sidebarItems, ui routes, and panels for plugins
 * enabled in the named harness.
 * Ported from app/api/plugins/[slug]/contributions/route.ts. `auth: 'public'`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  ManifestDashboardTab,
  ManifestSidebarItem,
  PluginManifest,
  UiSurfaceManifestEntry,
} from '@papercusp/plugin-sdk';
import { GLOBAL_PLUGINS_DIR, HARNESSES_DIR, listPluginsIn, resolveProjectPath } from '../../../plugin-catalog';
import { defineTool } from '@papercusp/agent-mcp';

/** The default a plugin's configSchema declares for `key`, if any. */
function configSchemaDefault(manifest: PluginManifest, key: string): unknown {
  const properties = (manifest.configSchema as { properties?: Record<string, { default?: unknown } | undefined> } | undefined)
    ?.properties;
  return properties?.[key]?.default;
}

/**
 * One route per `ui` surface entry. The schema declares `ui` as an ARRAY of
 * surfaces; this route used to read it as a single object and spread the array
 * into one route (EI-21114087507786980).
 */
export function uiRoutesFor(
  manifest: Pick<PluginManifest, 'name' | 'ui'>,
  pluginRoot: string | undefined,
): Array<UiSurfaceManifestEntry & { componentRoot?: string; pluginName: string }> {
  const entries = Array.isArray(manifest.ui) ? manifest.ui : [];
  return entries
    .filter((entry): entry is UiSurfaceManifestEntry => !!entry && typeof entry === 'object' && typeof entry.slug === 'string')
    .map((entry) => ({ componentRoot: pluginRoot, ...entry, pluginName: manifest.name }));
}

async function readJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch { return null; }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const stripped = raw.replace(/,(\s*[\]}])/g, '$1');
    try {
      return JSON.parse(stripped) as T;
    } catch {
      console.warn(
        `[plugins/contributions] failed to parse ${path} — file is malformed JSON, treating as empty. Original error:`,
        (e as Error).message,
      );
      return null;
    }
  }
}

async function resolveIframeUrl(
  manifest: PluginManifest,
  tab: ManifestDashboardTab,
  harnessConfig: Record<string, unknown> | null,
  harnessSlug: string,
): Promise<string | null> {
  let url: string | null = null;
  if (tab.iframeUrlConfigKey) {
    const k = tab.iframeUrlConfigKey;
    const fromConfig = harnessConfig?.[k];
    const fromDefault = configSchemaDefault(manifest, k);
    if (typeof fromConfig === 'string' && fromConfig.length > 0) url = fromConfig;
    else if (typeof fromDefault === 'string' && fromDefault.length > 0) url = fromDefault;
  }
  if (!url && typeof tab.iframeUrl === 'string' && tab.iframeUrl.length > 0) {
    url = tab.iframeUrl;
  }
  if (!url) return null;
  url = url.replace(/^https?:\/\/localhost:3055(\/|$)/, '$1');

  const sep = url.includes('?') ? '&' : '?';
  url = `${url}${sep}harness=${encodeURIComponent(harnessSlug)}`;

  if (tab.iframeAppendProjectFolder) {
    const projectPath = await resolveProjectPath(harnessSlug);
    if (projectPath) {
      url = `${url}&folder=${encodeURIComponent(projectPath)}`;
    }
  }

  return url;
}

export default defineTool({
  method: 'GET',
  path: '/plugins/:slug/contributions',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    const projectPath = await resolveProjectPath(slug);
    const sources: Array<{ name: string; dir: string; source: 'project' | 'harness' | 'global' }> = [];
    if (projectPath) {
      sources.push({ name: slug, dir: join(projectPath, 'plugins'), source: 'project' });
    }
    if (existsSync(HARNESSES_DIR())) {
      const harnessDirs = await fs.readdir(HARNESSES_DIR(), { withFileTypes: true }).catch(() => []);
      for (const h of harnessDirs) {
        if (!h.isDirectory()) continue;
        sources.push({ name: h.name, dir: join(HARNESSES_DIR(), h.name, 'plugins'), source: 'harness' });
      }
    }
    sources.push({ name: 'global', dir: GLOBAL_PLUGINS_DIR(), source: 'global' });

    type EnabledFile = { enabled: Record<string, { version: string }> };
    const enabledFile = await readJson<EnabledFile>(
      join(HARNESSES_DIR(), slug, 'enabled-plugins.json'),
    );
    const enabledSet = new Set<string>(enabledFile ? Object.keys(enabledFile.enabled) : []);

    const seen = new Set<string>();
    type Tab = ManifestDashboardTab & { pluginName: string };
    type Item = ManifestSidebarItem & { pluginName: string };
    type Route = ReturnType<typeof uiRoutesFor>[number];
    const dashboardTabs: Tab[] = [];
    const sidebarItems: Item[] = [];
    const routes: Route[] = [];
    type PanelContrib = {
      pluginName: string;
      id: string;
      fullType: string;
      title: string;
      icon?: string;
      type: 'react' | 'iframe';
      componentRoot?: string;
      componentId?: string;
      src?: string;
      defaultGroup?: string;
      defaultFloating?: { width?: number; height?: number };
      keepAlive?: boolean;
    };
    const panelsContrib: PanelContrib[] = [];

    for (const s of sources) {
      for (const p of await listPluginsIn(s.dir, s.source)) {
        if (seen.has(p.name)) continue;
        const dirBasename = basename(p.path);
        if (s.source === 'global' && !(enabledSet.has(p.name) || enabledSet.has(dirBasename))) continue;
        seen.add(p.name);
        const pluginRoot = (p as PluginManifest & { componentRoot?: string }).componentRoot;
        const harnessConfig = await readJson<Record<string, unknown>>(
          join(HARNESSES_DIR(), slug, 'plugin-configs', `${p.name}.json`),
        );
        for (const tab of p.dashboardTabs ?? []) {
          const resolvedIframeUrl = await resolveIframeUrl(p, tab, harnessConfig, slug);
          dashboardTabs.push({
            componentRoot: tab.componentRoot ?? pluginRoot,
            ...tab,
            iframeUrl: resolvedIframeUrl ?? tab.iframeUrl,
            pluginName: p.name,
          });
          if (tab.replaces && Array.isArray(tab.replaces) && tab.replaces.length > 0) {
            console.warn(
              `[dock] plugin ${p.name} tab "${tab.id}" declares replaces=${JSON.stringify(tab.replaces)} — ignored in dock model (still honored in classic dashboard)`,
            );
          }
          const finalSrc = resolvedIframeUrl ?? tab.iframeUrl;
          panelsContrib.push({
            pluginName: p.name,
            id: tab.id,
            fullType: `plugin:${p.name}:${tab.id}`,
            title: tab.label ?? tab.id,
            icon: tab.icon,
            type: finalSrc ? 'iframe' : 'react',
            componentRoot: tab.componentRoot ?? pluginRoot,
            componentId: tab.componentId,
            src: finalSrc ?? undefined,
          });
        }
        type PanelDecl = {
          id: string;
          title: string;
          icon?: string;
          type?: 'react' | 'iframe';
          componentRoot?: string;
          componentId?: string;
          src?: string;
          iframeUrl?: string;
          iframeUrlConfigKey?: string;
          defaultGroup?: string;
          defaultFloating?: { width?: number; height?: number };
          keepAlive?: boolean;
        };
        const declared = (p as PluginManifest & { panels?: PanelDecl[] }).panels ?? [];
        for (const panel of declared) {
          let resolvedSrc = panel.src ?? panel.iframeUrl;
          if (!resolvedSrc && panel.iframeUrlConfigKey) {
            const synthTab: ManifestDashboardTab = {
              id: panel.id,
              label: panel.title,
              iframeUrlConfigKey: panel.iframeUrlConfigKey,
            };
            resolvedSrc = (await resolveIframeUrl(p, synthTab, harnessConfig, slug)) ?? undefined;
          }
          panelsContrib.push({
            pluginName: p.name,
            id: panel.id,
            fullType: `plugin:${p.name}:${panel.id}`,
            title: panel.title,
            icon: panel.icon,
            type: panel.type ?? (resolvedSrc ? 'iframe' : 'react'),
            componentRoot: panel.componentRoot ?? pluginRoot,
            componentId: panel.componentId,
            src: resolvedSrc,
            defaultGroup: panel.defaultGroup,
            defaultFloating: panel.defaultFloating,
            keepAlive: panel.keepAlive,
          });
        }
        for (const item of p.sidebarItems ?? []) {
          sidebarItems.push({ ...item, pluginName: p.name });
        }
        routes.push(...uiRoutesFor(p, pluginRoot));
      }
    }

    return Response.json({
      project: { slug, path: projectPath },
      dashboardTabs, sidebarItems, routes,
      panels: panelsContrib,
    });
  },
});
