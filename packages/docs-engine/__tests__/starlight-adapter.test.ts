/**
 * starlightContentAdapter tests — synthetic fixture on disk + smoke against
 * the real apps/operator-docs/ tree.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { starlightContentAdapter } from '../src/adapters/starlight';
import { buildOutline } from '../src/outline';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const OPERATOR_DOCS_ROOT = path.join(
  REPO_ROOT,
  'apps',
  'operator-docs',
  'src',
  'content',
  'docs',
);

describe('starlightContentAdapter — synthetic fixture', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'starlight-adapter-test-'));
    await fs.mkdir(path.join(tmp, 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'index.mdx'),
      `---\ntitle: Root\ndescription: Top-level index\n---\n\n## Hello\n\nbody\n`,
    );
    await fs.writeFile(
      path.join(tmp, 'sample-root-doc.mdx'),
      `---\ntitle: Agent Policies\n---\n\n## Rules\n\n## More rules\n`,
    );
    await fs.writeFile(
      path.join(tmp, 'agents', 'index.mdx'),
      `---\ntitle: Agents\ndescription: Section intro\n---\n\nintro\n`,
    );
    await fs.writeFile(
      path.join(tmp, 'agents', 'operator.mdx'),
      `---\ntitle: Operator agent\nsidebar:\n  order: 2\n---\n\n## Voice\n\n## Pi\n`,
    );
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('resolves an exact slug directly without walking the content tree', async () => {
    const readdir = vi.spyOn(fs, 'readdir');
    try {
      const src = starlightContentAdapter({ contentRoot: tmp, baseUrl: '/internal/docs' });
      const page = await src.getPageBySlug?.('agents/operator');
      expect(page).toMatchObject({
        slug: 'agents/operator',
        title: 'Operator agent',
        toc: [{ id: 'voice', text: 'Voice', depth: 2 }, { id: 'pi', text: 'Pi', depth: 2 }],
      });
      expect(await src.getContent(page!)).toContain('Voice');
      expect(await src.getSource?.(page!)).toContain('## Voice');
      expect(readdir).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
    }
  });

  it('reuses the parsed section index during outline construction', async () => {
    const readFile = vi.spyOn(fs, 'readFile');
    try {
      const src = starlightContentAdapter({ contentRoot: tmp, baseUrl: '/internal/docs' });
      const outline = await buildOutline(src);
      const agents = outline.sections.find((section) => section.slug === 'agents');
      expect(agents).toMatchObject({ title: 'Agents', description: 'Section intro' });
      // Four corpus files are read once by listPages; getSectionMeta reuses the
      // already parsed index page instead of reading agents/index.mdx again.
      expect(readFile).toHaveBeenCalledTimes(4);
    } finally {
      readFile.mockRestore();
    }
  });

  it('lists all pages with correct slugs and urls', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp, baseUrl: '/internal/docs' });
    const pages = await src.listPages();
    const bySlug = new Map(pages.map((p) => [p.slug, p]));
    expect(bySlug.has('')).toBe(true);
    expect(bySlug.has('sample-root-doc')).toBe(true);
    expect(bySlug.has('agents')).toBe(true);
    expect(bySlug.has('agents/operator')).toBe(true);
    expect(bySlug.size).toBe(4);

    expect(bySlug.get('')!.url).toBe('/internal/docs/');
    expect(bySlug.get('sample-root-doc')!.url).toBe('/internal/docs/sample-root-doc');
    expect(bySlug.get('agents')!.url).toBe('/internal/docs/agents');
    expect(bySlug.get('agents/operator')!.url).toBe('/internal/docs/agents/operator');
  });

  it('parses title and description from frontmatter', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const root = await src.getPage('');
    expect(root!.title).toBe('Root');
    expect(root!.description).toBe('Top-level index');

    const policies = await src.getPage('sample-root-doc');
    expect(policies!.title).toBe('Agent Policies');
    expect(policies!.description).toBeUndefined();
  });

  it('extracts headings into TOC', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const op = await src.getPage('agents/operator');
    expect(op!.toc).toEqual([
      { id: 'voice', text: 'Voice', depth: 2 },
      { id: 'pi', text: 'Pi', depth: 2 },
    ]);
  });

  it('returns section meta from <section>/index.mdx', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const meta = await src.getSectionMeta('agents');
    expect(meta).toEqual({ title: 'Agents', description: 'Section intro' });
  });

  it('returns getContent body without frontmatter', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const op = await src.getPage('agents/operator');
    const body = await src.getContent(op!);
    expect(body).not.toContain('---');
    expect(body).toContain('Voice');
  });

  it('invalidates cached metadata and rendered content after a projection write', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const file = path.join(tmp, 'agents', 'operator.mdx');
    const original = await fs.readFile(file, 'utf8');
    try {
      const before = await src.getPage('agents/operator');
      expect(before!.title).toBe('Operator agent');
      expect(await src.getContent(before!)).toContain('Voice');

      await fs.writeFile(
        file,
        `---\ntitle: Updated operator\n---\n\n## Changed\n\nnew body\n`,
        'utf8',
      );
      src.invalidate();

      const after = await src.getPage('agents/operator');
      expect(after!.title).toBe('Updated operator');
      expect(await src.getContent(after!)).toContain('Changed');
      expect(await src.getContent(after!)).not.toContain('Voice');
    } finally {
      await fs.writeFile(file, original, 'utf8');
      src.invalidate();
    }
  });

  it('a published content revision refreshes FAQ answers and the searchable page population', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'public-faq-revision-'));
    const file = path.join(root, 'faq.md');
    let revision = 'publication-1';
    const src = starlightContentAdapter({ contentRoot: root, baseUrl: '/docs', getRevision: () => revision });
    try {
      await fs.writeFile(file, '---\ntitle: Common questions\n---\n## Costs\nOld answer\n');
      const before = (await src.getPage('faq'))!;
      expect(before.url).toBe('/docs/faq');
      expect(await src.getContent(before)).toContain('Old answer');
      await fs.writeFile(file, '---\ntitle: Reviewed questions\n---\n## Costs\nRevised answer\n');
      await fs.writeFile(path.join(root, 'billing.md'), '# Billing\nNew guide');
      // Positive control: a stable published revision retains its cached snapshot.
      expect(await src.getContent(before)).toContain('Old answer');
      revision = 'publication-2';
      expect((await src.getPage('faq'))!.title).toBe('Reviewed questions');
      expect(await src.getContent(before)).toContain('Revised answer');
      expect(await src.getContent(before)).not.toContain('Old answer');
      expect((await src.listPages()).map((page) => page.slug)).toEqual(['billing', 'faq']);
      await fs.unlink(file);
      revision = 'publication-3';
      expect(await src.getPage('faq')).toBeNull();
      expect((await src.listPages()).map((page) => page.slug)).toEqual(['billing']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a cached answer when the published revision becomes unavailable', async () => {
    let unavailable = false;
    const src = starlightContentAdapter({
      contentRoot: tmp,
      getRevision: () => {
        if (unavailable) throw new Error('public revision unavailable');
        return 'publication-1';
      },
    });
    const before = (await src.getPage('agents/operator'))!;
    expect(await src.getContent(before)).toContain('Voice');
    unavailable = true;
    await expect(src.getContent(before)).rejects.toThrow('public revision unavailable');
  });

  /**
   * WI-1511581 — `getSource` is the authoring read: the file as it sits on disk.
   *
   * `getContent` is a lossy projection of it (frontmatter stripped, `.mdx` flattened
   * through remark), so a body sourced from `getContent` and written back corrupts
   * the doc. Every assertion here is byte-exact against the fixture, because a body
   * that is merely close is exactly the failure this closes.
   */
  describe('getSource', () => {
    const RAW = `---\ntitle: Source fidelity\ndescription: keep me\n---\n\nimport { Aside } from '@astrojs/starlight/components';\n\n## Head\n\n<Aside>kept verbatim</Aside>\n`;

    it('returns the file byte for byte — frontmatter, import and JSX intact', async () => {
      const file = path.join(tmp, 'source-fidelity.mdx');
      await fs.writeFile(file, RAW, 'utf8');
      const src = starlightContentAdapter({ name: 'fx-src', contentRoot: tmp, baseUrl: '/d' });

      const page = await src.getPage('source-fidelity');
      expect(page).not.toBeNull();
      expect(await src.getSource!(page!)).toBe(RAW);

      // CONTROL, against the REAL remark pipeline: the rendered read of the SAME
      // page loses the frontmatter and the JSX element. Without this pair, a
      // getSource that simply aliased getContent would look identical.
      const rendered = await src.getContent(page!);
      expect(rendered).not.toBe(RAW);
      expect(rendered).not.toContain('---\ntitle:'); // frontmatter gone
      expect(rendered).not.toContain('<Aside>'); // component rewritten away
      // …and the import it referenced SURVIVES, because nothing in the pass handles
      // `mdxjsEsm`. Written back, that is an import of a component the body no
      // longer contains — measured, not assumed, and the reason the prose around
      // this feature says "rewrites JSX" rather than "flattens imports".
      expect(rendered).toContain("import { Aside } from '@astrojs/starlight/components';");
    });

    it('re-reads the file rather than serving a cached body, so an authoring read is never stale', async () => {
      const file = path.join(tmp, 'source-refresh.mdx');
      await fs.writeFile(file, RAW, 'utf8');
      const src = starlightContentAdapter({ name: 'fx-src2', contentRoot: tmp, baseUrl: '/d' });
      const page = (await src.getPage('source-refresh'))!;
      expect(await src.getSource!(page)).toBe(RAW);

      const edited = RAW.replace('kept verbatim', 'edited by a peer');
      await fs.writeFile(file, edited, 'utf8');
      // Deliberately NO invalidate(): a stale hit here would hand an author bytes the
      // file no longer has, and their write would silently revert the peer.
      expect(await src.getSource!(page)).toBe(edited);
    });

    it('answers null — never the rendered body — for a page the source does not have', async () => {
      const src = starlightContentAdapter({ name: 'fx-src3', contentRoot: tmp, baseUrl: '/d' });
      const ghost = { slug: 'no/such-page', slugs: ['no', 'such-page'], url: '/d/no/such-page', title: 'x', toc: [] };
      expect(await src.getSource!(ghost)).toBeNull();
    });
  });
});

