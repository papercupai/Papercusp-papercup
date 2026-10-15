import { describe, it, expect, vi } from 'vitest';
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  stat,
  readFile,
  readdir,
  symlink,
} from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import {
  extractDevSourceTree,
  hasPapercupMarkers,
  escapingLinkIgnore,
  SOURCE_ARCHIVE_STAMP_BASENAME,
} from './dev-source-extract';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'devsrc-'));
}
async function writeMarkers(root: string): Promise<void> {
  await mkdir(join(root, 'apps', 'operator'), { recursive: true });
  await mkdir(join(root, 'libs', 'papercusp'), { recursive: true });
  await writeFile(join(root, 'apps', 'operator', 'package.json'), '{}');
  await writeFile(join(root, 'libs', 'papercusp', 'package.json'), '{}');
}
/** Stamp the tree as having come from EXACTLY this archive (WI-5052). */
async function writeMatchingStamp(
  archive: string,
  root: string,
): Promise<void> {
  const s = await stat(archive);
  await writeFile(
    join(root, SOURCE_ARCHIVE_STAMP_BASENAME),
    JSON.stringify({ size: s.size, mtimeMs: Math.floor(s.mtimeMs) }),
    'utf8',
  );
}

const makeDecompress = () => new PassThrough();
// a fake tar-extract sink that writes the markers on successful completion
const makeFakeExtractSuccess = (targetDir: string) => () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
    final(cb) {
      writeMarkers(targetDir).then(() => cb(), cb);
    },
  });
const makeFakeExtractFail = () => () =>
  new Writable({
    write(_c, _e, cb) {
      cb(new Error('boom'));
    },
  });

