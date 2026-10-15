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
