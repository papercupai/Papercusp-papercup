/**
 * PluginManifest is the single TypeScript authority for papercusp.json
 * (EI-21114087507786980). This pins it to papercusp-plugin.schema.json in both
 * directions:
 *   - MANIFEST_KEYS is typed `Record<keyof PluginManifest, true>`, so a key the
 *     interface gains or loses fails typecheck until this list follows it;
 *   - the runtime assertion compares that list with the schema's top-level
 *     properties, so a field the schema gains or loses fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginManifest } from './index';

const MANIFEST_KEYS: Record<keyof PluginManifest, true> = {
  $schema: true,
  name: true,
  version: true,
  description: true,
  author: true,
  license: true,
  homepage: true,
  kind: true,
  dependencies: true,
  provides: true,
  provider: true,
  triggerPack: true,
  papercusp: true,
  protocol: true,
  capabilities: true,
  tools: true,
  actions: true,
  roles: true,
  dashboardTabs: true,
  sidebarItems: true,
  ui: true,
  runtime: true,
  apiRoutes: true,
  routines: true,
  reactions: true,
  models: true,
  configSchema: true,
  uiSchema: true,
  schema: true,
  plugins: true,
  configFiles: true,
  requiresTemplateKinds: true,
  forkedFrom: true,
  publishedAt: true,
  publishedBy: true,
  tierMap: true,
  icon: true,
  bundled: true,
  snapshot: true,
  hidden: true,
  hiddenReason: true,
  distribution: true,
  publisher: true,
  pluginVersionPinned: true,
  versionPin: true,
  hotReload: true,
  kvQuota: true,
  provision: true,
  oauth: true,
  main: true,
  config: true,
  _legacyExtras: true,
  requires: true,
  recommends: true,
  defaultConfig: true,
};

const schema = JSON.parse(
  readFileSync(new URL('../papercusp-plugin.schema.json', import.meta.url), 'utf8'),
) as { properties: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };

describe('PluginManifest type vs papercusp-plugin.schema.json', () => {
  it('declares exactly the schema top-level properties', () => {
    expect(Object.keys(MANIFEST_KEYS).sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('the schema is closed, so the key set is the whole manifest', () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it('the schema requires exactly the two fields the type requires', () => {
    // `name` and `version` are the only non-optional members of PluginManifest.
    const required: Array<keyof PluginManifest> = ['name', 'version'];
    expect([...(schema.required ?? [])].sort()).toEqual([...required].sort());
  });
});
