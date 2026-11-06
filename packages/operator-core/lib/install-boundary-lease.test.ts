// WI-10005137: headless agent launches wait out an in-flight install:safe.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';
import { installLockNameForRoot } from '../../../scripts/lib/install-lock-name.mjs';
import { repoLockName } from '../../../scripts/npm-install-safe.mjs';
import {
  acquireInstallBoundaryLease,
  installBoundaryRoot,
  withInstallBoundaryBootWindow,
  type InstallBoundaryLease,
} from './install-boundary-lease';
import { bootDeathLogExcerpt, installBoundaryNote } from './console-spawn';

describe('installBoundaryRoot', () => {
  it('follows the psu shim precedence and skips roots that do not exist', () => {
    const exists = (p: string) => p !== '/missing';
    expect(
      installBoundaryRoot(
        { PAPERCUSP_CANONICAL_TREE: '/missing', PAPERCUSP_INTEGRATION_ROOT: '/tree', PAPERCUSP_RELEASE_ROOT: '/rel' },
        exists,
      ),
    ).toBe('/tree');
    expect(installBoundaryRoot({ PAPERCUSP_CANONICAL_TREE: '/canon', PAPERCUSP_INTEGRATION_ROOT: '/tree' }, exists)).toBe('/canon');
    expect(installBoundaryRoot({}, exists)).toBeNull();
  });
});

describe('install lock name', () => {
  it('runtime derivation is the same lock install:safe takes', () => {
    const root = process.cwd();
    expect(installLockNameForRoot(root)).toBe(repoLockName(root));
  });
});

