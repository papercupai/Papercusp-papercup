import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractHeadings, genericFsAdapter } from '../src/adapters/generic-fs';
import { searchDocs } from '../src/search';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-fs-test-'));
  await fs.mkdir(path.join(tmpDir, 'guides'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'reference'), { recursive: true });

  await fs.writeFile(
    path.join(tmpDir, 'index.md'),
    '# My Project\n\nWelcome.\n\n## Getting started\n\nRun `npm install`.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'guides', 'auth.md'),
    '# Auth guide\n\nHow auth works.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'reference', 'api.mdx'),
    '# API reference\n\nEndpoints listed below.\n',
    'utf-8',
  );
  // Should be ignored — dotfile dir
  await fs.mkdir(path.join(tmpDir, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, '.hidden', 'secret.md'), '# Secret\n', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('extractHeadings', () => {
  it('ignores ATX-looking lines inside backtick and tilde fences', () => {
    const content = [
      '# Page',
      '## Introduction',
      '~~~bash',
      '## Fake tilde heading',
      '```',
      '# Still inside the tilde fence',
      '~~~~',
      '```js',
      '## Fake backtick heading',
      '```',
      '## Actual next section',
    ].join('\n');

    expect(extractHeadings(content)).toEqual([
      { id: 'Page', text: 'Page', depth: 1 },
      { id: 'Introduction', text: 'Introduction', depth: 2 },
      { id: 'Actual-next-section', text: 'Actual next section', depth: 2 },
    ]);
  });
});

describe('genericFsAdapter', () => {
  it('walks <root>/ directly (not <root>/docs/)', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    const slugs = pages.map((p) => p.slug).sort();
    expect(slugs).toEqual(['guides/auth', 'index', 'reference/api']);
  });

  it('skips dotfile directories', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    expect(pages.map((p) => p.slug)).not.toContain('.hidden/secret');
  });

  it('handles both .md and .mdx', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    const slugs = pages.map((p) => p.slug);
    expect(slugs).toContain('guides/auth'); // .md
    expect(slugs).toContain('reference/api'); // .mdx
  });

  it('extracts title from first h1', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const index = await adapter.getPage('index');
    expect(index?.title).toBe('My Project');
  });

  it('extracts TOC from headings', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const index = await adapter.getPage('index');
    expect(index?.toc.map((h) => h.text)).toEqual(['My Project', 'Getting started']);
  });

  it('serves raw markdown for .md', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const page = await adapter.getPage('guides/auth');
    expect(page).not.toBeNull();
    const content = await adapter.getContent(page!);
    expect(content).toContain('How auth works.');
  });

  it('renders .mdx to markdown', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const page = await adapter.getPage('reference/api');
    expect(page).not.toBeNull();
    const content = await adapter.getContent(page!);
    expect(content).toContain('Endpoints listed below.');
  });

  it('default name is `generic-fs:<basename>`', () => {
    const adapter = genericFsAdapter(tmpDir);
    expect(adapter.name).toBe(`generic-fs:${path.basename(tmpDir)}`);
  });

  it('honors opts.name', () => {
    const adapter = genericFsAdapter(tmpDir, { name: 'project' });
    expect(adapter.name).toBe('project');
  });

  it('url is empty string when no baseUrl given', async () => {
    const adapter = genericFsAdapter(tmpDir);
    const index = await adapter.getPage('index');
    expect(index?.url).toBe('');
  });

  it('url is `<baseUrl>/<slug>` when baseUrl given', async () => {
    const adapter = genericFsAdapter(tmpDir, { baseUrl: '/project-docs' });
    const index = await adapter.getPage('index');
    expect(index?.url).toBe('/project-docs/index');
  });

  it('returns null for unknown slug', async () => {
    const adapter = genericFsAdapter(tmpDir);
    expect(await adapter.getPage('does/not/exist')).toBeNull();
  });

  it('getSectionMeta returns empty (generic-fs has no section concept)', async () => {
    const adapter = genericFsAdapter(tmpDir);
    expect(await adapter.getSectionMeta?.('guides')).toEqual({});
  });
});

// EI-5856 / EI-5860 / EI-5861: docs:search returned a structural MDX error
// ("Expected a closing tag for `<owner>` (3:103-3:110)") because a real doc's
// frontmatter description held a BARE `<owner>` placeholder. genericFsAdapter
// renders the WHOLE raw .mdx (frontmatter NOT pre-stripped) through remark-mdx,
// which parses that description line as a paragraph with an unclosed JSX tag and
// THROWS — and because searchDocs renders every page in one Promise.all, a single
// bad doc unwound the entire search/outline for the corpus. This guards the FULL
// docs:search path (adapter → searchDocs), not just the render function: a
// malformed doc must degrade to a raw-text fallback so search still works.
describe('genericFsAdapter × searchDocs — EI-5856 malformed-doc resilience', () => {
  let badDir: string;

  beforeAll(async () => {
    badDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-fs-bad-'));
    // A well-formed sibling so the corpus isn't a single doc.
    await fs.writeFile(
      path.join(badDir, 'ok.mdx'),
      '# OK doc\n\nA perfectly ordinary quokka page.\n',
      'utf-8',
    );
    // The exact repro: a bare `<owner>` in the frontmatter description at line 3,
    // matching the reported (3:103) parse position. Body carries a unique keyword.
    await fs.writeFile(
      path.join(badDir, 'broken.mdx'),
      [
        '---',
        'title: Owner cursor doc',
        'description: Resume the coordination session keyed by the <owner> id so the fleet can find the persisted transcript later',
        '---',
        '',
        '# Owner cursor',
        '',
        'The coordination cursor lives in a per-owner marmoset file the fleet reads.',
      ].join('\n') + '\n',
      'utf-8',
    );
  });

  afterAll(async () => {
    await fs.rm(badDir, { recursive: true, force: true });
  });

  it('does not throw when a doc has a bare <owner> frontmatter placeholder', async () => {
    const adapter = genericFsAdapter(badDir);
    await expect(searchDocs(adapter, { query: 'quokka' })).resolves.toBeDefined();
  });

  it('keeps the malformed doc keyword-searchable via the raw-text fallback', async () => {
    const adapter = genericFsAdapter(badDir);
    const res = await searchDocs(adapter, { query: 'marmoset' });
    // The body keyword survived the fallback → the broken doc is still a hit.
    expect(res.hits.map((h) => h.slug)).toContain('broken');
  });

  it('still finds well-formed sibling docs despite the malformed one', async () => {
    const adapter = genericFsAdapter(badDir);
    const res = await searchDocs(adapter, { query: 'quokka' });
    expect(res.hits.map((h) => h.slug)).toContain('ok');
  });
});
