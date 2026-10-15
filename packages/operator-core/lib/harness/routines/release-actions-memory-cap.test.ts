import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHECKPOINT_SMALL_RUN_MAX_G } from '../../release/checkpoint-memory-admission';
import { checkpointScopeMemoryMaxGForGreenCmd } from '../../systemd-scope';
import {
  CHECKPOINT_FORKS_BY_MODE,
  checkpointScopeMemoryMaxG,
} from './release-actions';

/**
 * WI-39472 — the green-checkpoint scope's memory cap must track its FORK COUNT.
 *
 * The cap (`--property=MemoryMax=<n>G` on the isolated scope) was a hard 16, sized in its
 * own comment for "2 vitest forks × 4 GB heap". When the gate moved to `reserved` (8 forks)
 * the cap stayed at 16, so 4× the workers ran in a cgroup sized for the old count. The
 * scope then hit `memory.max` 310 times in the first ~2 minutes of a run — while `oom_kill`
 * stayed 0, which is precisely why it read as healthy to anyone checking the obvious field.
 *
 * The observable damage was NOT an OOM. Forced reclaim at the ceiling tears down vitest
 * workers, which surfaces as "environment was torn down" cascades and stall-timer
 * console.error failures on test files that pass perfectly in isolation — a DIFFERENT random
 * red set every run. That is indistinguishable from real breakage without reading
 * `memory.events`, and it produced a 15-deep red streak that never converged on a cause.
 *
 * These tests exist so the two numbers cannot silently desynchronize again.
 */
describe('green-checkpoint scope memory cap', () => {
  it('preserves the historical 16 GiB cap for shared mode (2 forks) — no behavior change', () => {
    expect(checkpointScopeMemoryMaxG({} as NodeJS.ProcessEnv)).toBe(16);
    expect(
      checkpointScopeMemoryMaxG({
        PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE: 'shared',
      } as NodeJS.ProcessEnv),
    ).toBe(16);
  });

  it('scales the cap with reserved mode (8 forks) instead of leaving it at the 2-fork size', () => {
    const reserved = checkpointScopeMemoryMaxG({
      PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE: 'reserved',
    } as NodeJS.ProcessEnv);

    // The whole defect: reserved must NOT inherit the shared-mode cap.
    expect(reserved).toBeGreaterThan(
      checkpointScopeMemoryMaxG({} as NodeJS.ProcessEnv),
    );
    expect(reserved).toBe(40);
  });

  it('grows strictly with fork count, at the documented per-fork heap budget', () => {
    const shared = checkpointScopeMemoryMaxG({} as NodeJS.ProcessEnv);
    const reserved = checkpointScopeMemoryMaxG({
      PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE: 'reserved',
    } as NodeJS.ProcessEnv);

    const extraForks = CHECKPOINT_FORKS_BY_MODE.reserved - CHECKPOINT_FORKS_BY_MODE.shared;
    // 4 GiB of heap per additional fork — the sizing the original comment claimed.
    expect(reserved - shared).toBe(extraForks * 4);
  });

  it('an unrecognised capacity mode falls back to shared rather than throwing in the spawn path', () => {
    // green-checkpoint.ts itself rejects a typo'd mode; the cap computation must not be a
    // SECOND place the gate spawn can die, so it degrades to the conservative value.
    expect(
      checkpointScopeMemoryMaxG({
        PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE: 'resrved',
      } as NodeJS.ProcessEnv),
    ).toBe(16);
  });

  /**
   * The anti-drift pin. `CHECKPOINT_FORKS_BY_MODE` duplicates the fork counts because
   * operator-core is the lower layer and must not import from apps/operator. Duplication is
   * only safe if something fails when the source of truth moves — so read the real constants
   * out of green-checkpoint.ts as TEXT and compare. If someone retunes the gate's fork count,
   * this fails and forces the memory cap to be retuned with it.
   */
  it('pins the duplicated fork counts to green-checkpoint.ts, the source of truth', () => {
    const src = path.resolve(
      __dirname,
      '../../../../../apps/operator/lib/release/green-checkpoint.ts',
    );
    const text = readFileSync(src, 'utf8');

    const shared = /export const GREEN_CHECKPOINT_MAX_FORKS\s*=\s*(\d+)/.exec(text);
    const reserved = /export const GREEN_CHECKPOINT_RESERVED_MAX_FORKS\s*=\s*(\d+)/.exec(text);

    // Positive control: if the file moved or the declarations were renamed, this test would
    // otherwise pass vacuously by matching nothing.
    expect(shared, `GREEN_CHECKPOINT_MAX_FORKS not found in ${src}`).not.toBeNull();
    expect(reserved, `GREEN_CHECKPOINT_RESERVED_MAX_FORKS not found in ${src}`).not.toBeNull();

    expect(Number(shared![1])).toBe(CHECKPOINT_FORKS_BY_MODE.shared);
    expect(Number(reserved![1])).toBe(CHECKPOINT_FORKS_BY_MODE.reserved);
  });
});

// WI-10006274: a foreign pot's gate runs its own suite, not the Vitest fork runner, so it must
// not reserve the fork-heap cap; otherwise three large runs defer it on the shared budget.
describe('green-checkpoint scope memory cap by suite', () => {
  const reservedEnv = { PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE: 'reserved' } as NodeJS.ProcessEnv;

  it('keeps the fork-derived cap for the operator-home default suite and any Vitest command', () => {
    const full = checkpointScopeMemoryMaxG(reservedEnv);
    expect(checkpointScopeMemoryMaxGForGreenCmd(null, reservedEnv)).toBe(full);
    expect(checkpointScopeMemoryMaxGForGreenCmd('  ', reservedEnv)).toBe(full);
    expect(checkpointScopeMemoryMaxGForGreenCmd('npm run test:affected', reservedEnv)).toBe(full);
    expect(checkpointScopeMemoryMaxGForGreenCmd('npx vitest run', reservedEnv)).toBe(full);
  });

  it('requests strictly less, and at most the small-run size, for a non-Vitest suite', () => {
    const full = checkpointScopeMemoryMaxG(reservedEnv);
    for (const cmd of ['npm test', 'node --test', 'npm run build']) {
      const g = checkpointScopeMemoryMaxGForGreenCmd(cmd, reservedEnv);
      expect(g).toBeLessThan(full);
      expect(g).toBeLessThanOrEqual(CHECKPOINT_SMALL_RUN_MAX_G);
    }
  });
});
