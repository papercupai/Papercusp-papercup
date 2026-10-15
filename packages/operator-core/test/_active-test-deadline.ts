/**
 * Test deadlines for a subject pc-heavy may SIGSTOP (EI-25896360491430849).
 * Reuse its admission ledger, as test-files.mjs and scratch-git-clone.ts do.
 * Only observed suspension in this invocation is credited; a separate wall
 * ceiling still bounds repeated freezes. Use Vitest timeout: 0 only when this
 * helper owns the test's deadline. It does not change clocks or preload modules.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';

export interface TestDeadlineTiming {
  wallMs: number;
  frozenMs: number;
  activeMs: number;
  freezeMeasurementAvailable: boolean;
}

export function readAdmissionFrozenMs(env = process.env): number | null {
  const dir = env.PC_HEAVY_ADMISSION_DIR;
  const id = env.PC_HEAVY_ADMISSION_ID;
  if (!dir || !id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const raw = readFileSync(join(dir, `${id}.state`), 'utf8');
    const value = raw.split('\n').find(line => line.startsWith('frozen_total_ms='))?.slice(16);
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const total = Number(value);
    return Number.isSafeInteger(total) ? total : null;
  } catch { return null; }
}

interface DeadlineSeams {
  now?: () => number;
  frozenMs?: () => number | null;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ActiveTestDeadlineError extends Error {
  constructor(
    public readonly reason: 'active-timeout' | 'wall-timeout',
    public readonly timing: TestDeadlineTiming,
    timeoutMs: number,
    wallTimeoutMs: number,
  ) {
    super(`Test deadline ${reason}: activeMs=${timing.activeMs} wallMs=${timing.wallMs} ` +
      `frozenMs=${timing.frozenMs} timeoutMs=${timeoutMs} wallTimeoutMs=${wallTimeoutMs}`);
    this.name = 'ActiveTestDeadlineError';
  }
}

export function withActiveTestDeadline<T>(
  run: () => Promise<T>,
  policy: { timeoutMs: number; wallTimeoutMs: number; onTiming?: (timing: TestDeadlineTiming) => void },
  seams: DeadlineSeams = {},
): Promise<T> {
  const { timeoutMs, wallTimeoutMs } = policy;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(wallTimeoutMs) || wallTimeoutMs < timeoutMs) {
    throw new Error('Test deadlines require positive integer limits and wallTimeoutMs >= timeoutMs');
  }
  const now = seams.now ?? (() => performance.now());
  const frozen = seams.frozenMs ?? readAdmissionFrozenMs;
  const schedule = seams.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = seams.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const started = now();
  const before = frozen();
  let creditedMs = 0;
  const measure = (): TestDeadlineTiming => {
    const wallMs = Math.max(0, now() - started);
    const after = frozen();
    const available = before !== null && after !== null &&
      Number.isSafeInteger(before) && before >= 0 && Number.isSafeInteger(after) && after >= before;
    if (available) creditedMs = Math.max(creditedMs, Math.min(wallMs, after - before));
    return { wallMs, frozenMs: creditedMs, activeMs: Math.max(0, wallMs - creditedMs),
      freezeMeasurementAvailable: available };
  };
  const error = (timing: TestDeadlineTiming) => timing.wallMs >= wallTimeoutMs
    ? new ActiveTestDeadlineError('wall-timeout', timing, timeoutMs, wallTimeoutMs)
    : timing.activeMs >= timeoutMs
      ? new ActiveTestDeadlineError('active-timeout', timing, timeoutMs, wallTimeoutMs) : null;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    const finish = (timing: TestDeadlineTiming, outcome: { ok: true; value: T } | { ok: false; failure: unknown }) => {
      if (settled) return;
      settled = true;
      cancel(timer);
      try { policy.onTiming?.(timing); }
      catch (failure) { reject(failure); return; }
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.failure);
    };
    const check = () => {
      if (settled) return;
      const timing = measure();
      const expired = error(timing);
      if (expired) finish(timing, { ok: false, failure: expired });
      else timer = schedule(check, Math.min(timeoutMs - timing.activeMs, wallTimeoutMs - timing.wallMs));
    };
    timer = schedule(check, timeoutMs);
    // Catch synchronous callback errors too; retain the subject's rejection.
    Promise.resolve().then(run).then(
      value => {
        const timing = measure();
        const expired = error(timing);
        finish(timing, expired ? { ok: false, failure: expired } : { ok: true, value });
      },
      failure => finish(measure(), { ok: false, failure }),
    );
  });
}