describe('extractDevSourceTree', () => {
  it('no-ops when archivePath is undefined', async () => {
    const t = await tmp();
    expect(
      await extractDevSourceTree({
        archivePath: undefined,
        targetDir: join(t, 'out'),
      }),
    ).toBeNull();
    await rm(t, { recursive: true, force: true });
  });

  it('no-ops when the archive file is absent', async () => {
    const t = await tmp();
    expect(
      await extractDevSourceTree({
        archivePath: join(t, 'nope.tar.zst'),
        targetDir: join(t, 'out'),
      }),
    ).toBeNull();
    await rm(t, { recursive: true, force: true });
  });

  it('reuses an already-extracted tree whose stamp matches the bundle (same-bundle reinstall)', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x');
    const target = join(t, 'out');
    await writeMarkers(target);
    await writeMatchingStamp(archive, target);
    const makeExtract = vi.fn(makeFakeExtractSuccess(target));
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract,
    });
    expect(r).toBe(target);
    expect(makeExtract).not.toHaveBeenCalled();
    await rm(t, { recursive: true, force: true });
  });

  it('re-extracts a LEGACY (unstamped) tree once and stamps it (WI-5052 upgrade)', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(500));
    const target = join(t, 'out');
    await writeMarkers(target);
    const sentinel = join(target, 'stale-old-code.txt');
    await writeFile(sentinel, 'week-old code');
    const makeExtract = vi.fn(makeFakeExtractSuccess(target));
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract,
    });
    expect(r).toBe(target);
    expect(makeExtract).toHaveBeenCalledTimes(1);
    // the stale tree was moved aside — its content must NOT survive into the new tree
    expect(existsSync(sentinel)).toBe(false);
    expect(hasPapercupMarkers(target)).toBe(true);
    const stamp = JSON.parse(
      await readFile(join(target, SOURCE_ARCHIVE_STAMP_BASENAME), 'utf8'),
    ) as { size: number };
    expect(stamp.size).toBe(500);
    await rm(t, { recursive: true, force: true });
  });

  it('re-extracts when the stamp differs from the shipped bundle (app was updated)', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(700));
    const target = join(t, 'out');
    await writeMarkers(target);
    await writeFile(
      join(target, SOURCE_ARCHIVE_STAMP_BASENAME),
      JSON.stringify({ size: 1, mtimeMs: 1 }),
      'utf8',
    );
    const makeExtract = vi.fn(makeFakeExtractSuccess(target));
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract,
    });
    expect(r).toBe(target);
    expect(makeExtract).toHaveBeenCalledTimes(1);
    await rm(t, { recursive: true, force: true });
  });

  it('restores the previous tree when the upgrade extract fails (non-fatal rollback)', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(900));
    const target = join(t, 'out');
    await writeMarkers(target);
    const sentinel = join(target, 'stale-old-code.txt');
    await writeFile(sentinel, 'week-old code');
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract: makeFakeExtractFail(),
    });
    // the OLD tree is back in place and returned (degraded-but-working)
    expect(r).toBe(target);
    expect(existsSync(sentinel)).toBe(true);
    expect(hasPapercupMarkers(target)).toBe(true);
    await rm(t, { recursive: true, force: true });
  });

  it('extracts + returns the root when the archive is present and markers are absent', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(1000));
    const target = join(t, 'out');
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract: makeFakeExtractSuccess(target),
    });
    expect(r).toBe(target);
    expect(hasPapercupMarkers(target)).toBe(true);
    await rm(t, { recursive: true, force: true });
  });

  it('returns null (non-fatal) when the extraction stream fails', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(1000));
    const target = join(t, 'out');
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract: makeFakeExtractFail(),
    });
    expect(r).toBeNull();
    await rm(t, { recursive: true, force: true });
  });

  it('returns null when extraction completes but the markers are missing (half-extracted)', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(1000));
    const target = join(t, 'out');
    const noMarkerSink = () =>
      new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract: noMarkerSink,
    });
    expect(r).toBeNull();
    await rm(t, { recursive: true, force: true });
  });

  it('retires interrupted upgrade backups before reusing a completed tree, preserving unrelated paths', async () => {
    const t = await tmp();
    try {
      const archive = join(t, 'source.tar.zst');
      const target = join(t, 'out');
      await writeFile(archive, 'new bundle');
      await writeMarkers(target);
      await writeMatchingStamp(archive, target);
      await mkdir(`${target}.stale-123`);
      await writeFile(join(`${target}.stale-123`, 'old.txt'), 'old source');
      await mkdir(`${target}.stale-notes`);
      const outside = join(t, 'user-tree');
      await mkdir(outside);
      await symlink(outside, `${target}.stale-456`, 'dir');
      const makeExtract = vi.fn(makeFakeExtractSuccess(target));
      expect(
        await extractDevSourceTree({
          archivePath: archive,
          targetDir: target,
          makeDecompress,
          makeExtract,
        }),
      ).toBe(target);
      expect(makeExtract).not.toHaveBeenCalled();
      expect(existsSync(`${target}.stale-123`)).toBe(false);
      expect(existsSync(`${target}.stale-notes`)).toBe(true);
      expect(existsSync(`${target}.stale-456`)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      await rm(t, { recursive: true, force: true });
    }
  });

  it.each([
    ['directory', false],
    ['file', false],
    ['directory', true],
    ['file', true],
  ] as const)(
    'preserves a source checkout with a .git %s and abandoned cache=%s',
    async (gitKind, withAbandoned) => {
      const t = await tmp();
      try {
        const archive = join(t, 'source.tar.zst');
        const target = join(t, 'out');
        await writeFile(archive, 'new bundle');
        await writeMarkers(target);
        if (gitKind === 'directory') await mkdir(join(target, '.git'));
        else await writeFile(join(target, '.git'), 'gitdir: /preserved/repository');
        await writeFile(join(target, 'uncommitted.txt'), 'peer work');
        if (withAbandoned) await writeMarkers(`${target}.stale-100`);
        const makeExtract = vi.fn(makeFakeExtractSuccess(target));
        expect(
          await extractDevSourceTree({
            archivePath: archive,
            targetDir: target,
            makeDecompress,
            makeExtract,
          }),
        ).toBe(target);
        expect(makeExtract).not.toHaveBeenCalled();
        expect(await readFile(join(target, 'uncommitted.txt'), 'utf8')).toBe('peer work');
        expect(existsSync(join(target, '.git'))).toBe(true);
      } finally {
        await rm(t, { recursive: true, force: true });
      }
    },
  );

  it('preserves a numeric stale sibling that is itself a source checkout', async () => {
    const t = await tmp();
    try {
      const archive = join(t, 'source.tar.zst');
      const target = join(t, 'out');
      const checkout = `${target}.stale-100`;
      await writeFile(archive, 'bundle');
      await writeMarkers(target);
      await writeMatchingStamp(archive, target);
      await writeMarkers(checkout);
      await mkdir(join(checkout, '.git'));
      await writeFile(join(checkout, 'uncommitted.txt'), 'peer work');
      expect(
        await extractDevSourceTree({ archivePath: archive, targetDir: target }),
      ).toBe(target);
      expect(await readFile(join(checkout, 'uncommitted.txt'), 'utf8')).toBe('peer work');
      expect(existsSync(join(checkout, '.git'))).toBe(true);
    } finally {
      await rm(t, { recursive: true, force: true });
    }
  });

  it('repairs an interrupted cache with real bundled Zstandard/tar extraction and preserves portable toolchain links', async () => {
    const t = await tmp();
    try {
      const archive = join(t, 'source.tar.zst');
      const input = join(t, 'input');
      const target = join(t, 'out');
      const backup = `${target}.stale-100`;
      await writeMarkers(input);
      await mkdir(join(input, 'node_modules', '.bin'), { recursive: true });
      await mkdir(join(input, 'node_modules', 'tool'), { recursive: true });
      await writeFile(join(input, 'node_modules', 'tool', 'cli.js'), 'bundled tool');
      await symlink('../tool/cli.js', join(input, 'node_modules', '.bin', 'tool'));
      const tar = createRequire(import.meta.url)('tar-fs') as {
        pack: (directory: string) => Readable;
      };
      await pipeline(tar.pack(input), createZstdCompress(), createWriteStream(archive));
      await writeMarkers(target);
      await writeFile(join(target, 'partial.txt'), 'interrupted');
      await writeMarkers(backup);
      await writeFile(
        join(backup, SOURCE_ARCHIVE_STAMP_BASENAME),
        JSON.stringify({ size: 1, mtimeMs: 1 }),
      );
      expect(
        await extractDevSourceTree({ archivePath: archive, targetDir: target }),
      ).toBe(target);
      expect(await readFile(join(target, 'node_modules', '.bin', 'tool'), 'utf8')).toBe('bundled tool');
      expect(existsSync(join(target, 'partial.txt'))).toBe(false);
      expect(existsSync(backup)).toBe(false);
      const stamp = JSON.parse(await readFile(join(target, SOURCE_ARCHIVE_STAMP_BASENAME), 'utf8'));
      expect(stamp.size).toBe((await stat(archive)).size);
    } finally {
      await rm(t, { recursive: true, force: true });
    }
  });

  it('recovers the newest completed rollback tree after interruption before retrying an upgrade', async () => {
    const t = await tmp();
    try {
      const archive = join(t, 'source.tar.zst');
      const target = join(t, 'out');
      await writeFile(archive, 'new bundle');
      // Markers can arrive early in an interrupted tar stream; only its final stamp proves completion.
      await writeMarkers(target);
      await writeFile(join(target, 'partial.txt'), 'incomplete');
      for (const suffix of ['100', '200']) {
        const backup = `${target}.stale-${suffix}`;
        await writeMarkers(backup);
        await writeFile(
          join(backup, SOURCE_ARCHIVE_STAMP_BASENAME),
          JSON.stringify({ size: 1, mtimeMs: 1 }),
        );
        await writeFile(join(backup, 'previous.txt'), suffix);
      }
      const result = await extractDevSourceTree({
        archivePath: archive,
        targetDir: target,
        makeDecompress,
        makeExtract: makeFakeExtractFail(),
      });
      expect(result).toBe(target);
      expect(await readFile(join(target, 'previous.txt'), 'utf8')).toBe('200');
      expect(existsSync(join(target, 'partial.txt'))).toBe(false);
      expect(
        (await readdir(t)).filter((name) => /^out\.stale-\d+$/.test(name)),
      ).toEqual([]);
    } finally {
      await rm(t, { recursive: true, force: true });
    }
  });

  it('does not accumulate uncompleted caches across interrupted-upgrade retries', async () => {
    const t = await tmp();
    try {
      const archive = join(t, 'source.tar.zst');
      const target = join(t, 'out');
      await writeFile(archive, 'bundle');
      await writeMarkers(target);
      await writeFile(join(target, 'partial.txt'), 'partial');
      await writeMarkers(`${target}.stale-100`);
      expect(
        await extractDevSourceTree({
          archivePath: archive,
          targetDir: target,
          makeDecompress,
          makeExtract: makeFakeExtractFail(),
        }),
      ).toBeNull();
      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}.stale-100`)).toBe(false);
      expect(
        await extractDevSourceTree({
          archivePath: archive,
          targetDir: target,
          makeDecompress,
          makeExtract: makeFakeExtractSuccess(target),
        }),
      ).toBe(target);
      expect(existsSync(join(target, 'partial.txt'))).toBe(false);
      expect(
        (await readdir(t)).filter((name) => /^out\.stale-\d+$/.test(name)),
      ).toEqual([]);
    } finally {
      await rm(t, { recursive: true, force: true });
    }
  });

  it('removes first-boot partial trees even when the failed stream already wrote markers', async () => {
    const t = await tmp();
    try {
      const archive = join(t, 'source.tar.zst');
      const target = join(t, 'out');
      await writeFile(archive, 'bundle');
      const makeExtract = () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            writeMarkers(target).then(
              () => callback(new Error('interrupted')),
              callback,
            );
          },
        });
      expect(
        await extractDevSourceTree({
          archivePath: archive,
          targetDir: target,
          makeDecompress,
          makeExtract,
        }),
      ).toBeNull();
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(t, { recursive: true, force: true });
    }
  });

  it('serializes concurrent sidecars so one cannot delete another live extraction', async () => {
    const t = await tmp();
    let release!: () => void;
    try {
      const archive = join(t, 'source.tar.zst');
      const target = join(t, 'out');
      await writeFile(archive, 'bundle');
      let started!: () => void;
      const ready = new Promise<void>((resolveReady) => {
        started = resolveReady;
      });
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const makeExtract = vi.fn(
        () =>
          new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
            final(callback) {
              started();
              gate
                .then(() => writeMarkers(target))
                .then(() => callback(), callback);
            },
          }),
      );
      const first = extractDevSourceTree({
        archivePath: archive,
        targetDir: target,
        makeDecompress,
        makeExtract,
      });
      await ready;
      const second = extractDevSourceTree({
        archivePath: archive,
        targetDir: target,
        makeDecompress,
        makeExtract,
      });
      release();
      expect(await Promise.all([first, second])).toEqual([target, target]);
      expect(makeExtract).toHaveBeenCalledTimes(1);
      expect(hasPapercupMarkers(target)).toBe(true);
    } finally {
      release?.();
      await rm(t, { recursive: true, force: true });
    }
  });

  it('treats a failed completion-stamp write as failed extraction and restores the previous tree', async () => {
    const t = await tmp();
    try {
      const archive = join(t, 'source.tar.zst');
      const target = join(t, 'out');
      await writeFile(archive, 'bundle');
      await writeMarkers(target);
      await writeFile(join(target, 'previous.txt'), 'previous');
      const makeExtract = () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
          final(callback) {
            writeMarkers(target)
              .then(() => mkdir(join(target, SOURCE_ARCHIVE_STAMP_BASENAME)))
              .then(() => callback(), callback);
          },
        });
      expect(
        await extractDevSourceTree({
          archivePath: archive,
          targetDir: target,
          makeDecompress,
          makeExtract,
        }),
      ).toBe(target);
      expect(await readFile(join(target, 'previous.txt'), 'utf8')).toBe(
        'previous',
      );
      expect(
        (await readdir(t)).filter((name) => /^out\.stale-\d+$/.test(name)),
      ).toEqual([]);
    } finally {
      await rm(t, { recursive: true, force: true });
    }
  });
});

describe('escapingLinkIgnore', () => {
  const root = '/x/dev-source';
  const nm = join(root, 'node_modules');

  it('keeps a non-link entry (file/directory)', () => {
    const ig = escapingLinkIgnore(root);
    expect(ig(join(root, 'apps/operator/index.ts'), { type: 'file' })).toBe(
      false,
    );
    expect(ig(join(root, 'apps'), { type: 'directory' })).toBe(false);
    // a header without a type (defensive) is also kept
    expect(ig(join(root, 'x'), {})).toBe(false);
    expect(ig(join(root, 'x'))).toBe(false);
  });

  it('keeps an in-tree relative symlink (npm workspace / .bin link)', () => {
    const ig = escapingLinkIgnore(root);
    // node_modules/.bin/tsx -> ../tsx/dist/cli.mjs  (stays inside root)
    expect(
      ig(join(nm, '.bin/tsx'), {
        type: 'symlink',
        linkname: '../tsx/dist/cli.mjs',
      }),
    ).toBe(false);
    // node_modules/@papercusp/foo -> ../../packages/foo (still inside root)
    expect(
      ig(join(nm, '@papercusp/foo'), {
        type: 'symlink',
        linkname: '../../packages/foo',
      }),
    ).toBe(false);
  });

  it('skips an out-of-tree relative symlink (the storewolf-libs class) and reports it', () => {
    const skips: Array<[string, string]> = [];
    const ig = escapingLinkIgnore(root, (n, l) => skips.push([n, l]));
    const name = join(nm, 'storewolf-libs');
    // ../../Storewolf-Libs from node_modules escapes above root
    expect(
      ig(name, { type: 'symlink', linkname: '../../Storewolf-Libs' }),
    ).toBe(true);
    expect(skips).toEqual([[name, '../../Storewolf-Libs']]);
  });

  it('skips a symlink with an absolute out-of-tree target', () => {
    const ig = escapingLinkIgnore(root);
    expect(
      ig(join(nm, 'weird'), {
        type: 'symlink',
        linkname: '/home/dev/Elsewhere',
      }),
    ).toBe(true);
  });

  it('skips an out-of-tree hardlink but keeps an in-tree one', () => {
    const ig = escapingLinkIgnore(root);
    // hardlink target is joined from the extraction root
    expect(
      ig(join(root, 'a'), { type: 'link', linkname: 'libs/papercusp/x' }),
    ).toBe(false);
    expect(
      ig(join(root, 'a'), { type: 'link', linkname: '../outside/x' }),
    ).toBe(true);
  });
});
