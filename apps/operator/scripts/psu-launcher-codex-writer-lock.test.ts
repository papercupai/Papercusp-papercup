/**
 * psu-launcher-codex-writer-lock.test.ts (WI-41663) — recurrence guards for the class
 * "psu offers a resume that codex is going to refuse, and hands the owner codex's raw
 * error instead of a route".
 *
 * The bug this pins (owner-hit 2026-08-25, session 01a038ff-9f8b-7ce2-aedc-d7d3268579ea):
 *   1. A HEADLESS codex session — the common shape here, driven by the operator's wake
 *      executor as a cold-loop `codex exec … resume` — registers no psu pty-host json.
 *   2. So the WI-3455 double-host guard (`findLiveHostFor` → the pty-host registry) sees
 *      nothing and lets `psu --resume=<uuid>` through.
 *   3. codex then refuses on its OWN single-writer flock:
 *        Error: thread/resume: thread/resume failed: thread <id> already has an
 *               active writer (code -32600)
 *      …which names no route, so the owner reasonably concludes the session is broken.
 *      It is not; it is working. That is exactly why it cannot be resumed.
 *
 * The fix reads the same flock codex enforces (`<CODEX_HOME>/thread-writer-locks/
 * <uuid>.lock`) via /proc/locks. Two properties matter more than the happy path and are
 * what these tests are really for:
 *
 *   FAIL-OPEN. Every error path must report "not held". This guard is only ever allowed
 *   to turn an error that WAS going to happen into a better message — never to block a
 *   resume that would have worked. A fail-CLOSED regression here would make psu refuse
 *   resumes on any host without /proc/locks (macOS) and would be invisible on this box.
 *
 *   BLOCKED WAITERS ARE NOT HOLDERS. /proc/locks marks a queued waiter with a leading
 *   `->`. Counting one reports a live writer for a thread whose real writer has already
 *   exited — i.e. it would refuse a resume that is now perfectly legal.
 *
 * The last test is a CALIBRATION against the real kernel: the parser's whole job is to
 * match a format nothing in this repo controls, so a hand-written sample proving the
 * parser matches itself is not evidence. It takes a real flock and asserts we find it.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-codex-writer-lock.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  devMajorMinor,
  findFlockWriteHolderPid,
  codexThreadWriterLockPath,
  codexThreadWriterHolder,
  codexNativeIdForPty,
  readLinuxProcessFlockText,
  codexThreadWriterStatErrorCode,
  codexResumeHome,
  codexActiveWriterMessage,
} from './psu-launcher.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'psu-writer-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LIVE_THREAD = '01a038ff-9f8b-7ce2-aedc-d7d3268579ea';

describe('Codex carry startup identity (EI-24961854655864836)', () => {
  const readStartupPid = () => 42;
  const held = { held: true, pid: 42, lockPath: '/isolated/thread.lock', sessionId: LIVE_THREAD, reason: 'held' };

  it('uses the exact native child process as the writer-lock filter', () => {
    const calls: unknown[] = [];
    const readHolder = (...args: unknown[]) => { calls.push(args); return held; };
    expect(codexNativeIdForPty('/isolated', 12, { readHolder, readStartupPid })).toBe(LIVE_THREAD);
    expect(calls).toEqual([['/isolated', null, { holderPid: 42 }]]);
  });

  it('rejects a sibling or nested Codex writer even inside the same PTY tree', () => {
    const readHolder = () => ({ ...held, pid: 43 });
    expect(codexNativeIdForPty('/isolated', 12, { readHolder, readStartupPid })).toBeNull();
  });

  it('never substitutes an unlocked predecessor or an unknown native process', () => {
    expect(codexNativeIdForPty('/isolated', 12, {
      readStartupPid, readHolder: () => ({ ...held, held: false }),
    })).toBeNull();
    expect(codexNativeIdForPty('/isolated', 12, {
      readStartupPid: () => null, readHolder: () => held,
    })).toBeNull();
  });

  it('returns null without reading writer locks when the startup PID is absent', () => {
    const readHolder = vi.fn(() => held);
    expect(codexNativeIdForPty('/isolated', 12, {
      readStartupPid: () => null, readHolder,
    })).toBeNull();
    expect(readHolder).not.toHaveBeenCalled();
  });
});

/** A verbatim /proc/locks excerpt from the box while the bug was reproducing.
 *  Row 995 is the real holder of the real session's writer lock. */
