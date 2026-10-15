/**
 * merge-scaling.test.ts — the CI-locked EI-79 invariant (P-004/P-007).
 *
 * The bench runner MEASURES idle-tick cost; this test LOCKS the complexity
 * class so the EI-79 regression can never silently return:
 *
 *   After a completed merge, a `mergeNow()` tick with NO log growth must take
 *   the steady-state skip — zero decode, zero re-apply — regardless of how
 *   much history exists. The 1Hz production poll then costs O(#logs), not
 *   O(total-history). EI-79 (operator down, 12-30s route latencies) was
 *   exactly this invariant breaking.
 *
 * Assertions are deterministic (apply-sink call counts), with one generous
 * timing bound as a belt-and-braces (an idle tick over 20k ops of history
 * must not cost a meaningful fraction of the EI-79-class burn).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { closeHarnessStore, _resetCacheForTests } from '../corestore';
import type { OpEnvelope } from '../op-envelope-types';
import type { PeerLogOp } from '../peer-log';
import { generateCorpus } from './corpus';
import { stubHivePolicyReadsForSuite } from '../__tests__/_hive-policy-read-stubs';

// WI-10007530: no PG here, and the merge pass no longer swallows a failed policy read.
stubHivePolicyReadsForSuite();

/**
 * Keep this suite hermetic. Production resolves re-key dependencies
 * fail-closed, but these unit cases exercise the substrate with no real PG.
 * Individual tests can still override this default through the existing seam.
 */
function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort */
    }
  }
  _resetCacheForTests();
});

async function bootWithHistory(historySize: number): Promise<{
  handle: BootedHarnessHandle;
  apply: ReturnType<typeof vi.fn<(op: OpEnvelope) => Promise<boolean>>>;
}> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'merge-scaling-'));
  const harnessSlug = 'scaling';
  cleanups.push(() => {
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const apply = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
  const handle = await bootHarnessSubstrate({
    workspaceRoot,
    workspaceId: 'ws-merge-scaling',
    harnessSlug,
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    applyOverride: apply,
    loadRevokedOverride: async () => new Set(),
  });
  cleanups.push(async () => {
    await handle.close();
    await closeHarnessStore({ workspaceRoot, harnessSlug });
  });

  const BATCH = 2000;
  let batch: PeerLogOp[] = [];
  for (const op of generateCorpus({ seed: 5, count: historySize, authorPubkey: 'a'.repeat(64) })) {
    batch.push(op);
    if (batch.length >= BATCH) {
      await handle.ownLog.appendBatch(batch);
      batch = [];
    }
  }
  if (batch.length) await handle.ownLog.appendBatch(batch);
  return { handle, apply };
}

describe('EI-79 steady-state skip (idle merge ticks are O(#logs), not O(history))', () => {
  it('after backfill, idle mergeNow() ticks decode and apply NOTHING', async () => {
    const { handle, apply } = await bootWithHistory(5_000);

    // Backfill: the full history folds + applies once.
    const applied = await handle.mergeNow();
    expect(applied).toBeGreaterThan(0);
    const callsAfterBackfill = apply.mock.calls.length;
    expect(callsAfterBackfill).toBeGreaterThan(0);

    // Idle ticks: no growth → the skip path. Zero further apply calls.
    for (let i = 0; i < 25; i++) {
      expect(await handle.mergeNow()).toBe(0);
    }
    expect(apply.mock.calls.length).toBe(callsAfterBackfill);
  });

  it('growth (one append) resumes merging on the next tick, then idles again', async () => {
    const { handle, apply } = await bootWithHistory(1_000);
    await handle.mergeNow();
    const afterBackfill = apply.mock.calls.length;

    await handle.append({
      type: 'put',
      table: 'features-by-id',
      hbKey: 'F-grow',
      value: { status: 'todo' },
      ts: Date.now(),
      schema_version: 1,
    });
    const applied = await handle.mergeNow();
    expect(applied).toBeGreaterThan(0);
    // O(delta), boot-level (the P-013 incremental cursor): ONE appended op
    // costs exactly ONE apply — not a re-apply of the whole winner set.
    expect(apply.mock.calls.length).toBe(afterBackfill + 1);

    const afterGrowth = apply.mock.calls.length;
    expect(await handle.mergeNow()).toBe(0);
    expect(apply.mock.calls.length).toBe(afterGrowth);
  });

  it('idle-tick wall time stays trivial even over 20k ops of history (timing belt-and-braces)', async () => {
    const { handle } = await bootWithHistory(20_000);
    await handle.mergeNow(); // backfill

    const ticks: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = process.hrtime.bigint();
      await handle.mergeNow();
      ticks.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    ticks.sort((a, b) => a - b);
    const median = ticks[Math.floor(ticks.length / 2)];
    // Pre-EI-79 this was a full 20k-op decode+fold per tick (tens to hundreds
    // of ms). The skip path is sub-ms; 50ms leaves CI headroom without ever
    // tolerating an O(history) tick.
    expect(median).toBeLessThan(50);
  }, 60_000);
});
