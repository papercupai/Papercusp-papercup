/**
 * WI-6554700010008488 — the spawner sidecar's org-admin pool wedged for ~40 min
 * (2026-10-11 07:24-08:06Z): every admission ran out its 45s begin(admin)
 * deadline, git-sync committed nothing, and only killing the sidecar cleared it.
 *
 * These tests pin the recurrence guard: consecutive acquisition deadlines with no
 * success in between trip the breaker once, and the trip drains then exits with a
 * distinct code so the host's bounded respawn replaces the process. The deadline
 * is built from the REAL DbCallDeadlineError wrapped in the REAL
 * AdmissionPersistenceError (the exact shape queue.ts throws), so a rename of
 * either error's fields fails here instead of silently disarming the breaker.
 */
import { describe, expect, it, vi } from 'vitest';
import { DbCallDeadlineError } from '@papercusp/db-org';

import { AdmissionPersistenceError } from '../resource-governor/admission';
import {
  ADMISSION_WEDGE_DEFAULT_MIN_SPAN_MS,
  ADMISSION_WEDGE_DEFAULT_THRESHOLD,
  createAdmissionWedgeBreaker,
  createAdmissionWedgeExitHandler,
  findAcquisitionDeadline,
  observeAdmission,
  SIDECAR_ADMISSION_WEDGE_EXIT_GRACE_MS,
  SIDECAR_EXIT_ADMISSION_WEDGED,
  type AdmissionWedgeTrip,
} from './sidecar-admission-wedge';
import { execProcess } from './sidecar-exec-process';
import { isSidecarInfrastructureFault } from './git-via-sidecar';
import { SIDECAR_EXIT_SOCKET_IN_USE } from '../sidecar-socket/pid-keyed-socket';

/** The production shape: queue.ts wraps the driver error as `cause`. */
function wedgedAdmissionError(): AdmissionPersistenceError {
  const deadline = new DbCallDeadlineError('boundedOrgTxn:begin(admin)', 45_000, 45_001);
  // The pool is assigned directly: passing it to the constructor would read the
  // process-wide acquire-pressure registry, which is not what this test measures.
  (deadline as { pool: string | null }).pool = 'org-admin';
  return new AdmissionPersistenceError('durable admission record could not be persisted: deadline', {
    cause: deadline,
  });
}

function clock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('findAcquisitionDeadline', () => {
  it('finds the real DbCallDeadlineError through the AdmissionPersistenceError cause', () => {
    expect(findAcquisitionDeadline(wedgedAdmissionError())).toEqual({
      label: 'boundedOrgTxn:begin(admin)',
      pool: 'org-admin',
    });
  });

  it('finds a bare deadline with no pool', () => {
    expect(findAcquisitionDeadline(new DbCallDeadlineError('x', 10, 11))).toEqual({ label: 'x', pool: null });
  });

  it('ignores request faults that carry no deadline anywhere in the chain', () => {
    expect(findAcquisitionDeadline(new AdmissionPersistenceError('corrupt governor record'))).toBeNull();
    expect(findAcquisitionDeadline(new Error('boom', { cause: new Error('inner') }))).toBeNull();
    expect(findAcquisitionDeadline('a string')).toBeNull();
    expect(findAcquisitionDeadline(undefined)).toBeNull();
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(findAcquisitionDeadline(a)).toBeNull();
  });
});

