import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensureFsMutexLockRoot, withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';

const mutexModule = fileURLToPath(new URL('../../../scripts/lib/fs-mutex.mjs', import.meta.url));

describe('mutex-root migration across native processes', () => {
  it('preserves quarantine evidence and excludes a native successor through the legacy alias', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mutex-migration-native-'));
    const legacyRoot = join(temp, 'legacy');
    const homeDir = join(temp, 'home');
    const staleLock = join(legacyRoot, 'old.lock');
    const evidence = 'stale owner bytes\n';
    const previous = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    await mkdir(staleLock, { recursive: true });
    await writeFile(join(staleLock, 'owner.json'), evidence);
    await utimes(staleLock, new Date(0), new Date(0));
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let writer: Promise<unknown> | undefined;
    try {
      const root = await ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot });
      expect(root).toBe(join(homeDir, '.papercusp', 'fs-mutex-locks'));
      expect(await realpath(legacyRoot)).toBe(await realpath(root));
      const quarantine = (await readdir(temp)).find(name => name.startsWith('legacy.legacy-'))!;
      expect(await readFile(join(temp, quarantine, 'old.lock', 'owner.json'), 'utf8')).toBe(evidence);
      process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = root;
      writer = withFsMutex('native-exclusion', async () => { entered(); await held; });
      await ready;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { withFsMutex } = await import(pathToFileURL(process.argv[1]));
        try {
          await withFsMutex('native-exclusion', async () => console.log('ENTERED'), { timeoutMs: 80, retryMs: 5 });
          process.exitCode = 2;
        } catch (error) {
          console.log(error.message.includes('waiting for fs-mutex') ? 'EXCLUDED' : 'UNEXPECTED');
        }
      `, mutexModule], { env: { ...process.env, PAPERCUSP_FS_MUTEX_LOCK_DIR: legacyRoot }, encoding: 'utf8', timeout: 5_000 });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('EXCLUDED');
    } finally {
      release();
      await writer;
      if (previous === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previous;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('does not cut over active or unknown legacy owners', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mutex-migration-owner-'));
    try {
      for (const ownerHost of [hostname(), hostname() + '-unknown']) {
        const legacyRoot = join(temp, ownerHost === hostname() ? 'active' : 'unknown');
        const homeDir = join(legacyRoot, 'home');
        const marker = join(legacyRoot, 'install.lock');
        const evidence = JSON.stringify({ pid: process.pid, host: ownerHost });
        await mkdir(marker, { recursive: true });
        await writeFile(join(marker, 'owner.json'), evidence);
        const result = ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot });
        if (ownerHost === hostname()) await expect(result).resolves.toBe(legacyRoot);
        else await expect(result).rejects.toHaveProperty('code', 'ELEGACYFSLOCKBUSY');
        expect((await lstat(legacyRoot)).isDirectory()).toBe(true);
        expect(await readFile(join(marker, 'owner.json'), 'utf8')).toBe(evidence);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('treats an orphaned empty reader-staging dir as a reader container, not an unknown owner', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mutex-migration-staging-'));
    try {
      const legacyRoot = join(temp, 'legacy');
      await mkdir(join(legacyRoot, 'npm-install-abc.readers'), { recursive: true });
      await mkdir(join(legacyRoot, 'npm-install-abc.readers-staging'), { recursive: true });
      await expect(ensureFsMutexLockRoot({}, { platform: 'linux', homeDir: join(temp, 'home'), legacyRoot }))
        .resolves.toEqual(expect.any(String));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails closed on a genuinely unreadable legacy directory', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mutex-migration-permissions-'));
    const legacyRoot = join(temp, 'legacy');
    await mkdir(legacyRoot);
    await chmod(legacyRoot, 0);
    try {
      await expect(ensureFsMutexLockRoot({}, { platform: 'linux', homeDir: join(temp, 'home'), legacyRoot }))
        .rejects.toMatchObject({ code: 'ELEGACYFSLOCKBUSY', census: { complete: false } });
      expect((await lstat(legacyRoot)).isSymbolicLink()).toBe(false);
    } finally {
      await chmod(legacyRoot, 0o700);
      await rm(temp, { recursive: true, force: true });
    }
  });
});
