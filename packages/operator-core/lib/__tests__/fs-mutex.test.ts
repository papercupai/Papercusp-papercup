import { lstat, mkdir, mkdtemp, opendir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The production entrypoint deliberately stays executable by plain Node (no build step —
// consumed directly by `node scripts/npm-install-safe.mjs`). Mirrors the suppression-comment
// convention test-file-router.test.ts already uses for the sibling .mjs CLI import.
import {
  withFsMutex,
  withFsMutexRead,
  peekFsMutexSync,
  resolveFsMutexLockRoot,
  ensureFsMutexLockRoot,
  censusLegacyFsMutexRoot,
} from '../../../../scripts/lib/fs-mutex.mjs';

const originalDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;

afterEach(async () => {
  if (originalDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = originalDir;
  delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
});

describe('resolveFsMutexLockRoot', () => {
  it('keeps one account-home POSIX lock root when callers carry different TMPDIR values', () => {
    const withoutTmpOverride = resolveFsMutexLockRoot({}, { platform: 'linux', homeDir: '/unused' });
    const withPapercuspTmp = resolveFsMutexLockRoot(
      { TMPDIR: '/tmp/pcv' },
      { platform: 'linux', homeDir: '/unused' },
    );

    expect(withoutTmpOverride).toBe('/unused/.papercusp/fs-mutex-locks');
    expect(withPapercuspTmp).toBe(withoutTmpOverride);
  });

  it('preserves the explicit lock-root override on every platform', () => {
    expect(
      resolveFsMutexLockRoot(
        { PAPERCUSP_FS_MUTEX_LOCK_DIR: '/operator/serialized-locks', TMPDIR: '/different/tmp' },
        { platform: 'linux', homeDir: '/unused' },
      ),
    ).toBe('/operator/serialized-locks');
  });

  it('uses a per-call lock root and keeps the process-wide override authoritative', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-per-call-root-'));
    const perCallRoot = join(temp, 'runtime-locks');
    const explicitRoot = join(temp, 'operator-locks');
    delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    try {
      await expect(withFsMutex('per-call-root', async () => 'runtime', {
        lockRootDir: perCallRoot,
        timeoutMs: 1_000,
        retryMs: 5,
      })).resolves.toBe('runtime');
      await expect(readdir(perCallRoot)).resolves.toContain('per-call-root.queue');

      process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = explicitRoot;
      await expect(withFsMutex('override-root', async () => 'explicit', {
        lockRootDir: perCallRoot,
        timeoutMs: 1_000,
        retryMs: 5,
      })).resolves.toBe('explicit');
      await expect(readdir(explicitRoot)).resolves.toContain('override-root.queue');
      await expect(readdir(perCallRoot)).resolves.toContain('per-call-root.queue');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('accepts a legacy symlink to the OS account root when HOME is private and there is no lock-root override', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-private-home-'));
    const privateHome = join(temp, 'private-home');
    const accountHome = join(temp, 'account-home');
    const accountRoot = join(accountHome, '.papercusp', 'fs-mutex-locks');
    const legacyRoot = join(temp, 'legacy', 'fs-mutex-locks');
    const phaseTimingsMs: Record<string, number> = {};
    const originalHome = process.env.HOME;

    await mkdir(privateHome, { recursive: true });
    await mkdir(accountRoot, { recursive: true });
    await mkdir(join(temp, 'legacy'), { recursive: true });
    await symlink(accountRoot, legacyRoot);
    process.env.HOME = privateHome;
    delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    try {
      await expect(ensureFsMutexLockRoot(undefined, {
        platform: 'linux', homeDir: accountHome, legacyRoot, phaseTimingsMs,
      }))
        .resolves.toBe(accountRoot);
      expect(phaseTimingsMs).toEqual(expect.objectContaining({
        'lock-root.legacy-lstat': expect.any(Number),
        'lock-root.legacy-alias-check': expect.any(Number),
        'lock-root.mkdir': expect.any(Number),
      }));
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('reuses a successful production lock-root resolution instead of redoing filesystem setup', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-root-cache-'));
    const lockRoot = join(temp, 'locks');
    const firstPhases: Record<string, number> = {};
    const secondPhases: Record<string, number> = {};
    const originalOverride = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockRoot;

    try {
      await expect(ensureFsMutexLockRoot(undefined, { phaseTimingsMs: firstPhases })).resolves.toBe(lockRoot);
      await expect(ensureFsMutexLockRoot(undefined, { phaseTimingsMs: secondPhases })).resolves.toBe(lockRoot);
      expect(firstPhases).toHaveProperty('lock-root.mkdir');
      expect(secondPhases).toEqual({});
    } finally {
      if (originalOverride === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = originalOverride;
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe('censusLegacyFsMutexRoot read-only inspection', () => {
  it('uses readable kernel identity after EPERM without treating a matching owner as stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-census-eperm-'));
    const reused = join(root, 'cache.readers', 'reused.lock');
    const protectedLease = join(root, 'cache.readers', 'protected.lock');
    const reusedPid = 410_001;
    const protectedPid = 410_002;
    const reusedOwner = { pid: reusedPid, host: hostname(), startTicks: 'old', bootId: 'old' };
    const protectedOwner = { pid: protectedPid, host: hostname(), startTicks: 'same', bootId: 'boot' };
    await mkdir(reused, { recursive: true });
    await mkdir(protectedLease, { recursive: true });
    await writeFile(join(reused, 'owner.json'), JSON.stringify(reusedOwner));
    await writeFile(join(protectedLease, 'owner.json'), JSON.stringify(protectedOwner));
    const identities = new Map([
      [reusedPid, { tgid: reusedPid, startTicks: 'new', bootId: 'boot', kthread: false }],
      [protectedPid, { tgid: protectedPid, startTicks: 'same', bootId: 'boot', kthread: false }],
    ]);
    const actualKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === reusedPid || pid === protectedPid) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return actualKill(pid, signal);
    });
    try {
      expect(await censusLegacyFsMutexRoot(root, 60_000, {
        processIdentity: (pid) => identities.get(pid) ?? null,
      })).toMatchObject({ reader: { active: 0, unknown: 1, stale: 1 } });
      await expect(readFile(join(reused, 'owner.json'), 'utf8')).resolves.toBe(JSON.stringify(reusedOwner));
      await expect(readFile(join(protectedLease, 'owner.json'), 'utf8')).resolves.toBe(JSON.stringify(protectedOwner));
    } finally {
      kill.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies live, unknown and stale leases while preserving every marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-census-'));
    const writer = join(root, 'cache.lock');
    const reader = join(root, 'cache.readers', 'remote.lock');
    const queued = join(root, 'cache.queue', 'abandoned.ticket');
    const owner = JSON.stringify({ pid: process.pid, host: hostname() });
    const remote = JSON.stringify({ pid: process.pid, host: 'unconfirmed-remote.invalid' });
    await mkdir(writer);
    await mkdir(reader, { recursive: true });
    await mkdir(queued, { recursive: true });
    await writeFile(join(writer, 'owner.json'), owner);
    await writeFile(join(reader, 'owner.json'), remote);
    await writeFile(join(root, 'unrecognized'), 'preserve this evidence');
    const old = new Date(Date.now() - 120_000);
    await utimes(queued, old, old);
    const entries = (await readdir(root)).sort();
    try {
      expect(await censusLegacyFsMutexRoot(root, 60_000)).toMatchObject({
        complete: true,
        writer: { active: 1, unknown: 0, stale: 0 },
        reader: { active: 0, unknown: 1, stale: 0 },
        queue: { active: 0, unknown: 0, stale: 1 },
        otherUnknown: 1,
      });
      expect((await readdir(root)).sort()).toEqual(entries);
      expect((await lstat(root)).isDirectory()).toBe(true);
      expect(await readFile(join(writer, 'owner.json'), 'utf8')).toBe(owner);
      expect(await readFile(join(reader, 'owner.json'), 'utf8')).toBe(remote);
      expect(await readFile(join(root, 'unrecognized'), 'utf8')).toBe('preserve this evidence');
      expect((await lstat(queued)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns an incomplete census without creating a missing root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-census-missing-'));
    const missing = join(parent, 'missing');
    try {
      expect(await censusLegacyFsMutexRoot(missing)).toMatchObject({ complete: false, otherUnknown: 1 });
      await expect(lstat(missing)).rejects.toHaveProperty('code', 'ENOENT');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('reports an unreadable root without touching its evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-census-unreadable-'));
    await writeFile(join(root, 'evidence'), 'keep');
    // Vitest externalizes Node builtins through its native import path; inject
    // the operation so this failure remains deterministic across that boundary.
    const io = {
      opendir: async (...args: Parameters<typeof opendir>) => {
        const path = String(args[0]);
        if (path === root) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return opendir(...args);
      },
    };
    try {
      expect(await censusLegacyFsMutexRoot(root, undefined, io)).toMatchObject({ complete: false, otherUnknown: 1 });
      expect(await readFile(join(root, 'evidence'), 'utf8')).toBe('keep');
      expect((await lstat(root)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ensureFsMutexLockRoot migration', () => {
  it('keeps callers on the legacy root while known active leases drain', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-active-migration-'));
    const homeDir = join(temp, 'home');
    const legacyRoot = join(temp, 'legacy-locks');
    const lockDir = join(legacyRoot, 'package-manager-cache.lock');
    const phaseTimingsMs: Record<string, number> = {};
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    }));

    try {
      await expect(ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot, phaseTimingsMs }))
        .resolves.toBe(legacyRoot);
      expect(phaseTimingsMs).toHaveProperty('lock-root.legacy-census');
      await expect(readdir(join(homeDir, '.papercusp', 'fs-mutex-locks')))
        .rejects.toHaveProperty('code', 'ENOENT');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  // EI-25835785788432904: reader acquisition must continue on the legacy root
  // while the migration waits for existing reader leases to drain.
  it('keeps callers on the legacy root while active legacy reader leases drain', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-active-reader-migration-'));
    const homeDir = join(temp, 'home');
    const legacyRoot = join(temp, 'legacy-locks');
    const readersDir = join(legacyRoot, 'package-manager-cache.readers');
    const readerDir = join(readersDir, `${process.pid}-reader.lock`);
    await mkdir(readerDir, { recursive: true });
    await writeFile(join(readerDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    }));

    try {
      await expect(ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot }))
        .resolves.toBe(legacyRoot);
      await expect(readdir(join(homeDir, '.papercusp', 'fs-mutex-locks')))
        .rejects.toHaveProperty('code', 'ENOENT');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('fails closed when a legacy lease owner cannot be identified', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-unknown-migration-'));
    const homeDir = join(temp, 'home');
    const legacyRoot = join(temp, 'legacy-locks');
    const lockDir = join(legacyRoot, 'package-manager-cache.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      host: `${hostname()}-unverified`,
    }));

    try {
      await expect(ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot }))
        .rejects.toMatchObject({ code: 'ELEGACYFSLOCKBUSY' });
      await expect(readdir(join(homeDir, '.papercusp', 'fs-mutex-locks')))
        .rejects.toHaveProperty('code', 'ENOENT');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('continues on a directory recreated by a legacy caller when alias creation loses a race', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-alias-race-'));
    const homeDir = join(temp, 'home');
    const legacyRoot = join(temp, 'legacy-locks');
    await mkdir(legacyRoot, { recursive: true });
    const io = {
      symlink: async (...args: Parameters<typeof symlink>) => {
        const path = String(args[1]);
        if (path === legacyRoot) await mkdir(legacyRoot);
        return symlink(...args);
      },
    };

    try {
      await expect(ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot, io }))
        .resolves.toBe(legacyRoot);
      await expect(readdir(legacyRoot)).resolves.toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('leaves legacy markers untouched when the census cannot read the directory', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-unreadable-'));
    const legacyRoot = join(temp, 'legacy-locks');
    const homeDir = join(temp, 'home');
    const marker = join(legacyRoot, 'install.lock', 'owner.json');
    const bytes = '{"pid":42,"host":"unverified-host"}\n';
    await mkdir(join(legacyRoot, 'install.lock'), { recursive: true });
    await writeFile(marker, bytes);
    const io = {
      opendir: async (...args: Parameters<typeof opendir>) => {
        const path = String(args[0]);
        if (path === legacyRoot) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return opendir(...args);
      },
    };
    try {
      await expect(ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot, io }))
        .rejects.toMatchObject({ code: 'ELEGACYFSLOCKBUSY', census: { complete: false } });
      expect((await lstat(legacyRoot)).isDirectory()).toBe(true);
      expect(await readFile(marker, 'utf8')).toBe(bytes);
      await expect(lstat(join(homeDir, '.papercusp', 'fs-mutex-locks')))
        .rejects.toHaveProperty('code', 'ENOENT');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('preserves stale marker bytes in quarantine and excludes writers across both aliases', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-quiescent-'));
    const legacyRoot = join(temp, 'legacy-locks');
    const homeDir = join(temp, 'home');
    const staleLock = join(legacyRoot, 'install.lock');
    const bytes = 'stale owner evidence\n';
    await mkdir(staleLock, { recursive: true });
    await writeFile(join(staleLock, 'owner.json'), bytes);
    await utimes(staleLock, new Date(0), new Date(0));
    let release!: () => void;
    let acquired!: () => void;
    const entered = new Promise<void>(resolve => { acquired = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    let first: Promise<unknown> | undefined;
    try {
      const root = await ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot });
      expect(root).toBe(join(homeDir, '.papercusp', 'fs-mutex-locks'));
      expect(await realpath(legacyRoot)).toBe(await realpath(root));
      const quarantines = (await readdir(temp)).filter(name => name.startsWith('legacy-locks.legacy-'));
      expect(quarantines).toHaveLength(1);
      expect(await readFile(join(temp, quarantines[0], 'install.lock', 'owner.json'), 'utf8')).toBe(bytes);

      process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = legacyRoot;
      first = withFsMutex('alias-exclusion', async () => { acquired(); await hold; });
      await entered;
      process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = root;
      let secondEntered = false;
      await expect(withFsMutex('alias-exclusion', async () => { secondEntered = true; }, {
        timeoutMs: 60, retryMs: 5,
      })).rejects.toThrow(/waiting for fs-mutex/);
      expect(secondEntered).toBe(false);
      release();
      await first;
      await expect(withFsMutex('alias-exclusion', async () => 'acquired')).resolves.toBe('acquired');
    } finally {
      release();
      await first;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('restores the legacy directory and evidence when alias creation fails', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-alias-failure-'));
    const legacyRoot = join(temp, 'legacy-locks');
    const homeDir = join(temp, 'home');
    const staleLock = join(legacyRoot, 'install.lock');
    const bytes = 'quarantined owner evidence\n';
    await mkdir(staleLock, { recursive: true });
    await writeFile(join(staleLock, 'owner.json'), bytes);
    await utimes(staleLock, new Date(0), new Date(0));
    const io = {
      symlink: async (...args: Parameters<typeof symlink>) => {
        const path = String(args[1]);
        if (path === legacyRoot) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return symlink(...args);
      },
    };
    try {
      await expect(ensureFsMutexLockRoot({}, { platform: 'linux', homeDir, legacyRoot, io }))
        .rejects.toHaveProperty('code', 'ELEGACYFSALIASFAILED');
      expect((await lstat(legacyRoot)).isDirectory()).toBe(true);
      expect(await readFile(join(staleLock, 'owner.json'), 'utf8')).toBe(bytes);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

// EI-18662389554660036: `withFsMutex` is the serialization primitive for shared-tree-wide
// mutations (e.g. `npm install`) that plain repo tooling needs, with no MCP/Papercusp
// credentials available — the SAME proven mkdir-lock algorithm as
// `withTestcontainerStartLock` (libs/test-config/src/testcontainer-start-lock.ts), duplicated
// rather than imported because this caller must stay a plain, buildless Node script.
describe('withFsMutexRead wait observations', () => {
  it('reports the current writer on the requested cadence without admitting the reader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-notices-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    const writer = { pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ ...writer, intent: { stage: 'first' } }));
    const notices: Array<{ owner: string; elapsedMs: number }> = [];
    let firstNotice!: () => void;
    const observedFirst = new Promise<void>(resolve => { firstNotice = resolve; });
    let readerEntered = false;
    try {
      const reader = withFsMutexRead('npm-install', async () => { readerEntered = true; }, {
        timeoutMs: 120,
        retryMs: 2,
        staleMs: 10_000,
        waitingNoticeIntervalMs: 10,
        onWaiting: notice => { notices.push(notice); firstNotice(); },
      });
      const timedOut = expect(reader).rejects.toThrow('Timed out after 120ms');
      await observedFirst;
      await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ ...writer, intent: { stage: 'second' } }));
      await timedOut;
      expect(notices[0].owner).toContain('first');
      expect(notices.some(notice => notice.owner.includes('second'))).toBe(true);
      for (let index = 1; index < notices.length; index++) {
        expect(notices[index].elapsedMs - notices[index - 1].elapsedMs).toBeGreaterThanOrEqual(10);
      }
      expect(readerEntered).toBe(false);
      expect(await readdir(join(dir, 'npm-install.readers'))).toEqual([]);
      expect(peekFsMutexSync('npm-install').held).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports how long admission queued behind a writer, before the reader body runs (WI-10006385)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-acquired-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
    const events: string[] = [];
    const acquired: number[] = [];
    let noticed!: () => void;
    const firstNotice = new Promise<void>(resolve => { noticed = resolve; });
    try {
      const reader = withFsMutexRead('npm-install', async () => { events.push('body'); }, {
        timeoutMs: 5_000,
        retryMs: 2,
        staleMs: 10_000,
        onWaiting: () => { events.push('waiting'); noticed(); },
        onAcquired: ({ waitedMs }) => { events.push('acquired'); acquired.push(waitedMs); },
      });
      await firstNotice;
      await new Promise(resolve => setTimeout(resolve, 60));
      await rm(writerDir, { recursive: true, force: true });
      await reader;
      expect(events).toEqual(['waiting', 'acquired', 'body']);
      expect(acquired).toHaveLength(1);
      expect(acquired[0]).toBeGreaterThanOrEqual(60);
      expect(await readdir(join(dir, 'npm-install.readers'))).toEqual([]);

      // Uncontested: reported once, with no queueing to speak of.
      const uncontested: number[] = [];
      await withFsMutexRead('npm-install', async () => undefined, {
        onAcquired: ({ waitedMs }) => { uncontested.push(waitedMs); },
      });
      expect(uncontested).toHaveLength(1);
      expect(uncontested[0]).toBeLessThan(60);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('includes lock-root setup subphases in read acquisition observations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-root-timing-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    let acquired: { waitedMs: number; admissionSubphaseTimingsMs?: Record<string, number> } | undefined;
    try {
      await withFsMutexRead('reader-root-timing', async () => undefined, {
        onAcquired: (info) => { acquired = info; },
      });
      expect(acquired?.admissionSubphaseTimingsMs).toEqual(expect.objectContaining({
        'lock-root.mkdir': expect.any(Number),
      }));
      expect(Number.isFinite(acquired?.admissionSubphaseTimingsMs?.['lock-root.mkdir'])).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes the reader marker when the onAcquired callback throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-acquired-throw-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    let bodyRan = false;
    try {
      await expect(withFsMutexRead('npm-install', async () => { bodyRan = true; }, {
        onAcquired: () => { throw new Error('reporter exploded'); },
      })).rejects.toThrow('reporter exploded');
      expect(bodyRan).toBe(false);
      expect(await readdir(join(dir, 'npm-install.readers'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('reports failed reader admission even when the timeout observer throws: %s', async (observerThrows) => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-timeout-observation-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'reader-timeout.lock');
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
    const timeouts: { waitedMs: number; timeoutMs: number; admissionSubphaseTimingsMs?: Record<string, number> }[] = [];
    let readerEntered = false;
    let acquired = false;
    try {
      await expect(withFsMutexRead('reader-timeout', async () => { readerEntered = true; }, {
        timeoutMs: 40,
        retryMs: 2,
        onAcquired: observerThrows ? () => { acquired = true; } : undefined,
        onTimedOut: (info) => {
          timeouts.push(info);
          if (observerThrows) throw new Error('timeout observer failed');
        },
      })).rejects.toMatchObject({ code: 'ETIMEDOUT', timeoutMs: 40 });
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0].waitedMs).toBeGreaterThanOrEqual(40);
      expect(timeouts[0].admissionSubphaseTimingsMs).toMatchObject({
        'lock-root.ensure': expect.any(Number),
        'writer-check': expect.any(Number),
        'retry-wait': expect.any(Number),
      });
      expect(readerEntered).toBe(false);
      expect(acquired).toBe(false);
      expect(await readdir(join(dir, 'reader-timeout.readers'))).toEqual([]);
      expect((await lstat(writerDir)).isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the one-shot default and cleans up after a bounded timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-default-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));
    const notices: string[] = [];
    let readerEntered = false;
    try {
      await expect(withFsMutexRead('npm-install', async () => { readerEntered = true; }, {
        timeoutMs: 40,
        retryMs: 2,
        staleMs: 10_000,
        onWaiting: notice => { notices.push(notice.owner); },
      })).rejects.toThrow('Timed out after 40ms');
      expect(notices).toHaveLength(1);
      expect(readerEntered).toBe(false);
      expect(await readdir(join(dir, 'npm-install.readers'))).toEqual([]);
      expect(peekFsMutexSync('npm-install').held).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('withFsMutex', () => {
  it('reports the filesystem steps used to reclaim an ownerless stale lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reclaim-timing-'));
    const previousLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'reclaim-timing.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), '{invalid-json');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    let admission: { admissionSubphaseTimingsMs?: Record<string, number> } | undefined;
    try {
      await expect(withFsMutex('reclaim-timing', async () => 'recovered', {
        timeoutMs: 1_000,
        staleMs: 1,
        retryMs: 5,
        onAcquired: (info) => { admission = info; },
      })).resolves.toBe('recovered');

      expect(admission?.admissionSubphaseTimingsMs).toEqual(expect.objectContaining({
        'abandoned-lock.owner-read': expect.any(Number),
        'abandoned-lock.age-check': expect.any(Number),
        'abandoned-lock.remove': expect.any(Number),
      }));
      for (const elapsedMs of Object.values(admission?.admissionSubphaseTimingsMs ?? {})) {
        expect(Number.isFinite(elapsedMs)).toBe(true);
        expect(elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      if (previousLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('reports process checks used to reclaim a reused local lock identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-process-reclaim-timing-'));
    const previousLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'process-reclaim-timing.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startTicks: '0',
    }));
    let admission: { admissionSubphaseTimingsMs?: Record<string, number> } | undefined;
    try {
      await expect(withFsMutex('process-reclaim-timing', async () => 'recovered', {
        timeoutMs: 1_000,
        staleMs: 60_000,
        retryMs: 5,
        onAcquired: (info) => { admission = info; },
      })).resolves.toBe('recovered');

      expect(admission?.admissionSubphaseTimingsMs).toEqual(expect.objectContaining({
        'abandoned-lock.owner-read': expect.any(Number),
        'abandoned-lock.process-probe': expect.any(Number),
        'abandoned-lock.process-identity': expect.any(Number),
        'abandoned-lock.remove': expect.any(Number),
      }));
      for (const elapsedMs of Object.values(admission?.admissionSubphaseTimingsMs ?? {})) {
        expect(Number.isFinite(elapsedMs)).toBe(true);
        expect(elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      if (previousLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims mismatched and kernel-thread reader identities after EPERM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reclaim-eperm-'));
    const previousLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const reusedPid = 420_001;
    const kernelPid = 420_002;
    const reusedLease = join(dir, 'eperm-reclaim.readers', 'reused.lock');
    const kernelLease = join(dir, 'eperm-reclaim.readers', 'kernel.lock');
    const reusedOwner = { pid: reusedPid, host: hostname(), startTicks: 'old', bootId: 'old' };
    const kernelOwner = { pid: kernelPid, host: hostname(), startTicks: 'same', bootId: 'boot' };
    await mkdir(reusedLease, { recursive: true });
    await mkdir(kernelLease, { recursive: true });
    await writeFile(join(reusedLease, 'owner.json'), JSON.stringify(reusedOwner));
    await writeFile(join(kernelLease, 'owner.json'), JSON.stringify(kernelOwner));
    const identities = new Map([
      [reusedPid, { tgid: reusedPid, startTicks: 'new', bootId: 'boot', kthread: false }],
      [kernelPid, { tgid: kernelPid, startTicks: 'same', bootId: 'boot', kthread: true }],
    ]);
    const actualKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === reusedPid || pid === kernelPid) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return actualKill(pid, signal);
    });
    try {
      await expect(withFsMutex('eperm-reclaim', async () => 'recovered', {
        timeoutMs: 1_000,
        staleMs: 60_000,
        retryMs: 1,
        lockRootDir: dir,
        io: { processIdentity: (pid) => identities.get(pid) ?? null },
      })).resolves.toBe('recovered');
      await expect(lstat(reusedLease)).rejects.toHaveProperty('code', 'ENOENT');
      await expect(lstat(kernelLease)).rejects.toHaveProperty('code', 'ENOENT');
    } finally {
      kill.mockRestore();
      if (previousLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retains an EPERM reader lease when the kernel identity still matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-retain-eperm-'));
    const previousLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const pid = 430_001;
    const lease = join(dir, 'eperm-retain.readers', 'protected.lock');
    const owner = { pid, host: hostname(), startTicks: 'same', bootId: 'boot' };
    await mkdir(lease, { recursive: true });
    await writeFile(join(lease, 'owner.json'), JSON.stringify(owner));
    const actualKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((candidate, signal) => {
      if (candidate === pid) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return actualKill(candidate, signal);
    });
    try {
      await expect(withFsMutex('eperm-retain', async () => 'must not acquire', {
        timeoutMs: 40,
        staleMs: 60_000,
        retryMs: 1,
        lockRootDir: dir,
        io: { processIdentity: (candidate) => candidate === pid
          ? { tgid: pid, startTicks: 'same', bootId: 'boot', kthread: false }
          : null },
      })).rejects.toThrow(/Timed out after/);
      await expect(readFile(join(lease, 'owner.json'), 'utf8')).resolves.toBe(JSON.stringify(owner));
    } finally {
      kill.mockRestore();
      if (previousLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports filesystem admission subphases, including time queued behind a writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-admission-timing-'));
    const previousLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    let releaseHolder!: () => void;
    let startHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holderStarted = new Promise<void>((resolve) => { startHolder = resolve; });
    const holder = withFsMutex('admission-timing', async () => {
      startHolder();
      await holderGate;
    }, { timeoutMs: 2_000, retryMs: 5 });
    let signalWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { signalWaiting = resolve; });
    let admission!: { waitedMs: number; admissionSubphaseTimingsMs?: Record<string, number> };
    let waiter: Promise<string> | undefined;
    try {
      await holderStarted;
      waiter = withFsMutex('admission-timing', async () => 'done', {
        timeoutMs: 2_000,
        retryMs: 5,
        onWaiting: () => signalWaiting(),
        onAcquired: (info) => { admission = info; },
      });
      await waiting;
      releaseHolder();
      await holder;
      expect(await waiter).toBe('done');
      expect(admission.waitedMs).toBeGreaterThan(0);
      // The canonical root can already be cached by the holder. In that case
      // ensure is measured, but no root mkdir is needed on this waiter.
      expect(admission.admissionSubphaseTimingsMs).toEqual(expect.objectContaining({
        'lock-root.ensure': expect.any(Number),
        'queue-root-mkdir': expect.any(Number),
        'ticket-mkdir': expect.any(Number),
        'ticket-owner-write': expect.any(Number),
        'ticket-scan': expect.any(Number),
        'writer-lock-mkdir': expect.any(Number),
        'writer-owner-write': expect.any(Number),
        'waiting-notice': expect.any(Number),
        'backoff-sleep': expect.any(Number),
        'ticket-cleanup': expect.any(Number),
        'reader-drain': expect.any(Number),
      }));
      expect(admission.admissionSubphaseTimingsMs).not.toHaveProperty('root-mkdir');
      expect(admission.admissionSubphaseTimingsMs?.['backoff-sleep']).toBeGreaterThan(0);
      for (const elapsedMs of Object.values(admission.admissionSubphaseTimingsMs ?? {})) {
        expect(Number.isFinite(elapsedMs)).toBe(true);
        expect(elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      releaseHolder();
      await Promise.allSettled([holder, ...(waiter ? [waiter] : [])]);
      if (previousLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the observed holder on timeout without a progress callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-timeout-holder-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'timeout-holder.lock');
    const owner = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner));
    try {
      await expect(withFsMutex('timeout-holder', async () => 'must not acquire', {
        timeoutMs: 80,
        retryMs: 5,
      })).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        message: expect.stringContaining(`holder (last observed): ${JSON.stringify(owner)}`),
      });
      expect((await lstat(lockDir)).isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops retrying a slow abandoned-lock reclaim after the deadline and reports its failed phases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-slow-reclaim-'));
    const previousLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'slow-reclaim.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    }));
    let ownerReads = 0;
    let timeoutInfo: {
      waitedMs: number;
      timeoutMs: number;
      admissionSubphaseTimingsMs?: Record<string, number>;
    } | undefined;
    const io = {
      readFile: async (path: string, encoding: 'utf8') => {
        if (path === join(lockDir, 'owner.json')) {
          ownerReads += 1;
          if (ownerReads === 1) await new Promise((resolve) => setTimeout(resolve, 35));
        }
        return readFile(path, encoding);
      },
    };
    const startedAt = performance.now();
    try {
      await expect(withFsMutex('slow-reclaim', async () => 'must not acquire', {
        timeoutMs: 5,
        retryMs: 1,
        io,
        onTimedOut: (info) => { timeoutInfo = info; },
      })).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        message: expect.stringContaining(`"pid":${process.pid}`),
      });

      expect(ownerReads).toBe(1);
      expect(performance.now() - startedAt).toBeLessThan(200);
      expect(timeoutInfo?.waitedMs).toBeGreaterThanOrEqual(30);
      expect(timeoutInfo?.admissionSubphaseTimingsMs).toEqual(expect.objectContaining({
        'abandoned-lock-reclaim': expect.any(Number),
        'abandoned-lock.owner-read': expect.any(Number),
      }));
      expect(timeoutInfo?.admissionSubphaseTimingsMs?.['abandoned-lock.owner-read']).toBeGreaterThanOrEqual(20);
      expect((await lstat(lockDir)).isDirectory()).toBe(true);
    } finally {
      if (previousLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not publish tentative reader markers while a writer has reserved admission', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-reservation-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    const readersDir = join(dir, 'npm-install.readers');
    await mkdir(writerDir);
    await writeFile(join(writerDir, 'owner.json'), JSON.stringify({
      pid: process.pid, host: hostname(), phase: 'draining-readers',
    }));
    let observeAttempt!: () => void;
    const attempted = new Promise<void>(resolve => { observeAttempt = resolve; });
    // This reservation exists before the reader's preflight, so it must not
    // publish a marker that the writer would then drain.
    let readerEntered = false;
    const reader = withFsMutexRead('npm-install', async () => { readerEntered = true; }, {
      timeoutMs: 2_000, retryMs: 5, onWaiting: observeAttempt,
    });
    try {
      await attempted;
      expect(readerEntered).toBe(false);
      expect(await readdir(readersDir)).toEqual([]);
      expect(peekFsMutexSync('npm-install').owner).toMatchObject({ phase: 'draining-readers' });
    } finally {
      await rm(writerDir, { recursive: true, force: true });
      await reader;
      await rm(dir, { recursive: true, force: true });
    }
    expect(readerEntered).toBe(true);
  });

  it('distinguishes a reader-drain reservation from the running writer callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-phases-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    let releaseReader!: () => void;
    const readerReleased = new Promise<void>((resolve) => { releaseReader = resolve; });
    let readerStarted!: () => void;
    const readerReady = new Promise<void>((resolve) => { readerStarted = resolve; });
    const reader = withFsMutexRead('npm-install', async () => {
      readerStarted();
      await readerReleased;
    }, { timeoutMs: 2_000, retryMs: 5 });
    await readerReady;
    let writerDraining!: () => void;
    const drainReady = new Promise<void>((resolve) => { writerDraining = resolve; });
    let writerEntered = false;
    const writer = withFsMutex('npm-install', async () => {
      writerEntered = true;
      return peekFsMutexSync('npm-install').owner;
    }, { timeoutMs: 2_000, retryMs: 5, onWaiting: writerDraining });
    try {
      await drainReady;
      const reserved = peekFsMutexSync('npm-install');
      expect(reserved.held).toBe(true);
      expect(writerEntered).toBe(false);
      expect(reserved.owner).toMatchObject({ phase: 'draining-readers' });
      expect(reserved.owner).not.toHaveProperty('runningAt');
      releaseReader();
      const running = await writer;
      expect(running).toMatchObject({ phase: 'running', acquiredAt: reserved.owner?.acquiredAt });
      expect(Date.parse(running!.runningAt!)).toBeGreaterThanOrEqual(Date.parse(running!.acquiredAt!));
      expect(peekFsMutexSync('npm-install').held).toBe(false);
    } finally {
      releaseReader();
      await Promise.allSettled([reader, writer]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backs out when a writer reserves between reader preflight and publication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-race-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const writerDir = join(dir, 'npm-install.lock');
    const readersDir = join(dir, 'npm-install.readers');
    let reserved = false;
    const io = {
      writeFile: async (...args: Parameters<typeof writeFile>) => {
        if (String(args[0]).endsWith('/owner.json') && !reserved) {
        reserved = true;
        await mkdir(writerDir);
        await writeFile(join(writerDir, 'owner.json'), JSON.stringify({
          pid: process.pid, host: hostname(), phase: 'draining-readers',
        }));
        }
        return writeFile(...args);
      },
    };
    let observeAttempt!: () => void;
    const attempted = new Promise<void>(resolve => { observeAttempt = resolve; });
    let readerEntered = false;
    const reader = withFsMutexRead('npm-install', async () => {
      readerEntered = true;
      observeAttempt();
    }, { timeoutMs: 2_000, retryMs: 5, onWaiting: observeAttempt, io });
    try {
      await attempted;
      expect(reserved).toBe(true);
      expect(readerEntered).toBe(false);
      expect(await readdir(readersDir)).toEqual([]);
      expect(peekFsMutexSync('npm-install').held).toBe(true);
    } finally {
      await rm(writerDir, { recursive: true, force: true });
      await reader;
      await rm(dir, { recursive: true, force: true });
    }
    expect(readerEntered).toBe(true);
  });

  it('serializes concurrent callers under the same lock name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let active = 0;
    let maxActive = 0;
    const observed: number[] = [];

    async function lockedWork(id: number): Promise<number> {
      return withFsMutex(
        'npm-install',
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          observed.push(id);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
          active -= 1;
          return id;
        },
        { timeoutMs: 2_000, retryMs: 5 },
      );
    }

    await Promise.all([lockedWork(1), lockedWork(2), lockedWork(3)]);

    expect(maxActive).toBe(1);
    expect(observed).toHaveLength(3);
    await rm(dir, { recursive: true, force: true });
  });

  it('allows concurrent readers while a writer still waits for every reader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let activeReaders = 0;
    let maxActiveReaders = 0;
    let releaseFirstReader!: () => void;
    const firstReaderReleased = new Promise<void>((resolve) => {
      releaseFirstReader = resolve;
    });
    let firstReaderStarted!: () => void;
    const firstReaderReady = new Promise<void>((resolve) => {
      firstReaderStarted = resolve;
    });
    let secondReaderStarted!: () => void;
    const secondReaderReady = new Promise<void>((resolve) => {
      secondReaderStarted = resolve;
    });

    const reader = withFsMutexRead(
      'npm-install',
      async () => {
        activeReaders += 1;
        maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
        firstReaderStarted();
        await firstReaderReleased;
        activeReaders -= 1;
      },
      { timeoutMs: 2_000, retryMs: 5 },
    );
    await firstReaderReady;

    const secondReader = withFsMutexRead(
      'npm-install',
      async () => {
        activeReaders += 1;
        maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
        secondReaderStarted();
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 30));
        activeReaders -= 1;
      },
      { timeoutMs: 2_000, retryMs: 5 },
    );
    await secondReaderReady;

    let writerEntered = false;
    const writer = withFsMutex(
      'npm-install',
      async () => {
        writerEntered = true;
        return 'writer';
      },
      { timeoutMs: 2_000, retryMs: 5 },
    );

    expect(maxActiveReaders).toBe(2);
    expect(writerEntered).toBe(false);

    releaseFirstReader();
    await expect(Promise.all([reader, secondReader, writer])).resolves.toEqual([undefined, undefined, 'writer']);
    expect(writerEntered).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('releases the lock after fn resolves — a second call is not blocked by the first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    await withFsMutex('npm-install', async () => 'first', { timeoutMs: 2_000, retryMs: 5 });
    const second = await withFsMutex('npm-install', async () => 'second', { timeoutMs: 2_000, retryMs: 5 });

    expect(second).toBe('second');
    await rm(dir, { recursive: true, force: true });
  });

  it('releases the lock even when fn throws, so the next caller is never wedged behind a failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    await expect(
      withFsMutex(
        'npm-install',
        async () => {
          throw new Error('boom');
        },
        { timeoutMs: 2_000, retryMs: 5 },
      ),
    ).rejects.toThrow('boom');

    const after = await withFsMutex('npm-install', async () => 'ok', { timeoutMs: 500, retryMs: 5 });
    expect(after).toBe('ok');
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps independent lock names from blocking each other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let active = 0;
    let maxActive = 0;

    async function lockedWork(name: string): Promise<string> {
      return withFsMutex(
        name,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
          active -= 1;
          return name;
        },
        { timeoutMs: 2_000, retryMs: 5 },
      );
    }

    await expect(Promise.all([lockedWork('npm-install-repo-a'), lockedWork('npm-install-repo-b')])).resolves.toHaveLength(2);

    expect(maxActive).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('reclaims an abandoned stale lock instead of waiting out the full timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'npm-install.lock');
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);

    const result = await withFsMutex('npm-install', async () => 'done', { timeoutMs: 1_000, staleMs: 1, retryMs: 5 });

    expect(result).toBe('done');
    await rm(dir, { recursive: true, force: true });
  });

  // EI-7818 (ported from testcontainer-start-lock's own regression): reclaim on
  // CONFIRMED-dead-pid evidence alone, even when the lock is fresh (well under staleMs) — a
  // crashed holder must never wedge every future `npm install` for the full timeout.
  it('reclaims immediately when the recorded owner pid is confirmed dead on this host, even when the lock is fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'npm-install.lock');
    await mkdir(lockDir, { recursive: true });

    const deadPid = 2_147_483_647; // guaranteed not to exist
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: deadPid, host: hostname(), startedAt: new Date().toISOString(), name: 'npm-install' }),
    );

    const start = Date.now();
    const result = await withFsMutex('npm-install', async () => 'done', {
      timeoutMs: 5_000,
      staleMs: 10 * 60_000,
      retryMs: 5,
    });
    const elapsed = Date.now() - start;

    expect(result).toBe('done');
    expect(elapsed).toBeLessThan(2_000);
    await rm(dir, { recursive: true, force: true });
  });

  it('does NOT reclaim a lock owned by a live pid on this host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'npm-install.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), name: 'npm-install' }),
    );

    await expect(
      withFsMutex('npm-install', async () => 'done', { timeoutMs: 300, staleMs: 10 * 60_000, retryMs: 20 }),
    ).rejects.toThrow(/Timed out after 300ms/);

    await rm(dir, { recursive: true, force: true });
  });

  it('PAPERCUSP_DISABLE_FS_MUTEX=1 bypasses locking entirely', async () => {
    process.env.PAPERCUSP_DISABLE_FS_MUTEX = '1';
    const result = await withFsMutex('npm-install', async () => 'unlocked');
    expect(result).toBe('unlocked');
  });
});

// EI-25235644267089650: old leases still protect live owners. Age is only a
// recovery fallback for records that cannot identify an owner.
describe('fs-mutex lease reclamation', () => {
  it.each([
    ['local', 'reader'], ['local', 'writer'],
    ['remote', 'reader'], ['remote', 'writer'],
  ] as const)('preserves an old %s writer against a %s waiter until release', async (location, mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-old-writer-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'old-writer.lock');
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid, host: location === 'local' ? hostname() : `${hostname()}-remote`,
    }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    const acquire = mode === 'reader' ? withFsMutexRead : withFsMutex;
    let entered = false;
    try {
      await expect(acquire('old-writer', async () => { entered = true; }, {
        timeoutMs: 120, staleMs: 1, retryMs: 5,
      })).rejects.toThrow('Timed out after 120ms');
      expect(entered).toBe(false);
      expect(peekFsMutexSync('old-writer').owner).toMatchObject({ pid: process.pid });
      await rm(lockDir, { recursive: true, force: true });
      await acquire('old-writer', async () => { entered = true; });
      expect(entered).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps an old live reader protected until its callback releases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-old-reader-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const readersDir = join(dir, 'old-reader.readers');
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const reader = withFsMutexRead('old-reader', async () => { started(); await released; });
    let writerEntered = false;
    try {
      await ready;
      const markers = await readdir(readersDir);
      expect(markers).toHaveLength(1);
      const old = new Date(Date.now() - 60_000);
      await utimes(join(readersDir, markers[0]), old, old);
      await expect(withFsMutex('old-reader', async () => { writerEntered = true; }, {
        timeoutMs: 120, staleMs: 1, retryMs: 5,
      })).rejects.toThrow('Timed out after 120ms');
      expect(writerEntered).toBe(false);
      expect(await readdir(readersDir)).toEqual(markers);
      release();
      await reader;
      expect(await readdir(readersDir)).toEqual([]);
      await withFsMutex('old-reader', async () => { writerEntered = true; });
      expect(writerEntered).toBe(true);
    } finally {
      release();
      await reader;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves an old remote reader until explicit release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-remote-reader-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const readersDir = join(dir, 'remote-reader.readers');
    const markerDir = join(readersDir, 'remote.lock');
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: `${hostname()}-remote` }));
    const old = new Date(Date.now() - 60_000);
    await utimes(markerDir, old, old);
    try {
      await expect(withFsMutex('remote-reader', async () => undefined, {
        timeoutMs: 120, staleMs: 1, retryMs: 5,
      })).rejects.toThrow('Timed out after 120ms');
      expect(await readdir(readersDir)).toEqual(['remote.lock']);
      await rm(markerDir, { recursive: true, force: true });
      await expect(withFsMutex('remote-reader', async () => 'released')).resolves.toBe('released');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['writer', 'reader'] as const)('reclaims a fresh %s lease only after confirming its owner dead', async mode => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-dead-owner-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const markerDir = mode === 'writer' ? join(dir, 'dead-owner.lock') : join(dir, 'dead-owner.readers', 'dead.lock');
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, host: hostname() }));
    try {
      await expect(withFsMutex('dead-owner', async () => 'recovered', {
        timeoutMs: 1_000, staleMs: 60_000, retryMs: 5,
      })).resolves.toBe('recovered');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['writer', undefined], ['reader', undefined],
    ['writer', '{invalid-json'], ['reader', '{invalid-json'],
    ['writer', '{"pid":"invalid","host":"local"}'], ['reader', '{"pid":"invalid","host":"local"}'],
  ] as const)('recovers an old ownerless or malformed %s lease (%s)', async (mode, record) => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-ownerless-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const markerDir = mode === 'writer' ? join(dir, 'ownerless.lock') : join(dir, 'ownerless.readers', 'orphan.lock');
    await mkdir(markerDir, { recursive: true });
    if (record !== undefined) await writeFile(join(markerDir, 'owner.json'), record);
    const old = new Date(Date.now() - 60_000);
    await utimes(markerDir, old, old);
    try {
      await expect(withFsMutex('ownerless', async () => 'recovered', {
        timeoutMs: 1_000, staleMs: 1, retryMs: 5,
      })).resolves.toBe('recovered');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not expose an interrupted reader publication to a writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-reader-publication-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const moduleUrl = new URL('../../../../scripts/lib/fs-mutex.mjs', import.meta.url).href;
    const childSource = [
      'import { withFsMutexRead } from ' + JSON.stringify(moduleUrl) + ';',
      'const io = { writeFile: async (path) => {',
      '  if (path.endsWith("owner.json")) {',
      '    process.send("owner-write-started");',
      '    await new Promise(() => {});',
      '  }',
      '} };',
      'await withFsMutexRead("interrupted-reader-publication", async () => {}, {',
      '  lockRootDir: process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR, io,',
      '  timeoutMs: 1000, staleMs: 5000, retryMs: 5,',
      '});',
    ].join('\n');
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_FS_MUTEX_LOCK_DIR: dir };
    // test:file injects the committed-source loader through NODE_OPTIONS. This
    // child must exercise the working-tree implementation under test, not the
    // committed blob silently substituted into spawned Node processes.
    delete childEnv.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const childExited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const publicationStarted = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reader did not reach owner publication')), 3000);
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(String(message));
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error('reader exited before publication: ' + code + '/' + signal));
      });
    });

    try {
      await expect(publicationStarted).resolves.toBe('owner-write-started');
      child.kill('SIGKILL');
      await childExited;
      await expect(withFsMutex('interrupted-reader-publication', async () => 'writer-acquired', {
        lockRootDir: dir, timeoutMs: 100, staleMs: 5000, retryMs: 5,
      })).resolves.toBe('writer-acquired');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await childExited;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// EI-21915677034576963: withFsMutex had no fairness at all — every waiter just raced
// mkdir() on a fixed poll, so a caller that re-acquires the SAME lock across many
// short-lived sub-invocations (e.g. one shard of a broad affected-tests run after
// another) got a fresh, near-instant shot at every release with no regard for who had
// been waiting longest, starving a bounded/narrow verification run for hours even
// though it registered first. A FIFO ticket queue fixes this: only the OLDEST live
// ticket may attempt the mkdir race on any given poll.
describe('withFsMutex fairness (FIFO ticket queue)', () => {
  it('serves waiters in FIFO ticket order — a later caller cannot leapfrog one already waiting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const order: string[] = [];
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });

    const holder = withFsMutex(
      'fair-lock',
      async () => {
        holderStarted();
        await holderReleased;
        order.push('holder');
      },
      { timeoutMs: 5_000, retryMs: 5 },
    );
    await holderReady;

    // B registers its ticket first — its ticket is strictly OLDER than C's.
    const waiterB = withFsMutex(
      'fair-lock',
      async () => {
        order.push('B');
      },
      { timeoutMs: 5_000, retryMs: 5 },
    );
    // Give B's ticket a moment to land on disk before C registers its own — otherwise
    // same-millisecond ticket ids could tie-break either way.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 30));

    const waiterC = withFsMutex(
      'fair-lock',
      async () => {
        order.push('C');
      },
      { timeoutMs: 5_000, retryMs: 5 },
    );

    releaseHolder();
    await Promise.all([holder, waiterB, waiterC]);

    expect(order).toEqual(['holder', 'B', 'C']);
    await rm(dir, { recursive: true, force: true });
  });

  it('reclaims a ticket from a crashed waiter (confirmed-dead pid) instead of wedging behind it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const queueDir = join(dir, 'fair-lock-dead.queue');
    await mkdir(queueDir, { recursive: true });
    const deadTicketDir = join(queueDir, '0000000000000001-999999-deadticket.ticket');
    await mkdir(deadTicketDir, { recursive: true });
    const deadPid = 2_147_483_647; // guaranteed not to exist
    await writeFile(
      join(deadTicketDir, 'owner.json'),
      JSON.stringify({ pid: deadPid, host: hostname(), startedAt: new Date().toISOString(), name: 'fair-lock-dead' }),
    );

    const start = Date.now();
    const result = await withFsMutex('fair-lock-dead', async () => 'done', {
      timeoutMs: 5_000,
      staleMs: 10 * 60_000,
      retryMs: 5,
    });
    const elapsed = Date.now() - start;

    expect(result).toBe('done');
    expect(elapsed).toBeLessThan(2_000);
    await rm(dir, { recursive: true, force: true });
  });

  it('attributes FIFO timeout to the live older ticket without a waiting callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-fifo-timeout-owner-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const name = 'fifo-timeout-owner';
    const queueDir = join(dir, `${name}.queue`);
    const ticketDir = join(queueDir, '0000000000000001-live.ticket');
    const owner = JSON.stringify({
      pid: process.pid, host: hostname(), name,
      intent: { workItem: 'older-retention-pass', phase: 'census' },
    });
    await mkdir(ticketDir, { recursive: true });
    await writeFile(join(ticketDir, 'owner.json'), owner);
    let ownerReads = 0;
    let timeoutCount = 0;
    let entered = false;
    try {
      await expect(withFsMutex(name, async () => { entered = true; }, {
        timeoutMs: 0,
        onTimedOut: () => { timeoutCount += 1; },
        io: {
          readFile: async (path: string, encoding: 'utf8') => {
            if (path === join(ticketDir, 'owner.json')) ownerReads += 1;
            return readFile(path, encoding);
          },
        },
      })).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        message: expect.stringContaining(`FIFO head (last observed): ${ticketDir}; owner: ${owner}`),
      });
      expect(entered).toBe(false);
      expect(timeoutCount).toBe(1);
      expect(ownerReads).toBe(1);
      expect(await readdir(queueDir)).toEqual(['0000000000000001-live.ticket']);
      expect(await readFile(join(ticketDir, 'owner.json'), 'utf8')).toBe(owner);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks only the live FIFO head in a wide queue instead of reading every waiter owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-wide-queue-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const name = 'bounded-ticket-scan';
    const queueDir = join(dir, `${name}.queue`);
    await mkdir(queueDir, { recursive: true });
    for (let index = 0; index < 64; index += 1) {
      const ticketDir = join(
        queueDir,
        `${String(index + 1).padStart(16, '0')}-${process.pid}-live-${String(index).padStart(3, '0')}.ticket`,
      );
      await mkdir(ticketDir);
      await writeFile(join(ticketDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
        name,
      }));
    }

    let ticketOwnerReads = 0;
    const io = {
      readFile: async (path: string, encoding: 'utf8') => {
        if (path.startsWith(`${queueDir}/`) && path.endsWith('/owner.json')) ticketOwnerReads += 1;
        return readFile(path, encoding);
      },
    };
    try {
      await expect(withFsMutex(name, async () => 'unreachable', {
        timeoutMs: 0,
        retryMs: 5,
        staleMs: 10_000,
        io,
      })).rejects.toThrow(/Timed out after 0ms waiting for fs-mutex/);
      expect(ticketOwnerReads).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses a stable FIFO head snapshot while a waiter polls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-ticket-head-cache-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const name = 'ticket-head-cache';
    let releaseHolder!: () => void;
    let markHolderEntered!: () => void;
    const holderEntered = new Promise<void>((resolve) => { markHolderEntered = resolve; });
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withFsMutex(name, async () => {
      markHolderEntered();
      await holderGate;
      return 'holder';
    }, { timeoutMs: 1_000, retryMs: 1 });
    let waiter: Promise<string> | undefined;
    try {
      await holderEntered;
      const queueDir = join(dir, name + '.queue');
      let queueReads = 0;
      const io = {
        readdir: async (path: string, options?: unknown) => {
          if (path === queueDir) queueReads += 1;
          return readdir(path, options as never);
        },
      };
      waiter = withFsMutex(name, async () => 'waiter', {
        timeoutMs: 1_000,
        retryMs: 1,
        staleMs: 10_000,
        io,
      });
      const deadline = Date.now() + 1_000;
      while (queueReads === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(queueReads).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(queueReads).toBeLessThanOrEqual(2);

      releaseHolder();
      await expect(waiter).resolves.toBe('waiter');
      await expect(holder).resolves.toBe('holder');
      expect(queueReads).toBeLessThanOrEqual(2);
    } finally {
      releaseHolder();
      await Promise.allSettled([holder, ...(waiter ? [waiter] : [])]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a ticket with no owner.json (crash between mkdir and write) once it is stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const queueDir = join(dir, 'fair-lock-orphan.queue');
    await mkdir(queueDir, { recursive: true });
    const orphanTicketDir = join(queueDir, '0000000000000001-999999-orphanticket.ticket');
    await mkdir(orphanTicketDir, { recursive: true }); // deliberately no owner.json
    const old = new Date(Date.now() - 60_000);
    await utimes(orphanTicketDir, old, old);

    const result = await withFsMutex('fair-lock-orphan', async () => 'done', {
      timeoutMs: 1_000,
      staleMs: 1,
      retryMs: 5,
    });

    expect(result).toBe('done');
    await rm(dir, { recursive: true, force: true });
  });

  // The critical safety property: age alone must NEVER reclaim a ticket whose owner is
  // genuinely alive, however old — that is exactly the legitimate multi-hour-wait case
  // this queue exists to protect. A naive reuse of reclaimAbandonedLock's (age OR dead)
  // policy would silently defeat the whole fairness fix by discarding the very ticket
  // that is supposed to win.
  it('never reclaims a ticket whose owner is alive on this host, no matter how old', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const queueDir = join(dir, 'fair-lock-oldlive.queue');
    await mkdir(queueDir, { recursive: true });
    const oldTicketDir = join(queueDir, '0000000000000001-999999-oldbutlive.ticket');
    await mkdir(oldTicketDir, { recursive: true });
    await writeFile(
      join(oldTicketDir, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: new Date(Date.now() - 999_999_999).toISOString(),
        name: 'fair-lock-oldlive',
      }),
    );
    const veryOld = new Date(Date.now() - 999_999_999);
    await utimes(oldTicketDir, veryOld, veryOld);

    // A brand-new caller's own ticket is always YOUNGER than the planted one. With a
    // tiny staleMs that would wrongly reclaim an age-based ticket, it must still DEFER
    // to the planted (live-pid) ticket and time out — never acquire by racing past it.
    await expect(
      withFsMutex('fair-lock-oldlive', async () => 'done', { timeoutMs: 300, staleMs: 1, retryMs: 20 }),
    ).rejects.toThrow(/Timed out after 300ms/);

    await rm(dir, { recursive: true, force: true });
  });
});