describe('starlightContentAdapter — real operator-docs tree', () => {
  it('discovers expected page count and known pages', async () => {
    // Skip if the operator-docs tree doesn't exist (e.g. running on a checkout where
    // the F1-F5 migration hasn't been done yet).
    try {
      await fs.access(OPERATOR_DOCS_ROOT);
    } catch {
      return;
    }

    const src = starlightContentAdapter({
      contentRoot: OPERATOR_DOCS_ROOT,
      baseUrl: '/internal/docs',
    });
    const pages = await src.listPages();

    // We copied 127 MDX files in F2; allow some drift but assert non-trivial floor.
    expect(pages.length).toBeGreaterThanOrEqual(100);

    const slugs = new Set(pages.map((p) => p.slug));
    expect(slugs.has('performance')).toBe(true); // a real root-level page
    expect(slugs.has('agents')).toBe(true); // agents/index.mdx
    expect(slugs.has('endpoint-system/overview')).toBe(true);

    const perf = await src.getPage('performance');
    expect(perf).not.toBeNull();
    expect(perf!.title.length).toBeGreaterThan(0);
    expect(perf!.url).toBe('/internal/docs/performance');
  });

  it('buildOutline runs against real tree without error', async () => {
    try {
      await fs.access(OPERATOR_DOCS_ROOT);
    } catch {
      return;
    }
    const src = starlightContentAdapter({
      contentRoot: OPERATOR_DOCS_ROOT,
      baseUrl: '/internal/docs',
    });
    const outline = await buildOutline(src, {});
    expect(outline.sectionCount).toBeGreaterThan(5);
    expect(outline.pageCount).toBeGreaterThan(100);
    expect(outline.sections.length).toBe(outline.sectionCount);
  });
});
