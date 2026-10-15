/**
 * WI-10004932: the bulk-dedup shard pool must stop every sibling after the
 * first shard failure, and must not settle until the siblings have stopped.
 *
 * Measured 2026-10-01: a single transient `fetch failed` failed stage
 * wi-10004722-p005-live-20261001-stage-1 and ERRORed its routineFire at
 * 15:43:32Z, but the old `Promise.all` pool left the sibling workers running.
 * They kept claiming shards and wrote 8 more batch checkpoints over 18 minutes
 * into a row already marked failed.
 *
 * Ordering is forced with deferred promises, never sleeps, so each case asserts
 * one interleaving rather than hoping a timer produces it. The scenario also
 * runs through the OLD pool shape as a control: if that control ever stops
 * showing the defect, the scenario no longer discriminates and the guard is
 * vacuous.
 */
import { describe, expect, it } from 'vitest';
import { runShardPool } from './work-items-admission-bulk-dedup';

type Pool = typeof runShardPool;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const settleMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

/** The pre-WI-10004932 pool: Promise.all, no latch, siblings never told to stop. */
const legacyPromiseAllPool: Pool = async (entries, concurrency, judge) => {
  const results = new Array(entries.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next;
      next += 1;
      results[index] = await judge(entries[index]!, () => undefined);
    }
  });
  await Promise.all(workers);
  return results;
};

/** Shard 0 fails at batch 1 while shard 1's batch 1 is in flight; shard 2 is unclaimed. */
async function runFailureScenario(pool: Pool) {
  const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
  const started: string[] = [];
  const startedAfterFailure: string[] = [];
  let failed = false;
  const siblingInFlight = deferred();
  const siblingStarted = deferred();

  const judge = async (shard: number, stopIfSiblingFailed: () => void) => {
    for (let batch = 0; batch < 3; batch += 1) {
      stopIfSiblingFailed();
      const key = `${shard}:${batch}`;
      started.push(key);
      if (failed) startedAfterFailure.push(key);
      if (shard === 0 && batch === 1) {
        // Fail only once the sibling's batch is genuinely in flight.
        await siblingStarted.promise;
        failed = true;
        throw boom;
      }
      if (shard === 1 && batch === 1) {
        siblingStarted.resolve();
        await siblingInFlight.promise;
        continue;
      }
      await Promise.resolve();
    }
    return shard;
  };

  let settled = false;
  const run = pool([0, 1, 2], 2, judge);
  const outcome = run.then(
    () => ({ rejectedWith: undefined as unknown }),
    (error: unknown) => ({ rejectedWith: error }),
  );
  void outcome.then(() => {
    settled = true;
  });

  await settleMicrotasks();
  const settledWhileSiblingInFlight = settled;
  siblingInFlight.resolve();
  const { rejectedWith } = await outcome;
  // Let any orphaned sibling run to completion so the control can observe it.
  for (let i = 0; i < 5; i += 1) await settleMicrotasks();
  return { boom, rejectedWith, settledWhileSiblingInFlight, started, startedAfterFailure };
}

describe('runShardPool (WI-10004932)', () => {
  it('stops siblings before their next batch after the first failure, and rejects with that failure', async () => {
    const r = await runFailureScenario(runShardPool);
    expect(r.rejectedWith).toBe(r.boom);
    // A caller recording the failure must not race the sibling's late write.
    expect(r.settledWhileSiblingInFlight).toBe(false);
    expect(r.startedAfterFailure).toEqual([]);
    expect(r.started).not.toContain('1:2');
    expect(r.started.some((key) => key.startsWith('2:'))).toBe(false);
  });

  it('CONTROL: the old Promise.all pool shows the defect in the same scenario', async () => {
    const r = await runFailureScenario(legacyPromiseAllPool);
    expect(r.rejectedWith).toBe(r.boom);
    expect(r.settledWhileSiblingInFlight).toBe(true);
    expect(r.startedAfterFailure).toEqual(expect.arrayContaining(['1:2', '2:0']));
  });

  it('a sibling parked on a gate stops when it resumes after the failure', async () => {
    const boom = new Error('canary protocol failure');
    const gate = deferred();
    const modelCalls: number[] = [];

    const judge = async (shard: number, stopIfSiblingFailed: () => void) => {
      if (shard === 0) throw boom;
      await gate.promise; // e.g. parked on the canary gate
      stopIfSiblingFailed();
      modelCalls.push(shard);
      return shard;
    };

    const pool = runShardPool([0, 1], 2, judge);
    await settleMicrotasks();
    gate.resolve();
    await expect(pool).rejects.toBe(boom);
    expect(modelCalls).toEqual([]);
  });

  it('returns results in entry order and respects the concurrency bound when nothing fails', async () => {
    let active = 0;
    let maxActive = 0;
    const judge = async (entry: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await settleMicrotasks();
      active -= 1;
      return entry.toUpperCase();
    };

    await expect(runShardPool(['a', 'b', 'c', 'd', 'e'], 2, judge)).resolves.toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(maxActive).toBe(2);
  });
});