describe('acquireInstallBoundaryLease (real fs-mutex)', () => {
  let lockDir: string;
  let repoRoot: string;
  const savedLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'install-boundary-locks-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'install-boundary-repo-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockDir;
  });
  afterEach(() => {
    if (savedLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = savedLockDir;
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('waits for an in-flight install writer before the launch proceeds', async () => {
    const order: string[] = [];
    let finishInstall: () => void = () => {};
    let writerHeld: () => void = () => {};
    const held = new Promise<void>((r) => { writerHeld = r; });
    const install = withFsMutex(installLockNameForRoot(repoRoot), async () => {
      writerHeld();
      await new Promise<void>((r) => { finishInstall = r; });
      order.push('install-done');
    }, { retryMs: 10 });
    await held;
    const leaseP = acquireInstallBoundaryLease(repoRoot, { env: {}, timeoutMs: 10_000 }).then((lease) => {
      order.push('launch');
      return lease;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual([]); // still waiting on the writer
    finishInstall();
    await install;
    const lease = await leaseP;
    expect(lease.outcome).toBe('acquired');
    expect(order).toEqual(['install-done', 'launch']);
    lease.release();
  });

  it('holds the install out until released (boot window), then lets it run', async () => {
    const lease = await acquireInstallBoundaryLease(repoRoot, { env: {}, timeoutMs: 5_000 });
    expect(lease.outcome).toBe('acquired');
    let installRan = false;
    const install = withFsMutex(installLockNameForRoot(repoRoot), async () => {
      installRan = true;
    }, { retryMs: 10 });
    await new Promise((r) => setTimeout(r, 150));
    expect(installRan).toBe(false);
    lease.release();
    lease.release(); // idempotent
    await install;
    expect(installRan).toBe(true);
  });

  it('fails open when the install outlasts the wait', async () => {
    let finishInstall: () => void = () => {};
    let writerHeld: () => void = () => {};
    const held = new Promise<void>((r) => { writerHeld = r; });
    const install = withFsMutex(installLockNameForRoot(repoRoot), async () => {
      writerHeld();
      await new Promise<void>((r) => { finishInstall = r; });
    }, { retryMs: 10 });
    await held;
    const lease = await acquireInstallBoundaryLease(repoRoot, { env: {}, timeoutMs: 200 });
    expect(['timed-out', 'error']).toContain(lease.outcome);
    expect(installBoundaryNote(lease)).toContain('launched without the install:safe boundary');
    finishInstall();
    await install;
  });

  it('skips the lease when nested inside an install-safe reader, or with no root', async () => {
    expect((await acquireInstallBoundaryLease(repoRoot, { env: { PAPERCUSP_INSTALL_MUTEX_HELD: installLockNameForRoot(repoRoot) } })).outcome).toBe('nested');
    expect((await acquireInstallBoundaryLease(null)).outcome).toBe('no-root');
    expect(installBoundaryNote({ outcome: 'acquired', waitedMs: 0, release: () => {} })).toBe('');
  });

  it.each(['1', 'npm-install-000000000000'])('acquires its own root lease for an unrelated marker %s', async (marker) => {
    const names: string[] = [];
    const readLease = async <T,>(name: string, fn: () => Promise<T>) => {
      names.push(name);
      return fn();
    };
    const lease = await acquireInstallBoundaryLease(repoRoot, {
      env: { PAPERCUSP_INSTALL_MUTEX_HELD: marker }, readLease,
    });
    expect(lease.outcome).toBe('acquired');
    expect(names).toEqual([installLockNameForRoot(repoRoot)]);
    lease.release();
  });
});

describe('bootDeathLogExcerpt', () => {
  it('keeps the missing-package line that the stack tail cut off', () => {
    const head = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /tree/apps/operator/scripts/psu-launcher.mjs";
    const stack = Array.from({ length: 40 }, (_, i) => `    at packageResolve (node:internal/modules/esm/resolve:${i}:10)`).join('\n');
    const excerpt = bootDeathLogExcerpt(`boot\n${head}\n${stack}\n`);
    expect(excerpt.startsWith(head)).toBe(true);
    expect(excerpt).toContain('esm/resolve:39');
  });

  it('returns the plain tail when it already holds the head line', () => {
    const log = "x\nError: Cannot find module 'y'\n  at z";
    expect(bootDeathLogExcerpt(log)).toBe(log);
  });
});

describe('withInstallBoundaryBootWindow (WI-10005925)', () => {
  function fakeLease(outcome: InstallBoundaryLease['outcome'] = 'acquired') {
    const events: string[] = [];
    const lease: InstallBoundaryLease = {
      outcome,
      waitedMs: 0,
      release: () => {
        events.push('release');
      },
    };
    return { lease, events, acquire: async () => lease };
  }

  it('acquires before launching and releases after the boot hold while the launch is still running', async () => {
    const { events, acquire } = fakeLease();
    let finish: () => void = () => {};
    const run = withInstallBoundaryBootWindow(
      '/repo',
      async () => {
        events.push('launch');
        await new Promise<void>((r) => { finish = r; });
        return 'done';
      },
      { acquire, holdMs: 30 },
    );
    await new Promise((r) => setTimeout(r, 120));
    // The hold expired with the child still running: the install is no longer blocked.
    expect(events).toEqual(['launch', 'release']);
    finish();
    const { value, lease } = await run;
    expect(value).toBe('done');
    expect(lease.outcome).toBe('acquired');
  });

  it('releases as soon as the launch settles inside the hold, including on a throw', async () => {
    const ok = fakeLease();
    await withInstallBoundaryBootWindow('/repo', async () => 1, { acquire: ok.acquire, holdMs: 60_000 });
    expect(ok.events).toEqual(['release']);

    const failing = fakeLease();
    await expect(
      withInstallBoundaryBootWindow('/repo', async () => {
        throw new Error('boom');
      }, { acquire: failing.acquire, holdMs: 60_000 }),
    ).rejects.toThrow('boom');
    expect(failing.events).toEqual(['release']);
  });

  it('fails open: a timed-out lease still launches and reports its outcome', async () => {
    const { acquire } = fakeLease('timed-out');
    const { value, lease } = await withInstallBoundaryBootWindow('/repo', async () => 'launched', { acquire });
    expect(value).toBe('launched');
    expect(lease.outcome).toBe('timed-out');
  });

  describe('against the real fs-mutex', () => {
    let lockDir: string;
    let repoRoot: string;
    const savedLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    beforeEach(() => {
      lockDir = mkdtempSync(join(tmpdir(), 'install-boundary-boot-locks-'));
      repoRoot = mkdtempSync(join(tmpdir(), 'install-boundary-boot-repo-'));
      process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockDir;
    });
    afterEach(() => {
      if (savedLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = savedLockDir;
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    });

    it('a launch waits out an in-flight install, then an install queued during boot runs after the hold', async () => {
      const order: string[] = [];
      let finishInstall: () => void = () => {};
      let writerHeld: () => void = () => {};
      const held = new Promise<void>((r) => { writerHeld = r; });
      const install = withFsMutex(installLockNameForRoot(repoRoot), async () => {
        writerHeld();
        await new Promise<void>((r) => { finishInstall = r; });
        order.push('install-1-done');
      }, { retryMs: 10 });
      await held;

      let finishChild: () => void = () => {};
      let launched: () => void = () => {};
      const childStarted = new Promise<void>((r) => { launched = r; });
      const run = withInstallBoundaryBootWindow(repoRoot, async () => {
        order.push('child-boot');
        launched();
        await new Promise<void>((r) => { finishChild = r; });
      }, {
        acquire: (root) => acquireInstallBoundaryLease(root, { env: {}, timeoutMs: 10_000 }),
        holdMs: 200,
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(order).toEqual([]); // the gate does not boot into a half-reified tree
      finishInstall();
      await install;
      await childStarted;

      const install2 = withFsMutex(installLockNameForRoot(repoRoot), async () => {
        order.push('install-2');
      }, { retryMs: 10 });
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual(['install-1-done', 'child-boot']); // held out during boot
      await install2; // released by the hold, while the child is still running
      expect(order).toEqual(['install-1-done', 'child-boot', 'install-2']);
      finishChild();
      await run;
    });
  });
});