describe('createAdmissionWedgeBreaker', () => {
  it('defaults: 3 deadlines spanning at least 90s', () => {
    expect(ADMISSION_WEDGE_DEFAULT_THRESHOLD).toBe(3);
    expect(ADMISSION_WEDGE_DEFAULT_MIN_SPAN_MS).toBe(90_000);
  });

  it('trips exactly once on a sustained run of deadlines, naming the pool', () => {
    const c = clock();
    const trips: AdmissionWedgeTrip[] = [];
    const breaker = createAdmissionWedgeBreaker({ now: c.now, onTrip: (t) => trips.push(t) });

    breaker.recordFailure(wedgedAdmissionError());
    c.advance(45_000);
    breaker.recordFailure(wedgedAdmissionError());
    expect(trips).toHaveLength(0);
    c.advance(45_000);
    breaker.recordFailure(wedgedAdmissionError());

    expect(trips).toHaveLength(1);
    expect(breaker.tripped).toBe(true);
    expect(trips[0]).toMatchObject({
      consecutiveDeadlines: 3,
      label: 'boundedOrgTxn:begin(admin)',
      pool: 'org-admin',
    });
    expect(trips[0]!.lastDeadlineAtMs - trips[0]!.firstDeadlineAtMs).toBe(90_000);
    expect(trips[0]!.reason).toContain('org-admin');

    c.advance(45_000);
    breaker.recordFailure(wedgedAdmissionError());
    expect(trips).toHaveLength(1);
  });

  it('does not trip on a fast burst: the run must also span minSpanMs', () => {
    const c = clock();
    const onTrip = vi.fn();
    const breaker = createAdmissionWedgeBreaker({ now: c.now, onTrip });
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure(wedgedAdmissionError());
      c.advance(1_000);
    }
    expect(onTrip).not.toHaveBeenCalled();
    expect(breaker.consecutiveDeadlines).toBe(5);
    c.advance(90_000);
    breaker.recordFailure(wedgedAdmissionError());
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('any successful admission resets the run', () => {
    const c = clock();
    const onTrip = vi.fn();
    const breaker = createAdmissionWedgeBreaker({ now: c.now, onTrip });
    breaker.recordFailure(wedgedAdmissionError());
    c.advance(60_000);
    breaker.recordFailure(wedgedAdmissionError());
    breaker.recordSuccess();
    expect(breaker.consecutiveDeadlines).toBe(0);
    c.advance(60_000);
    breaker.recordFailure(wedgedAdmissionError());
    expect(onTrip).not.toHaveBeenCalled();
  });

  it('request faults neither count toward nor reset the run', () => {
    const c = clock();
    const onTrip = vi.fn();
    const breaker = createAdmissionWedgeBreaker({ now: c.now, onTrip });
    for (let i = 0; i < 10; i += 1) breaker.recordFailure(new AdmissionPersistenceError('corrupt record'));
    expect(breaker.consecutiveDeadlines).toBe(0);

    breaker.recordFailure(wedgedAdmissionError());
    c.advance(45_000);
    breaker.recordFailure(new AdmissionPersistenceError('corrupt record'));
    breaker.recordFailure(wedgedAdmissionError());
    c.advance(45_000);
    breaker.recordFailure(wedgedAdmissionError());
    expect(onTrip).toHaveBeenCalledTimes(1);
  });
});

describe('observeAdmission', () => {
  it('passes the result through and records success', async () => {
    const observer = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    const begin = observeAdmission(async (n: number) => n * 2, observer);
    await expect(begin(21)).resolves.toBe(42);
    expect(observer.recordSuccess).toHaveBeenCalledTimes(1);
    expect(observer.recordFailure).not.toHaveBeenCalled();
  });

  it('rethrows the SAME admission error after recording it', async () => {
    const observer = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    const error = wedgedAdmissionError();
    const begin = observeAdmission(async () => {
      throw error;
    }, observer);
    await expect(begin()).rejects.toBe(error);
    expect(observer.recordFailure).toHaveBeenCalledWith(error);
    expect(observer.recordSuccess).not.toHaveBeenCalled();
  });

  it('an observer fault never changes the admission outcome', async () => {
    const observer = {
      recordSuccess: () => {
        throw new Error('observer broke');
      },
      recordFailure: () => {
        throw new Error('observer broke');
      },
    };
    await expect(observeAdmission(async () => 'ok', observer)()).resolves.toBe('ok');
    const error = new Error('admission');
    await expect(
      observeAdmission(async () => {
        throw error;
      }, observer)(),
    ).rejects.toBe(error);
  });

  it('is the identity when no observer is supplied', () => {
    const begin = async () => 1;
    expect(observeAdmission(begin, undefined)).toBe(begin);
  });
});

describe('createAdmissionWedgeExitHandler', () => {
  const trip: AdmissionWedgeTrip = {
    consecutiveDeadlines: 3,
    firstDeadlineAtMs: 0,
    lastDeadlineAtMs: 90_000,
    label: 'boundedOrgTxn:begin(admin)',
    pool: 'org-admin',
    reason: 'wedged',
  };

  it('uses a code the host respawns on (never the deliberate socket-in-use code)', () => {
    expect(SIDECAR_EXIT_ADMISSION_WEDGED).not.toBe(SIDECAR_EXIT_SOCKET_IN_USE);
    expect(SIDECAR_EXIT_ADMISSION_WEDGED).not.toBe(0);
  });

  it('marks the drain code, starts a graceful shutdown, and arms a hard exit', () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const deps = {
      pid: 4242,
      requestShutdown: vi.fn(),
      setDrainExitCode: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
      setTimer: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
      },
    };
    const onTrip = createAdmissionWedgeExitHandler(deps);
    onTrip(trip);

    expect(deps.setDrainExitCode).toHaveBeenCalledWith(SIDECAR_EXIT_ADMISSION_WEDGED);
    expect(deps.requestShutdown).toHaveBeenCalledWith('admission-wedge');
    expect(deps.log.mock.calls[0]![0]).toContain('pid 4242 ADMISSION WEDGE: wedged');
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(SIDECAR_ADMISSION_WEDGE_EXIT_GRACE_MS);
    expect(deps.exit).not.toHaveBeenCalled();

    // The drain waited on the dead pool: the hard exit fires anyway.
    timers[0]!.fn();
    expect(deps.exit).toHaveBeenCalledWith(SIDECAR_EXIT_ADMISSION_WEDGED);

    // A second trip must not double-arm or re-request shutdown.
    onTrip(trip);
    expect(timers).toHaveLength(1);
    expect(deps.requestShutdown).toHaveBeenCalledTimes(1);
  });
});

describe('execProcess with an admission pool that never yields a connection', () => {
  it('reports the sidecar pid, feeds every failure to the breaker, and trips on the third', async () => {
    const c = clock();
    const onTrip = vi.fn();
    const breaker = createAdmissionWedgeBreaker({ now: c.now, onTrip });
    // Every begin behaves like the measured wedge: the deadline, wrapped as queue.ts wraps it.
    const begin = vi.fn(async () => {
      throw wedgedAdmissionError();
    });
    // A non-read-only command is admitted BEFORE any child exists, so nothing spawns here.
    const run = () =>
      execProcess(
        { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 20_000 },
        { beginExecution: begin, admissionHealth: breaker },
      );

    for (let i = 0; i < 3; i += 1) {
      const result = await run();
      expect(result.code).toBe(-1);
      // The real classifier must still read it as a sidecar infrastructure fault (callers then fall
      // back to local git); the pid names WHICH sidecar is wedged.
      expect(isSidecarInfrastructureFault(result)).toBe(true);
      expect(result.stderr.startsWith('spawner sidecar admission failed')).toBe(true);
      expect(result.stderr).toContain(`(sidecar pid ${process.pid})`);
      if (i < 2) {
        expect(onTrip).not.toHaveBeenCalled();
        c.advance(45_000);
      }
    }

    expect(begin).toHaveBeenCalledTimes(3);
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip.mock.calls[0]![0]).toMatchObject({ consecutiveDeadlines: 3, pool: 'org-admin' });
  });
});
