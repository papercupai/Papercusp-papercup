import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import type { SessionArchiveStore } from '../session-archive';
import { appendFileSync, constants as fsConstants, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCanonicalClaudeLiveJsonl, findCanonicalNativeLiveJsonl, readCanonicalNativeArchive, readStableLiveJsonl } from './source';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe('readStableLiveJsonl', () => {
  it('uses a fixed high-water and excludes the trailing partial record', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'port-source-')), 'session.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2');
    const source = await readStableLiveJsonl(path);
    expect(source.bytes.toString('utf8')).toBe('{"a":1}\n');
    expect(source.highWaterBytes).toBe(14);
    expect(source.completeBytes).toBe(8);
    expect(source.source).toBe('live-jsonl');
    const stat = statSync(path);
    expect(source.fileIdentity).toEqual({ path, device: stat.dev, inode: stat.ino, links: stat.nlink });
  });

  it('rejects before allocating beyond the configured cap', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'port-source-cap-')), 'session.jsonl');
    writeFileSync(path, '12345\n');
    await expect(readStableLiveJsonl(path, 5)).rejects.toThrow(/exceeds 5 byte cap/);
  });

  it.each(['append', 'replace'] as const)('D-017: keeps the opened source prefix when the path changes by %s after fstat', async (change) => {
    const root = mkdtempSync(join(tmpdir(), 'port-source-race-'));
    const path = join(root, 'session.jsonl');
    const original = Buffer.from('{"source":"original"}\n');
    const later = Buffer.from('{"later":"independent"}\n');
    writeFileSync(path, original);
    const before = statSync(path);
    const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    let capturedHandle: Awaited<ReturnType<typeof actualOpen>> | undefined;
    const open = vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (args[0] === path) {
        capturedHandle = handle;
        const actualStat = handle.stat.bind(handle);
        handle.stat = (async (...statArgs: Parameters<typeof actualStat>) => {
          const stat = await actualStat(...statArgs);
          // Change the actual filesystem only after the production descriptor's
          // high-water is measured; reads and close still use the real handle.
          if (change === 'append') appendFileSync(path, later);
          else {
            renameSync(path, join(root, 'retained-source.jsonl'));
            writeFileSync(path, later);
          }
          return stat;
        }) as typeof handle.stat;
      }
      return handle;
    });
    try {
      const source = await readStableLiveJsonl(path);
      expect(open).toHaveBeenCalledWith(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      expect(source.bytes).toEqual(original);
      expect(source.sha256).toBe(createHash('sha256').update(original).digest('hex'));
      expect(source.highWaterBytes).toBe(original.length);
      expect(source.completeBytes).toBe(original.length);
      expect(source.fileIdentity).toEqual({ path, device: before.dev, inode: before.ino, links: before.nlink });
      if (change === 'append') expect(readFileSync(path)).toEqual(Buffer.concat([original, later]));
      else {
        expect(statSync(path).ino).not.toBe(before.ino);
        expect(readFileSync(path)).toEqual(later);
        expect(readFileSync(join(root, 'retained-source.jsonl'))).toEqual(original);
      }
      expect(capturedHandle).toBeDefined();
      await expect(capturedHandle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    } finally {
      open.mockReset().mockImplementation(actualOpen);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('D-017: refuses a source path replaced by a symlink without modifying its target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-source-symlink-'));
    const path = join(root, 'session.jsonl');
    const target = join(root, 'independent.jsonl');
    const bytes = Buffer.from('{"independent":true}\n');
    writeFileSync(target, bytes);
    symlinkSync(target, path);
    const before = statSync(target);
    try {
      await expect(readStableLiveJsonl(path)).rejects.toMatchObject({ code: 'ELOOP' });
      expect(readFileSync(target)).toEqual(bytes);
      expect(statSync(target).ino).toBe(before.ino);
      expect(statSync(target).mtimeMs).toBe(before.mtimeMs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findCanonicalClaudeLiveJsonl', () => {
  it('selects exactly one regular project transcript and refuses ambiguity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-claude-'));
    mkdirSync(join(root, 'projects', 'cwd-a'), { recursive: true });
    writeFileSync(join(root, 'projects', 'cwd-a', 'sid.jsonl'), '{}\n');
    expect(await findCanonicalClaudeLiveJsonl(root, 'sid')).toBe(join(root, 'projects', 'cwd-a', 'sid.jsonl'));
    mkdirSync(join(root, 'projects', 'cwd-b'));
    writeFileSync(join(root, 'projects', 'cwd-b', 'sid.jsonl'), '{}\n');
    await expect(findCanonicalClaudeLiveJsonl(root, 'sid')).rejects.toThrow(/ambiguous/);
  });

  it('never traverses a symlinked project directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'port-claude-link-'));
    const foreign = mkdtempSync(join(tmpdir(), 'port-foreign-'));
    mkdirSync(join(root, 'projects'), { recursive: true });
    writeFileSync(join(foreign, 'sid.jsonl'), '{}\n');
    symlinkSync(foreign, join(root, 'projects', 'linked'));
    await expect(findCanonicalClaudeLiveJsonl(root, 'sid')).rejects.toThrow(/missing/);
  });
});

