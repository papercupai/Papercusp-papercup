import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type MainThreadActivity,
  AT_FDCWD,
  decodeProcPath,
  parseProcSyscallTarget,
  parseProcStat,
  parseProcDirectoryFd,
  parseCpuPressureSomeAvg60,
  classifyThreadCpu,
  isConfirmedHostIoWait,
  isLikelySyncSubprocessBlock,
  isConfirmedCpuStarvation,
  USER_HZ,
} from './proc-thread-cpu';

/**
 * Post-')' tokens are [0]=state … [11]=utime [12]=stime, so this line carries
 * utime=500, stime=200 => 700 ticks.
 */
const STAT = '4242 (node) S 1 4242 4242 0 -1 4194560 12345 0 0 0 500 200 0 0 20 0 11 0 999';

describe('parseProcStat', () => {
  it('reads state and summed CPU ticks', () => {
    expect(parseProcStat(STAT)).toEqual({ state: 'S', ticks: 700 });
  });

  it('survives a comm containing spaces AND parentheses', () => {
    // The whole reason for splitting on the LAST ')' rather than whitespace: a
    // naive split mis-indexes every field after comm and silently returns a
    // plausible-looking wrong number.
    const nasty = '4242 (node (worker) thing) R 1 4242 4242 0 -1 4194560 1 0 0 0 900 100 0 0 20 0 11 0 999';
    expect(parseProcStat(nasty)).toEqual({ state: 'R', ticks: 1000 });
  });

  it('returns null (never a zero) on unparseable input', () => {
    expect(parseProcStat('')).toBeNull();
    expect(parseProcStat('no parens here')).toBeNull();
    expect(parseProcStat('4242 (node) S 1 2 3')).toBeNull(); // too few fields
    expect(parseProcStat('4242 (node) S 1 4242 4242 0 -1 4194560 1 0 0 0 xx yy 0 0 20 0')).toBeNull();
  });
});

describe('parseProcDirectoryFd', () => {
  it('extracts getdents64 arg0 from the measured iterate_dir shape', () => {
    expect(
      parseProcDirectoryFd(
        '217 0x19 0x7f10a4001000 0x8000 0x0 0x0 0x0 0x7ffd01 0x7f10ff',
        'iterate_dir',
      ),
    ).toBe(25);
  });

  it('accepts the decimal argument rendering used by some kernels', () => {
    expect(parseProcDirectoryFd('217 7 4096 32768 0 0 0 0 0', 'iterate_dir')).toBe(7);
  });

  it.each([
    ['', 'iterate_dir'],
    ['running', 'iterate_dir'],
    ['217 nope 0x1', 'iterate_dir'],
    ['217 -1 0x1', 'iterate_dir'],
    ['217 0x19 0x1', 'ep_poll'],
    ['217 0x19 0x1', null],
  ])('returns null instead of inventing a directory fd (%s, %s)', (raw, wchan) => {
    expect(parseProcDirectoryFd(raw, wchan)).toBeNull();
  });
});

describe('parseProcSyscallTarget (WI-10004754)', () => {
  it('reads an fd syscall: arg0 is the fd', () => {
    expect(parseProcSyscallTarget('1 0x17 0x7f00aa 0x1000 0x0 0x0 0x0 0x7ffd 0x7f12', 'x64')).toEqual({ nr: 1, name: 'write', fd: 23 });
    expect(parseProcSyscallTarget('74 0x5 0x0 0x0 0x0 0x0 0x0 0x7ffd 0x7f12', 'x64')).toEqual({ nr: 74, name: 'fsync', fd: 5 });
  });

  it('reads an *at syscall: arg0 dirfd (AT_FDCWD in either sign extension), arg1 path pointer', () => {
    for (const dirfd of ['0xffffff9c', '0xffffffffffffff9c']) {
      expect(parseProcSyscallTarget(`257 ${dirfd} 0x7f3a10002a40 0x80000 0x0 0x0 0x0 0x7ffd 0x7f12`, 'x64')).toEqual({
        nr: 257, name: 'openat', pathPtr: 0x7f3a10002a40, dirFd: AT_FDCWD,
      });
    }
    expect(parseProcSyscallTarget('262 0x9 0x55aa00 0x7ffd 0x0 0x0 0x0 0x7ffd 0x7f12', 'x64')).toMatchObject({ name: 'newfstatat', dirFd: 9 });
  });

  it('reads a path0 syscall: arg0 is the path pointer', () => {
    expect(parseProcSyscallTarget('87 0x55aa10 0x0 0x0 0x0 0x0 0x0 0x7ffd 0x7f12', 'x64')).toEqual({ nr: 87, name: 'unlink', pathPtr: 0x55aa10 });
  });

  it('is UNKNOWN (null), never a guessed file, for every non-attributable shape', () => {
    for (const raw of [
      'running',
      '-1 0x7ffd 0x7f12', // blocked, not in a syscall
      '7 0x0 0x0 0x0 0x0 0x0 0x0 0x7ffd 0x7f12', // poll: not a file syscall
      '257 0x5 0x0 0x80000 0x0 0x0 0x0 0x7ffd 0x7f12', // NULL path pointer
      '257 0xfffffff0 0x55aa 0x0 0x0 0x0 0x0 0x7ffd 0x7f12', // negative dirfd that is not AT_FDCWD
      '1 0xffffffff 0x0 0x0 0x0 0x0 0x0 0x7ffd 0x7f12', // fd -1
      '1 zz 0x0', // malformed argument
      '',
    ]) {
      expect(parseProcSyscallTarget(raw, 'x64'), raw).toBeNull();
    }
  });

  it('refuses other architectures: syscall numbers are arch-specific', () => {
    expect(parseProcSyscallTarget('1 0x17 0x0 0x0 0x0 0x0 0x0 0x7ffd 0x7f12', 'arm64')).toBeNull();
  });
});

