/**
 * plugin-sdk's PluginManifest is the one papercusp.json type
 * (EI-21114087507786980). Four readers used to carry their own copies, and the
 * copies drifted: the catalog and the contributions route typed `ui` as a single
 * object while the schema declares an array of surfaces.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@papercusp/plugin-sdk';
import { uiRoutesFor } from './endpoint-route/routes/plugins/contributions';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AUTHORITY = 'packages/plugin-sdk/src/index.ts';

function manifestShapeDeclarations(): string[] {
  let out = '';
  try {
    out = execFileSync(
      'git',
      ['grep', '--untracked', '-n', '-E', '^\\s*(export\\s+)?(interface|type)\\s+(PluginManifest|ManifestShape)\\b', '--', 'packages', 'apps'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  return out.split('\n').filter(Boolean);
}

describe('papercusp.json manifest type authority', () => {
  it('only plugin-sdk declares the manifest shape', () => {
    const declarations = manifestShapeDeclarations();
    // Positive control: the search finds the authority itself.
    expect(declarations.some((line) => line.startsWith(`${AUTHORITY}:`))).toBe(true);
    // The plugin loader's alias to the sdk type is the one permitted re-declaration.
    const others = declarations.filter(
      (line) =>
        !line.startsWith(`${AUTHORITY}:`) &&
        !/^packages\/plugin-loader\/src\/index\.ts:\d+:type ManifestShape = import\('@papercusp\/plugin-sdk'\)\.PluginManifest;/.test(line),
    );
    expect(others).toEqual([]);
  });
});

describe('contributions route ui surfaces', () => {
  it('maps every ui surface entry to its own route', () => {
    const manifest: Pick<PluginManifest, 'name' | 'ui'> = {
      name: 'markdown-preview',
      ui: [
        { slug: 'preview', label: 'Preview' },
        { type: 'iframe', slug: 'raw', label: 'Raw', iframeEntry: 'raw.html' },
      ],
    };
    expect(uiRoutesFor(manifest, '/plugins/markdown-preview')).toEqual([
      { componentRoot: '/plugins/markdown-preview', slug: 'preview', label: 'Preview', pluginName: 'markdown-preview' },
      {
        componentRoot: '/plugins/markdown-preview',
        type: 'iframe',
        slug: 'raw',
        label: 'Raw',
        iframeEntry: 'raw.html',
        pluginName: 'markdown-preview',
      },
    ]);
  });

  it('yields no route for an object-shaped ui or a malformed entry', () => {
    const objectShaped = { name: 'legacy', ui: { slug: 'x', label: 'X' } } as unknown as Pick<PluginManifest, 'name' | 'ui'>;
    expect(uiRoutesFor(objectShaped, undefined)).toEqual([]);
    const malformed = { name: 'bad', ui: [null, { label: 'no slug' }] } as unknown as Pick<PluginManifest, 'name' | 'ui'>;
    expect(uiRoutesFor(malformed, undefined)).toEqual([]);
  });
});
