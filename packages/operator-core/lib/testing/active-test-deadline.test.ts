import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAdmissionFrozenMs, withActiveTestDeadline } from '../../test/_active-test-deadline';

function fixture(initialFrozen: number | null = 0) {
  let now = 0;
  let frozen: number | null = initialFrozen;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const seams = {
    now: () => now,
    frozenMs: () => frozen,
    setTimer: (fn: () => void, delay: number) => {
      timers.set(++nextId, { at: now + delay, fn });
      return nextId;
    },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
  };
  return {
    seams, timers,
    advanceClock(at: number) { now = at; },
    // A stopped process executes no timer callbacks until it resumes.
    resume(at: number, frozenTotal = frozen) {
      now = at;
      frozen = frozenTotal;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

const pending = () => new Promise<never>(() => {});
const policy = { timeoutMs: 60_000, wallTimeoutMs: 600_000 };

function childMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object' || (message as { type?: string }).type !== type) return;
      clean();
      resolve(message as Record<string, unknown>);
    };
    const onError = (error: Error) => { clean(); reject(error); };
    const onExit = (code: number | null, signal: string | null) => {
      clean(); reject(new Error(`Deadline child exited before ${type}: code=${code} signal=${signal}`));
    };
    const timer = setTimeout(() => { clean(); reject(new Error(`Deadline child never sent ${type}`)); }, 15_000);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

describe('active test deadline under pc-heavy suspension', () => {
  it('credits the observed freeze, then still rejects a genuine active hang', async () => {
    const f = fixture(1_000); // Earlier freezes are not this invocation's credit.
    const observed = withActiveTestDeadline(pending, policy, f.seams).catch(error => error);
    f.resume(60_008, 57_932); // Original cold run: 56,932 ms frozen.
    expect([...f.timers.values()].map(timer => timer.at)).toEqual([116_932]);
    f.resume(116_932, 57_932);
    expect(await observed).toMatchObject({ reason: 'active-timeout', timing: {
      wallMs: 116_932, frozenMs: 56_932, activeMs: 60_000, freezeMeasurementAvailable: true,
    } });
    expect(f.timers.size).toBe(0);
  });

  it.runIf(process.platform === 'linux')('distinguishes real body suspension from active time in the same worker', async () => {
    // A builtin-only child suspends its own test-worker parent, never a shared process group.
    // Keep the actual helper in Vitest's current-source plane; the supervisor imports no repo code.
    // Both deadlines observe the same pending body and clock; only freeze credit differs.
    const dir = mkdtempSync(join(tmpdir(), 'active-test-stop-'));
    const state = join(dir, 'controlled.state');
    writeFileSync(state, 'frozen_total_ms=1000\n');
    const script = `
      const { writeFileSync, readFileSync } = await import('node:fs');
      const { performance } = await import('node:perf_hooks');
      const { setTimeout: delay } = await import('node:timers/promises');
      const parent = process.ppid;
      process.on('message', async message => {
        if (message !== 'freeze') return;
        const watchdog = setTimeout(() => {
          process.kill(parent, 'SIGCONT');
          process.exit(2);
        }, 10000);
        let result;
        try {
          const frozenAt = performance.now();
          process.kill(parent, 'SIGSTOP');
          const stopDeadline = performance.now() + 2000;
          while (!/^State:\\s+T/m.test(readFileSync('/proc/' + parent + '/status', 'utf8'))) {
            if (performance.now() >= stopDeadline) throw new Error('Test worker did not enter stopped state');
            await delay(5);
          }
          await delay(2200);
          const frozenMs = Math.ceil(performance.now() - frozenAt);
          writeFileSync(process.env.CONTROLLED_FREEZE_STATE, 'frozen_total_ms=' + (1000 + frozenMs) + '\\n');
          result = { type: 'result', frozenMs };
        } catch (error) {
          result = { type: 'result', failure: String(error) };
        } finally {
          process.kill(parent, 'SIGCONT');
          clearTimeout(watchdog);
        }
        process.send(result, () => process.disconnect());
      });
      process.send({ type: 'loaded' });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, CONTROLLED_FREEZE_STATE: state },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    try {
      await childMessage(child, 'loaded').catch(error => { throw new Error(`${error.message}\n${stderr}`); });
      const body = childMessage(child, 'result');
      const controlledPolicy = { timeoutMs: 2000, wallTimeoutMs: 15000 };
      const observed = (promise: Promise<unknown>) => promise.then(
        value => ({ status: 'passed', value }),
        error => ({ status: 'rejected', reason: error.reason, timing: error.timing }),
      );
      let guardedTiming: unknown;
      const guarded = observed(withActiveTestDeadline(() => body,
        { ...controlledPolicy, onTiming: timing => { guardedTiming = timing; } },
        { frozenMs: () => readAdmissionFrozenMs({ PC_HEAVY_ADMISSION_DIR: dir, PC_HEAVY_ADMISSION_ID: 'controlled' }) }));
      const uncredited = observed(withActiveTestDeadline(() => body, controlledPolicy, { frozenMs: () => 0 }));
      child.send('freeze');
      const [guardedResult, uncreditedResult] = await Promise.all([guarded, uncredited]);
      const result = await body;
      expect(result.failure).toBeUndefined();
      const frozenMs = result.frozenMs;
      expect(guardedResult).toEqual({ status: 'passed', value: result });
      expect(uncreditedResult).toMatchObject({ status: 'rejected', reason: 'active-timeout',
        timing: { frozenMs: 0 } });
      expect(guardedTiming).toMatchObject({ frozenMs, freezeMeasurementAvailable: true });
      expect((guardedTiming as { activeMs: number }).activeMs).toBeLessThan(2000);
      expect((guardedTiming as { wallMs: number }).wallMs).toBeGreaterThanOrEqual(2200);
      console.info('CONTROLLED_DEADLINE_FREEZE', JSON.stringify({ frozenMs, guarded: guardedResult,
        uncredited: uncreditedResult, guardedTiming }));
      expect(await exited).toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGCONT');
        child.kill('SIGKILL');
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Deadline child was not reaped')), 5000);
        exited.then(result => { clearTimeout(timer); resolve(result); });
      });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([null, 0])('keeps the original active bound without freeze evidence (%s)', async baseline => {
    const f = fixture(baseline);
    const observed = withActiveTestDeadline(pending, policy, f.seams).catch(error => error);
    f.resume(60_000);
    expect(await observed).toMatchObject({ reason: 'active-timeout', timing: { activeMs: 60_000, frozenMs: 0 } });
  });

  it('bounds repeated freezes with a separate wall ceiling', async () => {
    const f = fixture();
    const observed = withActiveTestDeadline(pending, policy, f.seams).catch(error => error);
    f.resume(600_000, 599_000);
    expect(await observed).toMatchObject({ reason: 'wall-timeout', timing: { activeMs: 1_000 } });
    expect(f.timers.size).toBe(0);
  });

  it.each([null, 10, Number.NaN])('does not invent credit from a missing, reset or invalid record (%s)', async after => {
    const f = fixture(1_000);
    const observed = withActiveTestDeadline(pending, policy, f.seams).catch(error => error);
    f.resume(60_000, after);
    expect(await observed).toMatchObject({ reason: 'active-timeout', timing: {
      frozenMs: 0, freezeMeasurementAvailable: false,
    } });
  });

  it('clears its timer when the subject passes after thawing', async () => {
    const f = fixture();
    const timing = [] as unknown[];
    let complete!: (value: string) => void;
    const observed = withActiveTestDeadline(() => new Promise<string>(resolve => { complete = resolve; }),
      { ...policy, onTiming: value => timing.push(value) }, f.seams);
    await Promise.resolve();
    f.resume(60_008, 56_932);
    complete('persisted');
    await expect(observed).resolves.toBe('persisted');
    expect(timing).toEqual([{ wallMs: 60_008, frozenMs: 56_932, activeMs: 3_076,
      freezeMeasurementAvailable: true }]);
    expect(f.timers.size).toBe(0);
  });

  it('preserves a subject assertion failure', async () => {
    const f = fixture();
    const failure = new Error('persisted tuple differs');
    await expect(withActiveTestDeadline(async () => { throw failure; }, policy, f.seams)).rejects.toBe(failure);
    expect(f.timers.size).toBe(0);
  });

  it.each([null, undefined])('preserves a non-Error subject rejection (%s)', async failure => {
    const f = fixture();
    await expect(withActiveTestDeadline(() => Promise.reject(failure), policy, f.seams)).rejects.toBe(failure);
    expect(f.timers.size).toBe(0);
  });

  it('rejects a broken timing sink instead of leaving the test pending', async () => {
    const f = fixture();
    const failure = new Error('timing sink failed');
    await expect(withActiveTestDeadline(async () => 'persisted', {
      ...policy, onTiming: () => { throw failure; },
    }, f.seams)).rejects.toBe(failure);
    expect(f.timers.size).toBe(0);
  });

  it('rejects late success even when promise microtasks run before an expired timer', async () => {
    const f = fixture();
    await expect(withActiveTestDeadline(async () => {
      f.advanceClock(60_001);
      return 'too late';
    }, policy, f.seams)).rejects.toMatchObject({ reason: 'active-timeout' });
  });

  it('reads the existing admission ledger and rejects unavailable or malformed values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'active-test-deadline-'));
    const env = { PC_HEAVY_ADMISSION_DIR: dir, PC_HEAVY_ADMISSION_ID: 'fixture' };
    try {
      expect(readAdmissionFrozenMs({})).toBeNull();
      expect(readAdmissionFrozenMs(env)).toBeNull();
      writeFileSync(join(dir, 'fixture.state'), 'state=active\nfrozen_total_ms=56932\n');
      expect(readAdmissionFrozenMs(env)).toBe(56_932);
      for (const value of ['', '-1', 'NaN', '1.5', '9007199254740992']) {
        writeFileSync(join(dir, 'fixture.state'), `frozen_total_ms=${value}\n`);
        expect(readAdmissionFrozenMs(env)).toBeNull();
      }
      expect(readAdmissionFrozenMs({ ...env, PC_HEAVY_ADMISSION_ID: '../fixture' })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