// EI-19304880034803985: a NON-blocking peek so a caller (test-files.mjs) can
// WARN ("an install is in flight, this may hang") instead of hanging silently
// on a spawnSync it cannot introspect while the mutex is held.
describe('peekFsMutexSync', () => {
  it('reports held:false when no lock directory exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    expect(peekFsMutexSync('npm-install').held).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('reports held:true with the owner when a lock is currently held', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    const lockDir = join(dir, 'npm-install.lock');
    await mkdir(lockDir, { recursive: true });
    const owner = { pid: 424242, host: hostname(), startedAt: new Date().toISOString(), name: 'npm-install' };
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner));

    const peek = peekFsMutexSync('npm-install');
    expect(peek.held).toBe(true);
    expect(peek.owner).toMatchObject(owner);
    await rm(dir, { recursive: true, force: true });
  });

  it('never blocks/waits — returns immediately even while a real holder has the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    // A real, un-released hold (fn never resolves within this test) — peek must
    // not be the thing that waits for it.
    const held = withFsMutex('npm-install', () => new Promise(() => {}), { timeoutMs: 5_000, retryMs: 5 });

    // Give the mkdir a tick to land before peeking.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    const start = Date.now();
    const peek = peekFsMutexSync('npm-install');
    expect(Date.now() - start).toBeLessThan(50);
    expect(peek.held).toBe(true);

    void held; // deliberately never awaited — it would hang the test
    await rm(dir, { recursive: true, force: true });
  });

  it('never throws — a missing/unreadable owner.json reports held:false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;
    // Lock directory exists but owner.json was never (or not yet) written —
    // the narrow window right after mkdir succeeds, before writeFile lands.
    await mkdir(join(dir, 'npm-install.lock'), { recursive: true });

    expect(() => peekFsMutexSync('npm-install')).not.toThrow();
    expect(peekFsMutexSync('npm-install').held).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

// EI-21917992245424964: the owner record carried IDENTITY (pid/host/startedAt/name) and
// nothing about whether the holder was worth waiting for, so a blocked peer's only safe
// default was to wait — measured at ~26 minutes for a run whose output nobody wanted.
// `intent` is the value half, readable by any waiter with no round-trip and without the
// holder being awake.
describe('withFsMutex owner intent', () => {
  it('publishes a declared intent into the owner record a blocked peer reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let seen: Record<string, unknown> | undefined;
    await withFsMutex(
      'npm-install',
      async () => {
        // Peek from INSIDE the critical section: this is exactly the vantage point of a
        // peer that is blocked while this holder runs.
        seen = peekFsMutexSync('npm-install').owner as Record<string, unknown>;
      },
      { timeoutMs: 5_000, intent: { scope: 'explicit', tasks: 3, etaMinSec: 12 } },
    );

    expect(seen?.intent).toEqual({ scope: 'explicit', tasks: 3, etaMinSec: 12 });
    // The identity fields a waiter and the reclaim path depend on must survive alongside it.
    expect(seen?.pid).toBe(process.pid);
    expect(seen?.host).toBe(hostname());
    await rm(dir, { recursive: true, force: true });
  });

  it('omits the intent key entirely when nothing was declared, so absence stays absence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let seen: Record<string, unknown> | undefined;
    await withFsMutex(
      'npm-install',
      async () => {
        seen = peekFsMutexSync('npm-install').owner as Record<string, unknown>;
      },
      { timeoutMs: 5_000 },
    );

    expect(seen).toBeTruthy();
    expect('intent' in (seen ?? {})).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('cannot be used to shadow the identity fields the reclaim path trusts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    const deadPid = 2_147_483_647;
    let seen: Record<string, unknown> | undefined;
    await withFsMutex(
      'npm-install',
      async () => {
        seen = peekFsMutexSync('npm-install').owner as Record<string, unknown>;
      },
      // A caller naming `pid`/`host` must land under `intent`, never over the real values —
      // otherwise a self-description could forge a dead owner and invite its own reclaim.
      { timeoutMs: 5_000, intent: { pid: deadPid, host: 'somewhere-else' } },
    );

    expect(seen?.pid).toBe(process.pid);
    expect(seen?.host).toBe(hostname());
    expect(seen?.intent).toEqual({ pid: deadPid, host: 'somewhere-else' });
    await rm(dir, { recursive: true, force: true });
  });

  it('drops unrepresentable values rather than coercing them, and bounds long strings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-fs-mutex-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = dir;

    let seen: Record<string, unknown> | undefined;
    await withFsMutex(
      'npm-install',
      async () => {
        seen = peekFsMutexSync('npm-install').owner as Record<string, unknown>;
      },
      {
        timeoutMs: 5_000,
        intent: {
          keep: 'yes',
          long: 'x'.repeat(500),
          // A coerced "[object Object]" would read as data; dropping reads as "not declared".
          nested: { a: 1 },
          notFinite: Number.NaN,
        } as unknown as Record<string, string | number | boolean>,
      },
    );

    const intent = seen?.intent as Record<string, unknown>;
    expect(intent.keep).toBe('yes');
    expect('nested' in intent).toBe(false);
    expect('notFinite' in intent).toBe(false);
    expect(String(intent.long)).toHaveLength(201); // 200 chars + the truncation marker
    await rm(dir, { recursive: true, force: true });
  });
});
