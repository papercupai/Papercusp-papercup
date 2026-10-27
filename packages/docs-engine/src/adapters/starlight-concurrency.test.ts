import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { starlightContentAdapter } from './starlight';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('starlightContentAdapter concurrent cold reads', () => {
  it('overlaps bounded metadata reads and preserves source order when one file is unreadable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starlight-list-concurrency-'));
    roots.push(root);
    const names = Array.from({ length: 40 }, (_, i) => `page-${String(i).padStart(2, '0')}.md`);
    await Promise.all(names.map((name) => fs.writeFile(path.join(root, name),
      `---\ntitle: Title ${name}\n---\n# Heading ${name}\n`)));
    const unreadable = 'page-04.md';
    const expected = (await fs.readdir(root)).filter((name) => name !== unreadable);
    const originalReadFile = fs.readFile.bind(fs);
    let releaseReads!: () => void;
    let signalOverlap!: () => void;
    const released = new Promise<void>((resolve) => { releaseReads = resolve; });
    const overlap = new Promise<void>((resolve) => { signalOverlap = resolve; });
    let reads = 0;
    let active = 0;
    let peak = 0;
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
        if (path.basename(String(args[0])) === unreadable) throw new Error('fixture read denied');
        return await originalReadFile(...args as Parameters<typeof fs.readFile>);
      } finally { active -= 1; }
    });
    const listing = starlightContentAdapter({ contentRoot: root }).listPages();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let overlapped: boolean;
    try {
      overlapped = await Promise.race([
        overlap.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1500); }),
      ]);
    } finally { clearTimeout(timer); releaseReads(); }
    const pages = await listing;

    expect(overlapped, 'a blocked first file must not serialize the entire corpus').toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
    expect(reads).toBe(names.length);
    expect(pages.map((page) => page.slug)).toEqual(expected.map((name) => name.replace(/\.md$/, '')));
    expect(pages.map((page) => page.title)).toEqual(expected.map((name) => `Title ${name}`));
  });

  it('reports cold listing subphases without exposing file paths or content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starlight-timing-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n\nprivate body');
    const adapter = starlightContentAdapter({ contentRoot: root });
    const events: unknown[] = [];

    const pages = await adapter.listPages({ onTiming: (event) => events.push(event) });

    expect(pages).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'starlight', phase: 'walk', state: 'completed', count: 1 }),
      expect.objectContaining({ component: 'starlight', phase: 'read-parse', state: 'completed', count: 1 }),
      expect.objectContaining({ component: 'starlight', phase: 'build', state: 'completed', count: 1 }),
    ]));
    expect(JSON.stringify(events)).not.toContain('private body');
    expect(JSON.stringify(events)).not.toContain(root);
  });

  it('shares one in-flight content read across concurrent searches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starlight-concurrency-'));
    roots.push(root);
    const file = path.join(root, 'guide.md');
    await fs.writeFile(file, '# Guide\n\nneedle');
    const adapter = starlightContentAdapter({ contentRoot: root });
    const [page] = await adapter.listPages();

    const originalReadFile = fs.readFile.bind(fs);
    let contentReads = 0;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]) === file) contentReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalReadFile(...args as Parameters<typeof fs.readFile>);
    });

    const bodies = await Promise.all(Array.from({ length: 8 }, () => adapter.getContent(page)));
    expect(new Set(bodies)).toEqual(new Set(['# Guide\n\nneedle']));
    expect(contentReads).toBe(1);
  });

  it('does not cancel a shared content read while another reader still needs it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starlight-cancel-'));
    roots.push(root);
    const file = path.join(root, 'guide.md');
    await fs.writeFile(file, '# Guide\n\nshared body');
    const adapter = starlightContentAdapter({ contentRoot: root });
    const [page] = await adapter.listPages();

    const originalReadFile = fs.readFile.bind(fs);
    let contentReads = 0;
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]) === file) {
        contentReads += 1;
        signalReadStarted();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReadFile(...args as Parameters<typeof fs.readFile>);
    });

    const controller = new AbortController();
    const cancelled = adapter.getContent(page, { signal: controller.signal });
    const live = adapter.getContent(page);
    await readStarted;
    expect(contentReads).toBe(1);

    controller.abort();
    await expect(cancelled).rejects.toThrow('cancelled');
    await expect(live).resolves.toBe('# Guide\n\nshared body');
    expect(contentReads).toBe(1);
  });
});
