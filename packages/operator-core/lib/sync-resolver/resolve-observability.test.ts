import { beforeEach, describe, expect, it } from 'vitest';
import { withNamedQueryDiagnosticContext, traceNamedQueryStage } from '../agent-tools/db-diagnostic-correlation-wiring';
import {
  observeResolve,
  __resetResolveObservability,
  SLOW_RESOLVE_MS,
  RESOLVE_LOG_DEDUP_MS,
} from './resolve-observability';

/** Collects emitted lines instead of writing to the journal. */
function recorder() {
  const lines: string[] = [];
  return { lines, emit: (line: string) => lines.push(line) };
}

const ARGS = '{}';

beforeEach(() => __resetResolveObservability());

describe('observeResolve', () => {
  it('names the still-pending goal stage in the timeout log, without waiting for it to finish', async () => {
    const { lines, emit } = recorder();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await withNamedQueryDiagnosticContext('goals.detail', async requestId => {
      const read = traceNamedQueryStage('goal-portfolio', () => pending);
      observeResolve({ name: 'goals.detail', argsJson: ARGS, elapsedMs: 10_000,
        error: { name: 'QueryResolveTimeoutError', message: 'deadline' }, emit });
      const timings = JSON.parse(lines[0].split(' stages=')[1]);
      expect(timings).toMatchObject({ requestId, stages: [{ stage: 'goal-portfolio', outcome: 'pending' }] });
      expect(timings.stages[0].elapsedMs).toBeGreaterThanOrEqual(0);
      release();
      await read;
    });
  });

  it('says NOTHING for a fast success — the overwhelmingly common case', () => {
    const { lines, emit } = recorder();
    observeResolve({ name: 'learning.analyze', argsJson: ARGS, elapsedMs: 26, emit });
    expect(lines).toEqual([]);
  });

  it('logs a slow success, which is invisible everywhere else on this route', () => {
    // sampleRate: 0 keeps this transport out of route_invocations, so a read
    // that took seconds but SUCCEEDED leaves no other trace at all.
    const { lines, emit } = recorder();
    observeResolve({
      name: 'learning.analyze',
      argsJson: ARGS,
      elapsedMs: SLOW_RESOLVE_MS,
      emit,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[sync-slow]');
    expect(lines[0]).toContain('name=learning.analyze');
  });

  it('distinguishes a RESOLVER TIMEOUT from any other failure', () => {
    // The 10s timeout is the shape the owner reported — several seconds of
    // loading artifacts and then nothing. It must be greppable on its own, not
    // blended into generic errors.
    const { lines, emit } = recorder();
    const timeout = Object.assign(new Error('query "x" did not resolve within 10000ms'), {
      name: 'QueryResolveTimeoutError',
    });
    observeResolve({
      name: 'learning.analyze',
      argsJson: ARGS,
      elapsedMs: 10_004,
      error: timeout,
      emit,
    });
    expect(lines[0]).toContain('[sync-timeout]');
    expect(lines[0]).toContain('ms=10004');

    observeResolve({
      name: 'learning.observations.counts',
      argsJson: ARGS,
      elapsedMs: 5,
      error: new Error('column ei.payload must appear in the GROUP BY clause'),
      emit,
    });
    expect(lines[1]).toContain('[sync-error]');
  });

  it('collapses repeats and reports how many it suppressed', () => {
    // A persistently-failing query is polled every ~3s by every open client.
    // Logging each one would bury the diagnostic in its own output.
    const { lines, emit } = recorder();
    const t0 = 1_000_000;
    const fail = { name: 'learning.hive', argsJson: ARGS, elapsedMs: 12_000 };
    const err = new Error('boom');

    observeResolve({ ...fail, error: err, now: t0, emit });
    for (let i = 1; i <= 20; i += 1) {
      observeResolve({ ...fail, error: err, now: t0 + i * 3_000, emit });
    }
    // Only the ones inside the window are suppressed; the window reopens.
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain('suppressed=');
    expect(lines[1]).toMatch(/suppressed=\d+/);
  });

  it('reopens the window after the dedup interval', () => {
    const { lines, emit } = recorder();
    const t0 = 5_000_000;
    const slow = { name: 'coord.plans', argsJson: ARGS, elapsedMs: 9_000 };
    observeResolve({ ...slow, now: t0, emit });
    observeResolve({ ...slow, now: t0 + RESOLVE_LOG_DEDUP_MS, emit });
    expect(lines).toHaveLength(2);
  });

  it('keys the rate limit per QUERY, so one noisy query cannot mask another', () => {
    const { lines, emit } = recorder();
    const t0 = 9_000_000;
    observeResolve({ name: 'a.one', argsJson: ARGS, elapsedMs: 9_000, now: t0, emit });
    observeResolve({ name: 'b.two', argsJson: ARGS, elapsedMs: 9_000, now: t0, emit });
    expect(lines).toHaveLength(2);
  });

  it('emits ONE line even for a multi-line error message', () => {
    // A zod failure is pretty-printed multi-line JSON. Left alone it splits one
    // event across a dozen journal lines and defeats the grep this module
    // exists to enable — seen on the first live emit (2026-08-02).
    const { lines, emit } = recorder();
    observeResolve({
      name: 'learning.analyzeCycle',
      argsJson: '{\n  "cycleId": null\n}',
      elapsedMs: 1,
      error: new Error('[\n  {\n    "expected": "string",\n    "path": [\n "cycleId"\n]\n  }\n]'),
      emit,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
  });

  it('never throws, whatever it is handed', () => {
    expect(() =>
      observeResolve({
        name: 'x',
        argsJson: ARGS,
        elapsedMs: 9_000,
        error: null,
        emit: () => {
          throw new Error('journal is on fire');
        },
      }),
    ).not.toThrow();
  });
});
