import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { frontmatterDocuments, parseDocumentsField } from '@papercusp/operator-core/lib/harness/docs/subject-ref';
import { assertPublicManualSource, PUBLIC_MANUAL_GUIDES } from '../../papercusp-docs/scripts/source-contract.mjs';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '../../papercusp-docs');
const content = resolve(root, 'src/content/docs');
const pages = PUBLIC_MANUAL_GUIDES;

describe('public user manual source readiness', () => {
  it('the actual Astro publication guard accepts current source', () => {
    expect(assertPublicManualSource(root).guides).toBe(pages.length);
  });
  it('the actual publication guard rejects deleted guide coverage before building', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'public-manual-contract-'));
    const docs = resolve(fixture, 'apps/papercusp-docs');
    try {
      mkdirSync(docs, { recursive: true });
      cpSync(resolve(root, 'src'), resolve(docs, 'src'), { recursive: true });
      cpSync(resolve(root, 'astro.config.mjs'), resolve(docs, 'astro.config.mjs'));
      rmSync(resolve(docs, 'src/content/docs/quickstart.mdx'));
      expect(() => assertPublicManualSource(docs)).toThrow('missing guide: quickstart');
      writeFileSync(resolve(docs, 'src/content/docs/quickstart.mdx'), '---\ntitle: Broken\n---\n## Intro\n');
      expect(() => assertPublicManualSource(docs)).toThrow('untracked guide: quickstart.mdx');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
  it.each(pages)('publishes a substantive maintained guide: %s', (slug) => {
    const text = readFileSync(resolve(content, `${slug}.mdx`), 'utf8');
    expect(text).toMatch(/^---\ntitle: /);
    expect(text).toMatch(/description: /);
    expect(text).toContain('## ');
    expect(text.length).toBeGreaterThan(800);
    expect(text).not.toMatch(/localhost:3055|papercup\.ai|papercuspai\.com|\*\(Screenshot:|papercusp publish|brew install papercupai/);
    expect(text).not.toMatch(/github\.com\/Papercusp\/papercup(?:[)\s/]|$)/);
  });
  it('uses the public portal canonical origin and real sidebar home slug', () => {
    const config = readFileSync(resolve(root, 'astro.config.mjs'), 'utf8');
    expect(config).toContain("site: 'https://app.papercusp.com'");
    expect(config).toContain("base: '/docs'");
    expect(config).toContain("{ label: 'Welcome', slug: '' }");
    expect(config).toContain('https://github.com/Papercusp/papercusp-app');
  });
  it('source article links name existing public guides, not private documentation', () => {
    for (const file of readdirSync(content).filter((name) => name.endsWith('.mdx'))) {
      const text = readFileSync(resolve(content, file), 'utf8');
      expect(text).not.toMatch(/\]\(\/internal\/docs/);
      for (const match of text.matchAll(/\]\(\/docs\/([^)#?]*)/g)) {
        const slug = match[1].replace(/\/$/, '') || 'index';
        expect(existsSync(resolve(content, `${slug}.mdx`)), `${file}: ${match[0]}`).toBe(true);
      }
    }
  });
  it.each(pages)('declares real code anchors for drift review: %s', (slug) => {
    const text = readFileSync(resolve(content, `${slug}.mdx`), 'utf8');
    const refs = parseDocumentsField(frontmatterDocuments(text));
    expect(refs.length, `${slug} has no source anchor`).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.kind).toBe('path');
      if (ref.kind !== 'path') continue;
      for (const path of ref.globs) {
        expect(path).not.toMatch(/(^\/|(^|\/)\.\.(\/|$))/);
        expect(existsSync(resolve(root, '../..', path)), `${slug}: dead anchor ${path}`).toBe(true);
      }
    }
  });
  it('makes new workflow coverage reachable and distinct from project docs', () => {
    const config = readFileSync(resolve(root, 'astro.config.mjs'), 'utf8');
    const home = readFileSync(resolve(content, 'index.mdx'), 'utf8');
    for (const slug of ['quickstart', 'plans-and-work', 'agent-modes-and-fleets', 'accounts-and-billing', 'voice']) {
      expect(config, `missing sidebar entry ${slug}`).toContain(`'${slug}'`);
      expect(home).toContain(`/docs/${slug}`);
    }
    const declaration = JSON.parse(readFileSync(resolve(root, '../../.papercusp/docs.json'), 'utf8'));
    expect(declaration.root).toBe('apps/operator-docs/src/content/docs');
    expect(declaration.sources['public-manual']).toBe('apps/papercusp-docs/src/content/docs');
  });
});