const PROC_LOCKS = [
  '1: POSIX  ADVISORY  WRITE 693551 103:03:5424477 0 EOF',
  '2: POSIX  ADVISORY  READ 4028553 103:03:24510693 128 128',
  '995: FLOCK  ADVISORY  WRITE 256282 103:03:36177832 0 EOF',
  '996: FLOCK  ADVISORY  WRITE 111111 103:03:99999999 0 EOF',
].join('\n');

/** dev 66307 / inode 36177832 — the observed values behind row 995. */
const HELD = { dev: 66307, ino: 36177832 };

describe('process-local writer-lock evidence (WI-10007670)', () => {
  it('reads only the exact process fdinfo and reuses holder parsing', () => {
    const reads: string[] = [];
    const text = readLinuxProcessFlockText(42, {
      listFdInfo: () => ['0', '5', '9', '../locks'],
      readFdInfo: (path: string) => {
        reads.push(path);
        if (path.endsWith('/9')) throw new Error('descriptor closed');
        return path.endsWith('/5')
          ? 'pos:\t0\nlock:\t1: FLOCK ADVISORY WRITE 42 103:03:36177832 0 EOF\n'
          : 'pos:\t0\nflags:\t0100000\n';
      },
    });
    expect(reads).toEqual(['/proc/42/fdinfo/0', '/proc/42/fdinfo/5', '/proc/42/fdinfo/9']);
    expect(findFlockWriteHolderPid(text, { major: 259, minor: 3, inode: 36177832 })).toBe(42);
    expect(findFlockWriteHolderPid(text, { major: 259, minor: 3, inode: 999999 })).toBeNull();
    expect(() => readLinuxProcessFlockText(0)).toThrow('invalid');
  });

  it('does not accept a waiter or sibling as the current process writer', () => {
    const text = readLinuxProcessFlockText(42, {
      listFdInfo: () => ['5'],
      readFdInfo: () => 'lock:\t1: -> FLOCK ADVISORY WRITE 42 103:03:36177832 0 EOF\n',
    });
    expect(findFlockWriteHolderPid(text, { major: 259, minor: 3, inode: 36177832 })).toBeNull();
    expect(codexThreadWriterHolder(dir, LIVE_THREAD, {
      holderPid: 42, readProcLocks: () => '1: FLOCK ADVISORY WRITE 43 103:03:36177832 0 EOF',
      statFile: () => ({ dev: 66307, ino: 36177832 }),
    }).held).toBe(false);
  });

  it('selects the exact-process reader for a known holder and never the global oracle', () => {
    const local = vi.fn(() =>
      '1: FLOCK ADVISORY WRITE 42 103:03:36177832 0 EOF\n');
    const lockPath = codexThreadWriterLockPath(dir, LIVE_THREAD);
    mkdirSync(join(dir, 'thread-writer-locks'), { recursive: true });
    writeFileSync(lockPath, '');
    const got = codexThreadWriterHolder(dir, LIVE_THREAD, {
      holderPid: 42,
      readProcessLocks: local,
      statFile: () => ({ dev: 66307, ino: 36177832 }),
    });
    expect(got.held).toBe(true);
    expect(local).toHaveBeenCalledWith(42);
  });
});

describe('devMajorMinor', () => {
  it('decodes the dev_t behind the observed 103:03 lock row', () => {
    // /proc/locks printed `103:03` for this device; 0x103 = 259, 0x03 = 3.
    expect(devMajorMinor(66307)).toEqual({ major: 259, minor: 3 });
  });

  it('decodes a dev_t with high bits set (large-major encoding)', () => {
    // glibc splits major/minor across the word; a naive (dev >> 8) & 0xff drops it.
    const dev = (0x1234n << 32n) | 0x00_0f_03_05n;
    const { major, minor } = devMajorMinor(dev);
    expect(major).toBeGreaterThan(0xfff);
    expect(minor).toBeGreaterThan(0xff);
  });
});