describe('exact native session-port sources', () => {
  it.each(['codex', 'omp'] as const)('validates the %s archive manifest and exact bytes before returning evidence', async (backend) => {
    const bytes = Buffer.from('{"native":"evidence"}\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const relpath = backend === 'codex' ? 'sessions/2026/10/03/rollout-date-native-id.jsonl' : 'cwd/date_native-id.jsonl';
    const manifest = { relpath, sha256, bytes_raw: bytes.length };
    const readStamp = vi.fn(async () => ({ manifest: [manifest] }));
    const readFiles = vi.fn(async () => [{ ...manifest, codec: 'zstd', blob: zstdCompressSync(bytes) }]);
    const store = { readStamp, readFiles } as unknown as SessionArchiveStore;
    const acquired = await readCanonicalNativeArchive({ backend, sessionId: 'native-id' }, store);
    expect(acquired.bytes).toEqual(bytes);
    expect(acquired.sha256).toBe(sha256);
    expect(acquired.relpath).toBe(relpath);
    expect(readStamp).toHaveBeenCalledWith(backend, 'native-id');
    expect(readFiles).toHaveBeenCalledWith(backend, 'native-id');
    readFiles.mockClear();
    await expect(readCanonicalNativeArchive({ backend, sessionId: 'native-id' }, store, bytes.length - 1)).rejects.toThrow(/byte cap/);
    expect(readFiles).not.toHaveBeenCalled();
    readFiles.mockImplementation(async () => [{ ...manifest, sha256: 'b'.repeat(64), codec: 'zstd', blob: zstdCompressSync(bytes) }]);
    await expect(readCanonicalNativeArchive({ backend, sessionId: 'native-id' }, store)).rejects.toThrow(/metadata mismatch/);
    readStamp.mockImplementation(async () => ({ manifest: [manifest, { ...manifest, relpath: relpath.replace('date', 'other-date') }] }));
    await expect(readCanonicalNativeArchive({ backend, sessionId: 'native-id' }, store)).rejects.toThrow(/ambiguous/);
  });

  it.each(['codex', 'omp'] as const)('reads only the exact %s id and rejects a second matching transcript', async (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'port-native-'));
    const dir = join(root, ...(backend === 'codex' ? ['2026', '10', '03'] : ['cwd-a']));
    mkdirSync(dir, { recursive: true });
    const name = backend === 'codex' ? 'rollout-date-native-id.jsonl' : 'date_native-id.jsonl';
    const path = join(dir, name);
    writeFileSync(path, '{}\n');
    writeFileSync(join(dir, backend === 'codex' ? 'rollout-newest-another-id.jsonl' : 'newest_another-id.jsonl'), '{}\n');
    expect(await findCanonicalNativeLiveJsonl(root, backend, 'native-id')).toBe(path);
    const second = join(root, ...(backend === 'codex' ? ['2026', '10', '04'] : ['cwd-b']));
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, name), '{}\n');
    await expect(findCanonicalNativeLiveJsonl(root, backend, 'native-id')).rejects.toThrow(/ambiguous/);
  });

  it.each(['codex', 'omp'] as const)('rejects symlinked %s roots and transcript files', async (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'port-native-link-'));
    const foreign = mkdtempSync(join(tmpdir(), 'port-native-foreign-'));
    const name = backend === 'codex' ? 'rollout-date-native-id.jsonl' : 'date_native-id.jsonl';
    writeFileSync(join(foreign, name), '{}\n');
    symlinkSync(foreign, join(root, 'linked'));
    symlinkSync(join(foreign, name), join(root, name));
    await expect(findCanonicalNativeLiveJsonl(root, backend, 'native-id')).rejects.toThrow(/missing/);
    await expect(findCanonicalNativeLiveJsonl(join(root, 'linked'), backend, 'native-id')).rejects.toThrow(/missing/);
  });
});
