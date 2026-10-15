/**
 * WI-10006280 guard: importing the tool registry (`agent-tools/index.ts`) must NOT
 * start the three wake-delivery loops (await sweeper, predicate-watch poller,
 * interest-watch sweeper) unless the process has declared itself an operator host.
 *
 * Observed 2026-10-06: a scratch tsx driver that imported the registry only to
 * register tool definitions claimed and executed five OTHER agents' wake
 * deliveries, because index.ts started those loops unconditionally at import. The
 * gen-tool-catalog / tool-weight build scripts carried the same leak.
 *
 * The second test is the calibration: it proves the recorder sees the REAL
 * starters register their intervals, so the first test's "none registered" cannot
 * pass vacuously. The third pins the host-side wiring, which is too heavy to run in
 * a unit test: runBootstrap() must declare the host before its idempotency guard,
 * so every clustered request worker (which calls runBootstrap a second way) does too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ intervals: [] as string[] }));

vi.mock('@papercusp/scheduled-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/scheduled-registry')>();
  const managedSetInterval = ((name: string, ...rest: unknown[]) => {
    H.intervals.push(name);
    return (real.managedSetInterval as (...args: unknown[]) => unknown)(name, ...rest);
  }) as typeof real.managedSetInterval;
  return { ...real, managedSetInterval };
});

import {
  __pendingOperatorHostStartsForTests,
  __resetOperatorHostProcessForTests,
  declareOperatorHostProcess,
  isOperatorHostProcess,
} from '../background-workers';

const HOST_LOOPS = ['await-event-sweeper', 'predicate-watch-poller', 'interest-watch-sweeper'] as const;
const STARTED_FLAGS = [
  '__papercuspAwaitSweeperStarted',
  '__papercuspPredicateWatchPollerStarted',
  '__papercuspInterestWatchSweeperStarted',
] as const;

describe('agent-tools registry import starts no wake-delivery loop outside an operator host (WI-10006280)', () => {
  beforeAll(async () => {
    // The declaration and the starters' started-flags live on globalThis, so clear any
    // state an earlier file in this worker left behind before importing the registry.
    __resetOperatorHostProcessForTests();
    const g = globalThis as Record<string, unknown>;
    for (const flag of STARTED_FLAGS) delete g[flag];
    await import('./index');
  }, 180_000);

  it('importing the registry registers none of the three loops and queues them for the host', () => {
    expect(isOperatorHostProcess()).toBe(false);
    for (const name of HOST_LOOPS) expect(H.intervals).not.toContain(name);
    expect(__pendingOperatorHostStartsForTests()).toEqual(expect.arrayContaining([...HOST_LOOPS]));
  });

  it('declaring the process a host starts all three loops, exactly once', async () => {
    declareOperatorHostProcess();
    // The interest-watch starter resolves its deps through dynamic import before it
    // registers, so wait for it rather than asserting synchronously.
    await vi.waitFor(() => {
      for (const name of HOST_LOOPS) expect(H.intervals).toContain(name);
    });
    declareOperatorHostProcess();
    for (const name of HOST_LOOPS) expect(H.intervals.filter((n) => n === name)).toHaveLength(1);
    expect(__pendingOperatorHostStartsForTests()).toEqual([]);
  });
});

describe('runBootstrap declares the operator host before its idempotency guard (WI-10006280)', () => {
  it('declareOperatorHostProcess() is the first statement ahead of `if (BOOTSTRAP_STATE.ran) return;`', () => {
    const file = path.resolve(__dirname, '../../../../apps/operator/bin/host-bootstrap.ts');
    const src = readFileSync(file, 'utf8');
    const head = /export function runBootstrap\(\): void \{([\s\S]*?)if \(BOOTSTRAP_STATE\.ran\) return;/.exec(src);
    expect(head, 'runBootstrap() opening or its BOOTSTRAP_STATE.ran guard was not found').not.toBeNull();
    // A code line, not a comment mentioning the name.
    expect(head![1]).toMatch(/^\s*declareOperatorHostProcess\(\);\s*$/m);
  });
});