describe('findFlockWriteHolderPid', () => {
  it('finds the holder pid for a matching device+inode', () => {
    expect(findFlockWriteHolderPid(PROC_LOCKS, { major: 259, minor: 3, inode: 36177832 })).toBe(
      256282,
    );
  });

  it('returns null for an inode nothing holds', () => {
    expect(findFlockWriteHolderPid(PROC_LOCKS, { major: 259, minor: 3, inode: 424242 })).toBeNull();
  });

  it('does not match a different device with the same inode number', () => {
    // Inode numbers are only unique per filesystem; ignoring the device would let a
    // lock on an unrelated mount refuse a perfectly resumable session.
    expect(findFlockWriteHolderPid(PROC_LOCKS, { major: 8, minor: 1, inode: 36177832 })).toBeNull();
  });

  it('IGNORES a blocked waiter (leading "->") — a waiter is not a holder', () => {
    // The load-bearing case: if the real writer exited and only a queued waiter row
    // remains, the thread is resumable and psu must not refuse it.
    const waiterOnly = '995: -> FLOCK  ADVISORY  WRITE 256282 103:03:36177832 0 EOF';
    expect(findFlockWriteHolderPid(waiterOnly, { major: 259, minor: 3, inode: 36177832 })).toBeNull();
  });

  it('ignores POSIX (non-flock) and READ rows on the same inode', () => {
    const other = [
      '1: POSIX  ADVISORY  WRITE 42 103:03:36177832 0 EOF',
      '2: FLOCK  ADVISORY  READ 43 103:03:36177832 0 EOF',
    ].join('\n');
    expect(findFlockWriteHolderPid(other, { major: 259, minor: 3, inode: 36177832 })).toBeNull();
  });

  it('survives empty / truncated / garbage input without throwing', () => {
    for (const input of ['', '\n\n', 'nonsense', '995: FLOCK', null, undefined]) {
      expect(() =>
        findFlockWriteHolderPid(input as never, { major: 259, minor: 3, inode: 1 }),
      ).not.toThrow();
    }
  });
});

describe('codexThreadWriterLockPath', () => {
  it('builds the path codex actually locks', () => {
    expect(codexThreadWriterLockPath('/home/x/.papercusp/su-codex-homes/session-18052', LIVE_THREAD)).toBe(
      `/home/x/.papercusp/su-codex-homes/session-18052/thread-writer-locks/${LIVE_THREAD}.lock`,
    );
  });

  it('returns null rather than a half-built path when an input is missing', () => {
    expect(codexThreadWriterLockPath(null, LIVE_THREAD)).toBeNull();
    expect(codexThreadWriterLockPath('/home/x', null)).toBeNull();
  });
});

/** Build a CODEX_HOME on disk with the named thread lock files present. */
function homeWithLocks(names: string[]): string {
  const home = join(dir, 'codex-home');
  mkdirSync(join(home, 'thread-writer-locks'), { recursive: true });
  for (const n of names) writeFileSync(join(home, 'thread-writer-locks', n), '');
  return home;
}