describe('decodeProcPath', () => {
  it('decodes up to the NUL, and refuses a read with no NUL (truncated) or an empty string', () => {
    const enc = new TextEncoder();
    const bytes = new Uint8Array([...enc.encode('/home/x/.papercusp/a b.json'), 0, 0x41]);
    expect(decodeProcPath(bytes, bytes.length)).toBe('/home/x/.papercusp/a b.json');
    expect(decodeProcPath(enc.encode('/no/terminator'), 14)).toBeNull();
    expect(decodeProcPath(new Uint8Array([0, 0x41]), 2)).toBeNull();
    expect(decodeProcPath(bytes, 5)).toBeNull(); // the NUL lies past the bytes actually read
  });
});

/**
 * Real-kernel check: the parser must match what Linux actually prints, not only
 * the hand-written lines above (AT_FDCWD sign extension, hex formatting). A
 * child `cat` blocks in openat(2) on a FIFO with no writer; as its parent we may
 * read its /proc/<pid>/{syscall,mem} under Yama ptrace_scope 1, exactly as the
 * in-process sentinel reads its own.
 */
describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('parseProcSyscallTarget against a real blocked openat', () => {
  async function blockedSyscallLine(pid: number): Promise<string> {
    for (let i = 0; i < 150; i++) {
      const raw = readFileSync(`/proc/${pid}/syscall`, 'utf8');
      if (raw.startsWith('257 ')) return raw;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`child ${pid} never blocked in openat`);
  }

  function readPath(pid: number, ptr: number): string | null {
    const len = Math.min(512, 4096 - (ptr % 4096));
    const buf = new Uint8Array(len);
    const fd = openSync(`/proc/${pid}/mem`, 'r');
    try {
      return decodeProcPath(buf, readSync(fd, buf, 0, len, ptr));
    } finally {
      closeSync(fd);
    }
  }

  for (const relative of [false, true]) {
    it(`names the ${relative ? 'relative (cwd-anchored)' : 'absolute'} path the thread is blocked opening`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'proc-syscall-'));
      const fifo = join(dir, 'blocked fifo');
      execFileSync('mkfifo', [fifo]);
      const child = spawn('cat', [relative ? 'blocked fifo' : fifo], { cwd: dir, stdio: 'ignore' });
      try {
        const pid = child.pid!;
        const target = parseProcSyscallTarget(await blockedSyscallLine(pid), process.arch);
        expect(target).toMatchObject({ name: 'openat', dirFd: AT_FDCWD });
        const path = readPath(pid, target!.pathPtr!);
        expect(path).toBe(relative ? 'blocked fifo' : fifo);
        if (relative) expect(`${readlinkSync(`/proc/${pid}/cwd`)}/${path}`).toBe(fifo);
      } finally {
        child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('parseCpuPressureSomeAvg60', () => {
  it('parses the kernel CPU PSI some avg60 percentage', () => {
    expect(
      parseCpuPressureSomeAvg60(
        'some avg10=96.00 avg60=85.25 avg300=42.00 total=12345\n',
      ),
    ).toBe(85.25);
  });

  it.each([
    '',
    'full avg10=0.00 avg60=0.00 avg300=0.00 total=0',
    'some avg10=1.00 avg300=2.00 total=3',
    'some avg10=1.00 avg60=NaN avg300=2.00 total=3',
    'some avg10=1.00 avg60=101.00 avg300=2.00 total=3',
  ])('returns null for unknown or invalid pressure (%s)', (raw) => {
    expect(parseCpuPressureSomeAvg60(raw)).toBeNull();
  });
});

describe('classifyThreadCpu', () => {
  const base = { elapsedMs: 1000, userHz: USER_HZ };

  it('calls a full core of CPU across the window SPINNING', () => {
    // 100 ticks @ 100Hz = 1000ms of CPU over a 1000ms window = 1.0 cores.
    const v = classifyThreadCpu({ ...base, baselineTicks: 0, currentTicks: 100 });
    expect(v.kind).toBe('spinning');
    expect(v.cpuMs).toBe(1000);
    expect(v.cores).toBeCloseTo(1.0, 5);
    expect(v.suspectWrongSubject).toBe(false);
  });

  it('calls a thread that burned no CPU PARKED', () => {
    const v = classifyThreadCpu({ ...base, baselineTicks: 700, currentTicks: 700 });
    expect(v.kind).toBe('parked');
    expect(v.cpuMs).toBe(0);
    expect(v.cores).toBe(0);
  });

  it('calls an in-between reading PARTIAL rather than forcing a verdict', () => {
    // 20 ticks = 200ms over 1000ms = 0.2 cores: above parked, below spinning.
    const v = classifyThreadCpu({ ...base, baselineTicks: 0, currentTicks: 20 });
    expect(v.kind).toBe('partial');
  });

  it('is UNKNOWN — not parked — when either sample is missing', () => {
    // The distinction this whole module exists for: an unreadable sample must
    // never render as 0 CPU, because 0 reads as "idle" and sends the next
    // investigation at the wrong subsystem.
    for (const opts of [
      { ...base, baselineTicks: null, currentTicks: 100 },
      { ...base, baselineTicks: 0, currentTicks: null },
      { ...base, baselineTicks: null, currentTicks: null },
    ]) {
      const v = classifyThreadCpu(opts);
      expect(v.kind).toBe('unknown');
      expect(v.cpuMs).toBeNull();
      expect(v.cores).toBeNull();
    }
  });

  it('is UNKNOWN when the window is zero/negative or the clock rate is bogus', () => {
    expect(classifyThreadCpu({ ...base, elapsedMs: 0, baselineTicks: 0, currentTicks: 100 }).kind)
      .toBe('unknown');
    expect(classifyThreadCpu({ ...base, elapsedMs: -5, baselineTicks: 0, currentTicks: 100 }).kind)
      .toBe('unknown');
    expect(classifyThreadCpu({ ...base, userHz: 0, baselineTicks: 0, currentTicks: 100 }).kind)
      .toBe('unknown');
  });

  it('is UNKNOWN when the counter went BACKWARDS (the thread was replaced)', () => {
    // A restarted process re-uses the pid with a fresh counter; differencing
    // across that boundary is not a measurement of anything.
    const v = classifyThreadCpu({ ...base, baselineTicks: 900, currentTicks: 100 });
    expect(v.kind).toBe('unknown');
    expect(v.cpuMs).toBeNull();
  });

  it('flags a reading that exceeds one thread as the WRONG SUBJECT', () => {
    // >1.5 cores is impossible for a single thread, so the sample almost
    // certainly came from the process-wide stat file (all threads summed).
    // Surfaced rather than swallowed: the number is not noise, it is about
    // something else, and silently reporting it is how "the main thread is
    // busy" gets concluded about a parked main thread with busy children.
    const v = classifyThreadCpu({ ...base, baselineTicks: 0, currentTicks: 400 });
    expect(v.suspectWrongSubject).toBe(true);
    expect(v.cores).toBeCloseTo(4.0, 5);
  });

  it('does not flag wrong-subject for a legitimately saturated single thread', () => {
    const v = classifyThreadCpu({ ...base, baselineTicks: 0, currentTicks: 100 });
    expect(v.suspectWrongSubject).toBe(false);
  });
});

describe('isConfirmedHostIoWait', () => {
  it('recognizes the recorded rq_qos_wait false-kill diagnostic', () => {
    expect(
      isConfirmedHostIoWait({
        cpuKind: 'parked',
        state: 'D',
        cpuMs: 0,
        cores: 0,
        wchan: 'rq_qos_wait',
      }),
    ).toBe(true);
  });

  it('recognizes other storage wait channels from the incident evidence', () => {
    // WI-10004559 measured readdirSync stalls in D-state at `iterate_dir` on
    // ~/.papercusp/psu-pty immediately before the sentinel killed the worker.
    // EI-25737307746524840 measured a D-state, zero-CPU `lookup_slow` stall
    // immediately before the sentinel killed an in-flight MCP request's host.
    for (const wchan of [
      'io_schedule',
      'io_schedule_timeout',
      'wait_on_buffer',
      'jbd2_log_wait_commit',
      '__jbd2_log_wait_for_space',
      'iterate_dir',
      'lookup_slow',
    ]) {
      expect(isConfirmedHostIoWait({ cpuKind: 'parked', state: 'D', cpuMs: 0, cores: 0, wchan })).toBe(true);
    }
  });

  it('accepts the measured low-nonzero parked lookup_slow wait and rejects a nearby partial sample', () => {
    // The observed D-state lookup_slow sample accumulated 50 ms of CPU over
    // 24,023 ms. That is about 0.00208 cores, inside classifyThreadCpu's
    // existing parked boundary.
    const measured = classifyThreadCpu({
      baselineTicks: 1000,
      currentTicks: 1005,
      elapsedMs: 24_023,
      userHz: 100,
    });
    expect(measured.kind).toBe('parked');
    expect(measured.cpuMs).toBe(50);
    expect(measured.cores).toBeCloseTo(50 / 24_023, 8);
    expect(
      isConfirmedHostIoWait({
        cpuKind: measured.kind,
        state: 'D',
        cpuMs: measured.cpuMs,
        cores: measured.cores,
        wchan: 'lookup_slow',
      }),
    ).toBe(true);

    // 0.051 cores sits just above the 0.05 parked boundary and must keep the
    // normal sentinel kill path available even with the same D-state/wchan.
    const partial = classifyThreadCpu({
      baselineTicks: 1000,
      currentTicks: 1051,
      elapsedMs: 10_000,
      userHz: 100,
    });
    expect(partial.kind).toBe('partial');
    expect(partial.cores).toBeCloseTo(0.051, 8);
    expect(
      isConfirmedHostIoWait({
        cpuKind: partial.kind,
        state: 'D',
        cpuMs: partial.cpuMs,
        cores: partial.cores,
        wchan: 'lookup_slow',
      }),
    ).toBe(false);
  });

  it('does not suppress the recorded spinning/futex wedge', () => {
    expect(
      isConfirmedHostIoWait({
        cpuKind: 'spinning',
        state: 'R',
        cpuMs: 910,
        cores: 0.91,
        wchan: 'futex_do_wait',
      }),
    ).toBe(false);
  });

  it.each<MainThreadActivity>([
    { cpuKind: 'partial', state: 'D', cpuMs: 51, cores: 0.051, wchan: 'rq_qos_wait' },
    { cpuKind: 'parked', state: 'S', cpuMs: 0, cores: 0, wchan: 'rq_qos_wait' },
    { cpuKind: 'parked', state: 'D', cpuMs: 0, cores: 0, wchan: 'futex_do_wait' },
    { cpuKind: 'unknown', state: 'D', cpuMs: null, cores: null, wchan: 'rq_qos_wait' },
    { state: 'D', cpuMs: 0, cores: 0, wchan: 'rq_qos_wait' },
    { cpuKind: 'parked', state: 'D', cpuMs: 0, cores: 0, wchan: null },
  ])('requires a parked D-state sample on a recognized storage channel (%o)', (activity) => {
    expect(isConfirmedHostIoWait(activity)).toBe(false);
  });
});

describe('isLikelySyncSubprocessBlock', () => {
  /**
   * The exact field values the sentinel printed on the 2026-09-03 12:41:29
   * papercusp-bg-host kill. CALIBRATION CASE: if this ever stops being true the
   * suite below is passing vacuously, because every other case here is a
   * negative and negatives alone cannot tell a working predicate from one that
   * always returns false.
   */
  const MEASURED_BG_HOST_KILL = {
    state: 'S',
    cpuMs: 0,
    cores: 0,
    wchan: 'ep_poll',
  } as const;

  it('recognises the measured bg-host signature that twice read as "healthy idle"', () => {
    expect(isLikelySyncSubprocessBlock(MEASURED_BG_HOST_KILL)).toBe(true);
  });

  it.each(['ep_poll', 'do_epoll_wait', 'do_sys_poll', 'do_select', 'poll_schedule_timeout'])(
    'recognises loop-poll wait channel %s',
    (wchan) => {
      expect(isLikelySyncSubprocessBlock({ state: 'S', cpuMs: 0, cores: 0, wchan })).toBe(true);
    },
  );

  it.each([
    // Burning CPU: a synchronous JS loop / GC, not a subprocess wait.
    { state: 'S', cpuMs: 4200, cores: 0.9, wchan: 'ep_poll' },
    // D-state block I/O: the OTHER predicate's domain, and the only one that
    // may suppress a kill. These two must never both claim the same sample.
    { state: 'D', cpuMs: 0, cores: 0, wchan: 'io_schedule' },
    // Runnable — not parked at all.
    { state: 'R', cpuMs: 0, cores: 0, wchan: 'ep_poll' },
    // Parked, but not in a loop poll: futex waits are a different failure.
    { state: 'S', cpuMs: 0, cores: 0, wchan: 'futex_wait_queue_me' },
    // Unreadable wchan is UNKNOWN, never a positive claim.
    { state: 'S', cpuMs: 0, cores: 0, wchan: null },
    // Unmeasured CPU must not be treated as zero.
    { state: 'S', cpuMs: null, cores: null, wchan: 'ep_poll' },
  ])('requires all sync-subprocess discriminator fields (%o)', (activity) => {
    expect(isLikelySyncSubprocessBlock(activity)).toBe(false);
  });

  it('never claims the same sample as the host-I/O-wait suppressor', () => {
    const samples = [
      MEASURED_BG_HOST_KILL,
      { state: 'D', cpuMs: 0, cores: 0, wchan: 'io_schedule' },
      { state: 'D', cpuMs: 0, cores: 0, wchan: 'ep_poll' },
      { state: 'S', cpuMs: 0, cores: 0, wchan: 'io_schedule' },
    ];
    for (const s of samples) {
      expect(isLikelySyncSubprocessBlock(s) && isConfirmedHostIoWait(s)).toBe(false);
    }
  });

  /**
   * FALSIFIABILITY CONTROL. The tempting reading of the incident was "0 CPU
   * means the host is idle" — a predicate keyed on cpuMs alone. Run it beside
   * the shipped one to prove the `state`/`wchan` discriminators are
   * load-bearing rather than decoration: the naive one cannot tell a
   * block-I/O stall from a synchronous-subprocess block, which is exactly the
   * conflation that would misroute the next investigation.
   */
  it('is stricter than a naive cpu-only predicate (discriminators are load-bearing)', () => {
    const naiveCpuOnly = (a: { cpuMs: number | null }) => a.cpuMs === 0;
    const hostIoWait = { state: 'D', cpuMs: 0, cores: 0, wchan: 'io_schedule' };

    // The naive predicate cannot separate them; the shipped one does.
    expect(naiveCpuOnly(hostIoWait)).toBe(true);
    expect(naiveCpuOnly(MEASURED_BG_HOST_KILL)).toBe(true);
    expect(isLikelySyncSubprocessBlock(hostIoWait)).toBe(false);
    expect(isLikelySyncSubprocessBlock(MEASURED_BG_HOST_KILL)).toBe(true);
  });
});

describe('isConfirmedCpuStarvation', () => {
  const measuredStarvation = {
    cpuKind: 'spinning' as const,
    state: 'R',
    cpuMs: 15_800,
    cores: 0.99,
    wchan: null,
    cpuPsiSome60: 85,
  };

  it('recognizes the measured high-CPU host-starvation signature', () => {
    expect(isConfirmedCpuStarvation(measuredStarvation)).toBe(true);
  });

  it.each([
    { ...measuredStarvation, cpuPsiSome60: 84.99 },
    { ...measuredStarvation, cpuPsiSome60: null },
    { ...measuredStarvation, cpuKind: 'partial' as const },
    { ...measuredStarvation, state: 'S' },
    { ...measuredStarvation, cores: 1.51 },
  ])('requires every conservative discriminator (%o)', (activity) => {
    expect(isConfirmedCpuStarvation(activity)).toBe(false);
  });

  it('keeps an idle-host synchronous spin killable', () => {
    expect(
      isConfirmedCpuStarvation({
        ...measuredStarvation,
        cpuPsiSome60: 0.5,
      }),
    ).toBe(false);
  });
});
