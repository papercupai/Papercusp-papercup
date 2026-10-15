import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdmissionStepClock } from './admission-step-clock';

// WI-10005695: an admit whose client gave up at 300s left no trace of which step held it.
describe('createAdmissionStepClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records each settled step with its duration and outcome, in completion order', async () => {
    let t = 1_000;
    const clock = createAdmissionStepClock({ context: 'op=admit paths=2', now: () => t, log: () => {} });
    await clock.step('ledger-read', async () => {
      t += 40;
    });
    await expect(
      clock.step('hunk-exact', async () => {
        t += 7;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(clock.summary()).toEqual({
      totalMs: 47,
      steps: [
        { step: 'ledger-read', ms: 40, ok: true },
        { step: 'hunk-exact', ms: 7, ok: false },
      ],
      inFlight: [],
    });
  });

  it('logs a step that is still running after stillRunningMs, once, naming the step', async () => {
    const lines: string[] = [];
    const clock = createAdmissionStepClock({
      context: 'op=admit paths=31 dryRun=true',
      stillRunningMs: 30_000,
      log: (line) => lines.push(line),
    });
    let release!: () => void;
    const pending = clock.step('build-proof', () => new Promise<void>((resolve) => (release = resolve)));
    expect(clock.summary().inFlight).toEqual(['build-proof']);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("step 'build-proof' still running after 30s");
    expect(lines[0]).toContain('paths=31 dryRun=true');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toHaveLength(1);
    release();
    await pending;
    expect(clock.summary().inFlight).toEqual([]);
  });

  it('logs a slow settled step and stays quiet for a fast one', async () => {
    let t = 0;
    const lines: string[] = [];
    const clock = createAdmissionStepClock({ context: 'op=admit', slowLogMs: 5_000, now: () => t, log: (l) => lines.push(l) });
    await clock.step('containment', async () => {
      t += 4_999;
    });
    expect(lines).toEqual([]);
    await clock.step('dependency-prediction', async () => {
      t += 5_000;
    });
    expect(lines).toEqual(["[release:repair-queue] step 'dependency-prediction' settled after 5000ms (op=admit)"]);
  });

  it('clears the watchdog when a step settles before stillRunningMs', async () => {
    const lines: string[] = [];
    const clock = createAdmissionStepClock({ context: 'op=admit', stillRunningMs: 1_000, log: (l) => lines.push(l) });
    await clock.step('inspect-queue', async () => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines).toEqual([]);
  });
});