describe('codexThreadWriterHolder', () => {
  it('reports HELD with the holder pid when the thread lock is flocked', () => {
    const home = homeWithLocks([`${LIVE_THREAD}.lock`]);
    const got = codexThreadWriterHolder(home, LIVE_THREAD, {
      readProcLocks: () => PROC_LOCKS,
      statFile: () => HELD as never,
    });
    expect(got.held).toBe(true);
    expect(got.pid).toBe(256282);
    expect(got.sessionId).toBe(LIVE_THREAD);
  });

  it('reports FREE when the lock file exists but nothing holds it', () => {
    const home = homeWithLocks([`${LIVE_THREAD}.lock`]);
    const got = codexThreadWriterHolder(home, LIVE_THREAD, {
      readProcLocks: () => PROC_LOCKS,
      statFile: () => ({ dev: 66307, ino: 55555 }) as never,
    });
    expect(got.held).toBe(false);
    expect(got.reason).toBe('free');
  });

  // ── fail-open contract ───────────────────────────────────────────────────────
  it('FAILS OPEN when /proc/locks cannot be read (non-Linux host)', () => {
    const home = homeWithLocks([`${LIVE_THREAD}.lock`]);
    const got = codexThreadWriterHolder(home, LIVE_THREAD, {
      readProcLocks: () => {
        throw new Error('ENOENT: /proc/locks');
      },
      statFile: () => HELD as never,
    });
    expect(got.held).toBe(false);
    expect(got.reason).toBe('no-proc-locks');
  });

  it('FAILS OPEN when the thread has no lock file (never opened, or cleaned up)', () => {
    const home = homeWithLocks([]);
    const got = codexThreadWriterHolder(home, LIVE_THREAD, {
      readProcLocks: () => PROC_LOCKS,
    });
    expect(got.held).toBe(false);
    expect(got.reason).toBe('no-lock-file');
    expect(got.statErrorCodes).toEqual(['ENOENT']);
  });

  it('preserves a non-missing lock stat error as a distinct diagnostic', () => {
    const home = homeWithLocks([LIVE_THREAD + '.lock']);
    const statError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const got = codexThreadWriterHolder(home, LIVE_THREAD, {
      readProcLocks: () => PROC_LOCKS,
      statFile: () => { throw statError; },
    });
    expect(got.held).toBe(false);
    expect(got.reason).toBe('stat-error-EACCES');
    expect(got.statErrorCodes).toEqual(['EACCES']);
    expect(codexThreadWriterStatErrorCode({ code: 'not a safe code' })).toBe('unknown');
  });

  it('FAILS OPEN when there is no CODEX_HOME to inspect', () => {
    const got = codexThreadWriterHolder(null, LIVE_THREAD, { readProcLocks: () => PROC_LOCKS });
    expect(got.held).toBe(false);
    expect(got.reason).toBe('no-home');
  });

  // ── whole-home scan (the `resume --last` / drifted-id case) ──────────────────
  it('scans the whole home when no session id is known, and names which thread is live', () => {
    // psu resumes a tracked row with no recorded native id as `resume --last`, and an
    // adv row's recorded id can drift from the running thread after a carry-respawn
    // (#18052 recorded 01a036a4-… while 01a038ff-… was live).
    const home = homeWithLocks(['.coordination.lock', `${LIVE_THREAD}.lock`]);
    const got = codexThreadWriterHolder(home, null, {
      readProcLocks: () => PROC_LOCKS,
      // Cast the whole function: the real default is fs.statSync, whose overloaded
      // StatSyncFn signature a plain (p: string) => … does not satisfy.
      statFile: ((p: string) =>
        p.includes(LIVE_THREAD) ? HELD : { dev: 66307, ino: 7 }) as never,
    });
    expect(got.held).toBe(true);
    expect(got.sessionId).toBe(LIVE_THREAD);
  });

  it('never treats .coordination.lock as a thread', () => {
    // It is not a uuid and is always present; matching it would report every home live.
    const home = homeWithLocks(['.coordination.lock']);
    const got = codexThreadWriterHolder(home, null, {
      readProcLocks: () => PROC_LOCKS,
      statFile: () => HELD as never,
    });
    expect(got.held).toBe(false);
  });
});

describe('codexResumeHome', () => {
  it('prefers an explicit codexHome (WI-3884 disk-scan hit) that exists', () => {
    const home = homeWithLocks([]);
    expect(codexResumeHome({ agent: 'codex', codexHome: home, id: 999 })).toBe(home);
  });

  it('derives session-<adv id> when no explicit home is recorded', () => {
    expect(codexResumeHome({ agent: 'codex', id: 18052 }, '/home/x')).toBe(
      '/home/x/.papercusp/su-codex-homes/session-18052',
    );
  });

  it('falls back to the row derivation when the explicit home does not exist', () => {
    expect(
      codexResumeHome({ agent: 'codex', codexHome: join(dir, 'gone'), id: 18052 }, '/home/x'),
    ).toBe('/home/x/.papercusp/su-codex-homes/session-18052');
  });

  it('is null for non-codex agents and for a row with nothing to derive from', () => {
    expect(codexResumeHome({ agent: 'claude', id: 18052 })).toBeNull();
    expect(codexResumeHome({ agent: 'codex' })).toBeNull();
  });
});

