import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createAsyncAtomicFileWriter } from './psu-pty-host.mjs';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('discovery persistence while filesystem metadata is stalled', () => {
  it('keeps input/timers moving and retains only the newest queued snapshot', async () => {
    const blocked = deferred();
    const enteredRename = deferred();
    const writes: string[] = [];
    const rename = vi.fn(async () => { enteredRename.release(); await blocked.promise; });
    const writer = createAsyncAtomicFileWriter({
      path: '/isolated/host.json', tempPath: '/isolated/host.tmp',
      writeFile: async (_path: string, bytes: string) => { writes.push(bytes); }, rename,
    });
    writer.write('first');
    await enteredRename.promise;
    for (let i = 0; i < 1000; i++) writer.write(String(i));
    let inputHandled = false;
    await new Promise<void>((resolve) => setImmediate(() => { inputHandled = true; resolve(); }));
    expect(inputHandled).toBe(true);
    expect(writes).toEqual(['first']);
    blocked.release();
    await writer.whenIdle();
    expect(writes).toEqual(['first', '999']);
    expect(rename).toHaveBeenCalledTimes(2);
    await writer.close();
  });

  it('waits for an atomic publication before removing the discovery key on close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'psu-discovery-async-'));
    const path = join(dir, 'host.json');
    const blocked = deferred();
    const enteredRename = deferred();
    const writer = createAsyncAtomicFileWriter({
      path, tempPath: join(dir, 'host.tmp'),
      rename: async () => { enteredRename.release(); await blocked.promise; await writeFile(path, 'published'); },
    });
    try {
      writer.write('first');
      await enteredRename.promise;
      writer.write('discard-on-close');
      let closed = false;
      const closing = writer.close().then(() => { closed = true; });
      expect(writer.write('after-close')).toBe(false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      blocked.release();
      await closing;
      expect(await readFile(path, 'utf8')).toBe('published');
      await rm(path);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      blocked.release();
      await writer.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an I/O failure and can publish the next snapshot', async () => {
    const failure = new Error('filesystem failure');
    const onError = vi.fn();
    const rename = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const writer = createAsyncAtomicFileWriter({
      path: '/isolated/host.json', tempPath: '/isolated/host.tmp',
      writeFile: async () => {}, rename, onError,
    });
    writer.write('first');
    await writer.whenIdle();
    expect(onError).toHaveBeenCalledWith(failure);
    writer.write('second');
    await writer.close();
    expect(rename).toHaveBeenCalledTimes(2);
  });
});
