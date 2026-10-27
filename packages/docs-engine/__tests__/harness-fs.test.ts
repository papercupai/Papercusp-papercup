import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { harnessFsAdapter } from '../src/adapters/harness-fs';
import { genericFsAdapter } from '../src/adapters/generic-fs';
import { DOC_FILE_IO_BATCH_SIZE } from '../src/adapters/file-batches';
import type { DocSource } from '../src/types';

let tmpDir: string;

async function expectBoundedReads(root: string, createSource: () => DocSource): Promise<void> {
  const pagesRoot = path.join(root, 'pages');
  await fs.mkdir(pagesRoot, { recursive: true });
  const names = Array.from({ length: 40 }, (_, i) => `page-${String(i).padStart(2, '0')}.md`);
  await Promise.all(names.map((name) => fs.writeFile(path.join(pagesRoot, name), `# Title ${name}\n`)));
  const expected = new Map(names.map((name) => [`pages/${name.replace(/\.md$/, '')}`, `Title ${name}`]));
  const originalReadFile = fs.readFile.bind(fs);
  let reads = 0;
  let active = 0;
  let peak = 0;
  let releaseReads!: () => void;
  let signalOverlap!: () => void;
  const released = new Promise<void>((resolve) => { releaseReads = resolve; });
  const overlap = new Promise<void>((resolve) => { signalOverlap = resolve; });
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (!String(args[0]).startsWith(root + path.sep)) {
      return originalReadFile(...args as Parameters<typeof fs.readFile>);
    }
    reads += 1;
    active += 1;
    peak = Math.max(peak, active);
    if (reads === 2) signalOverlap();
    try {
      await released;
      return await originalReadFile(...args as Parameters<typeof fs.readFile>);
    } finally {
      active -= 1;
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listing = createSource().listPages();
    const overlapped = await Promise.race([
      overlap.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1500); }),
    ]);
    releaseReads();
    const pages = await listing;
    const matched = pages.filter((page) => expected.has(page.slug));

    expect(overlapped, 'a blocked file read must not serialize the corpus listing').toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(DOC_FILE_IO_BATCH_SIZE);
    expect(reads).toBe(names.length);
    expect(new Map(matched.map((page) => [page.slug, page.title]))).toEqual(expected);
  } finally {
    if (timer) clearTimeout(timer);
    releaseReads();
    vi.restoreAllMocks();
  }
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-fs-test-'));
  await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'docs', 'features'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, '.papercusp'), { recursive: true });

  await fs.writeFile(
    path.join(tmpDir, 'SPEC.md'),
    '# Spec\n\nThe spec for this harness.\n\n## Goal\n\nProject goal.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'AGENTS.md'),
    '# Agents\n\nAgent conventions.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, '.papercusp', 'knowledge.md'),
    '# Knowledge\n\nCurated notes.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'docs', 'architecture.md'),
    '# Architecture\n\nThe system layout.\n\n## Components\n\nList of components.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'docs', 'features', 'auth.md'),
    '# Auth\n\nAuthentication feature.\n',
    'utf-8',
  );
  // Should be ignored — dotfile dir
  await fs.mkdir(path.join(tmpDir, 'docs', '.hidden'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'docs', '.hidden', 'secret.md'), '# Secret\n', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('harnessFsAdapter', () => {
  it('lists docs/ pages + state files', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    const slugs = pages.map((p) => p.slug).sort();
    expect(slugs).toContain('harness-state/SPEC');
    expect(slugs).toContain('harness-state/AGENTS');
    expect(slugs).toContain('harness-state/knowledge');
    expect(slugs).toContain('docs/architecture');
    expect(slugs).toContain('docs/features/auth');
  });

  it('uses a declared docs root while keeping state files rooted at the project', async () => {
    const declaredRoot = path.join(tmpDir, 'apps', 'operator-docs', 'src', 'content', 'docs');
    await fs.mkdir(path.join(declaredRoot, 'agent-insights'), { recursive: true });
    await fs.writeFile(
      path.join(declaredRoot, 'agent-insights', 'runbook.mdx'),
      '---\ntitle: Runbook\n---\n# Runbook\n\nCanonical docs root.\n',
      'utf-8',
    );

    const adapter = harnessFsAdapter(tmpDir, { docsRoot: declaredRoot });
    const pages = await adapter.listPages();
    const slugs = pages.map((p) => p.slug);
    expect(slugs).toContain('agent-insights/runbook');
    expect(slugs).toContain('harness-state/SPEC');
    expect(slugs).not.toContain('docs/architecture');
    expect(await adapter.getPage('agent-insights/runbook')).toMatchObject({ title: 'Runbook' });
  });

  it('ignores dotfile directories under docs/', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    expect(pages.find((p) => p.slug.includes('hidden'))).toBeUndefined();
  });

  it('extracts h1 title and toc', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    const page = await adapter.getPage('docs/architecture');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Architecture');
    expect(page!.toc.map((h) => h.text)).toEqual(['Architecture', 'Components']);
  });

  it('getContent returns file body', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    const page = await adapter.getPage('harness-state/SPEC');
    expect(page).not.toBeNull();
    const content = await adapter.getContent(page!);
    expect(content).toContain('The spec for this harness.');
  });

  it('returns null for missing slug', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    expect(await adapter.getPage('nope/missing')).toBeNull();
  });

  it('section meta provides labels for synthetic sections', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    expect(await adapter.getSectionMeta!('harness-state')).toMatchObject({ title: 'Harness state' });
    expect(await adapter.getSectionMeta!('docs')).toMatchObject({ title: 'Project docs' });
  });

  it('integrates with buildOutline', async () => {
    const { buildOutline } = await import('../src/outline');
    const adapter = harnessFsAdapter(tmpDir);
    const metadata: Record<string, unknown>[] = [];
    const out = await buildOutline(adapter, { metadata: (event) => metadata.push(event) });
    expect(out.sectionCount).toBeGreaterThanOrEqual(2);
    const sec = out.sections.find((s) => s.slug === 'harness-state');
    expect(sec?.title).toBe('Harness state');
    expect(metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ docsListPagesTiming: expect.objectContaining({ component: 'harness-fs', phase: 'walk', state: 'completed' }) }),
      expect.objectContaining({ docsListPagesTiming: expect.objectContaining({ component: 'harness-fs', phase: 'read-parse', state: 'completed' }) }),
    ]));
  });

  it('bounds cold reads for harness and generic filesystem sources', async () => {
    const harnessProject = path.join(tmpDir, 'bounded-harness-project');
    const harnessDocs = path.join(harnessProject, 'docs');
    await expectBoundedReads(harnessDocs, () => harnessFsAdapter(harnessProject, { docsRoot: harnessDocs, stateFiles: [] }));

    const genericDocs = path.join(tmpDir, 'bounded-generic-docs');
    await expectBoundedReads(genericDocs, () => genericFsAdapter(genericDocs));
  });
});