describe('codexActiveWriterMessage', () => {
  const holder = { held: true, pid: 256282, lockPath: '/h/thread-writer-locks/x.lock', sessionId: LIVE_THREAD };

  it('names the holder pid so the owner can identify what is running', () => {
    const msg = codexActiveWriterMessage({ agent: 'codex', sessionId: LIVE_THREAD }, holder);
    expect(msg).toContain('256282');
    expect(msg).toContain(LIVE_THREAD);
  });

  it('states plainly that PSU_FORCE_RESUME does NOT bypass it', () => {
    // The whole point of the message: force overrides psu's guard, not codex's lock.
    // Omitting this just relocates the confusion one step later.
    const msg = codexActiveWriterMessage({ agent: 'codex', sessionId: LIVE_THREAD }, holder);
    expect(msg).toMatch(/PSU_FORCE_RESUME=1 does NOT bypass/i);
  });

  it('offers the verified run-alongside route (--fork) with the real session id', () => {
    const msg = codexActiveWriterMessage({ agent: 'codex', sessionId: LIVE_THREAD }, holder);
    expect(msg).toContain(`psu --resume=${LIVE_THREAD} --fork`);
  });

  it('offers waking the live agent, addressed to its coord owner when known', () => {
    const msg = codexActiveWriterMessage(
      { agent: 'codex', sessionId: LIVE_THREAD, coordOwnerId: 'su-868f3056' },
      holder,
    );
    expect(msg).toContain('su-868f3056');
    expect(msg).toContain('coord:send');
  });

  it('quotes codex’s own error text so the message is searchable from the symptom', () => {
    const msg = codexActiveWriterMessage({ agent: 'codex', sessionId: LIVE_THREAD }, holder);
    expect(msg).toContain('already has an active writer');
  });
});

// ── calibration against the real kernel ──────────────────────────────────────
// The parser matches a format this repo does not own. A sample string proving the
// parser matches itself would pass just as happily if /proc/locks changed shape, so
// this takes a REAL flock and asserts we find it. Skipped (not failed) where the
// instrument is unavailable — asserting there would be a verdict about the runner,
// not about the code.
describe('calibration: a real flock is visible through the real /proc/locks', () => {
  const haveProcLocks = (() => {
    try {
      return readFileSync('/proc/locks', 'utf8').length > 0;
    } catch {
      return false;
    }
  })();
  const haveFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;

  it.runIf(haveProcLocks && haveFlock)('finds the pid of a live flock holder', async () => {
    const lockPath = join(dir, 'calibration.lock');
    writeFileSync(lockPath, '');
    // Keep the lock and sleep in one PID. Killing flock's default shell child
    // otherwise leaves its sleep descendant alive in the test runner's scope.
    const holder = spawn('flock', ['--no-fork', '-x', lockPath, 'sleep', '10'], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    try {
      const st = statSync(lockPath);
      const { major, minor } = devMajorMinor(st.dev);
      let pid: number | null = null;
      // flock's own exec takes a moment to register with the kernel.
      for (let i = 0; i < 50 && pid === null; i++) {
        pid = findFlockWriteHolderPid(readFileSync('/proc/locks', 'utf8'), {
          major,
          minor,
          inode: Number(st.ino),
        });
        if (pid === null) await new Promise((r) => setTimeout(r, 20));
      }
      expect(pid).not.toBeNull();

      // Periodic identity must see the same real flock through process-local
      // evidence without reading the global lock table.
      let localHolder = null;
      for (let i = 0; i < 50 && localHolder === null; i++) {
        localHolder = findFlockWriteHolderPid(readLinuxProcessFlockText(holder.pid!), {
          major, minor, inode: Number(st.ino),
        });
        if (localHolder === null) await new Promise((r) => setTimeout(r, 20));
      }
      expect(localHolder).toBe(pid);
      expect(readFileSync(`/proc/${holder.pid}/task/${holder.pid}/children`, 'utf8').trim()).toBe('');

      // NEGATIVE CONTROL, same instrument: an inode nobody locked must read as free.
      // Without this, a parser that returned the first WRITE row it saw would pass above.
      const freePath = join(dir, 'unlocked.lock');
      writeFileSync(freePath, '');
      const freeSt = statSync(freePath);
      expect(
        findFlockWriteHolderPid(readFileSync('/proc/locks', 'utf8'), {
          ...devMajorMinor(freeSt.dev),
          inode: Number(freeSt.ino),
        }),
      ).toBeNull();
    } finally {
      holder.kill('SIGKILL');
      await exited;
    }
  });
});
