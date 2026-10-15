/**
 * green-main-cycle-time-2026-10-08 P-013, D-028(4): a gate-red singleton is claimable only by
 * an owner with a guaranteed re-wake. Pure decision + the IO wrapper over a fake reader.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LoopNextWakeVerdict } from '../loop/next-wake';
import {
  assessGateSingletonClaim,
  checkGateSingletonClaim,
  LONG_LIVED_OWNER_CONDITION_PREFIXES,
  requiresLongLivedOwner,
  type GateSingletonClaimReader,
} from './gate-singleton-claim-guard';
import { GATE_RED_STREAK_CONDITION_PREFIX } from '../../work-items-admission';
import {
  FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX,
  FROZEN_REPAIR_LEG_CONDITION_PREFIX,
} from '../../coord/actionable-conditions';

const GUARANTEED: LoopNextWakeVerdict = { guaranteed: true, reason: null };
const NO_LOOP: LoopNextWakeVerdict = { guaranteed: false, reason: 'no-active-loop' };

function fakeReader(over: {
  conditionKey?: string | null | Error;
  rewake?: LoopNextWakeVerdict | Error;
}): GateSingletonClaimReader & { readRewake: ReturnType<typeof vi.fn> } {
  return {
    readConditionKey: async () => {
      if (over.conditionKey instanceof Error) throw over.conditionKey;
      return over.conditionKey ?? null;
    },
    readRewake: vi.fn(async () => {
      if (over.rewake instanceof Error) throw over.rewake;
      return over.rewake ?? GUARANTEED;
    }),
  };
}

describe('requiresLongLivedOwner', () => {
  it('guards exactly the gate-red-streak: and frozen-repair-convergence: singletons', () => {
    expect([...LONG_LIVED_OWNER_CONDITION_PREFIXES].sort()).toEqual(
      [GATE_RED_STREAK_CONDITION_PREFIX, FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX].sort(),
    );
    expect(requiresLongLivedOwner('gate-red-streak:papercusp')).toBe(true);
    expect(requiresLongLivedOwner('frozen-repair-convergence:papercusp')).toBe(true);
  });

  it('never guards per-leg items, other conditions, or an item with no key', () => {
    expect(requiresLongLivedOwner(`${FROZEN_REPAIR_LEG_CONDITION_PREFIX}papercusp:a.test.ts`)).toBe(false);
    expect(requiresLongLivedOwner('git-sync-stall:papercusp')).toBe(false);
    expect(requiresLongLivedOwner(null)).toBe(false);
    expect(requiresLongLivedOwner(undefined)).toBe(false);
    expect(requiresLongLivedOwner('')).toBe(false);
  });
});

describe('assessGateSingletonClaim', () => {
  it('refuses a claimant with no active loop and points at loop:arm and the per-leg items', () => {
    const r = assessGateSingletonClaim({
      conditionKey: 'gate-red-streak:papercusp',
      claimant: 'su-abc',
      rewake: NO_LOOP,
    });
    expect(r).toMatchObject({
      error: 'gate_singleton_requires_long_lived_owner',
      conditionKey: 'gate-red-streak:papercusp',
      claimant: 'su-abc',
      rewakeReason: 'no-active-loop',
    });
    expect(r?.hint).toMatch(/loop:arm/);
    expect(r?.hint).toMatch(/frozen-repair-leg:/);
    expect(r?.hint).toMatch(/release:repair-queue/);
    expect(r?.hint).toMatch(/refused before mutation/);
  });

  it('refuses an active loop whose next wake is withheld, carrying the blocked reason', () => {
    const r = assessGateSingletonClaim({
      conditionKey: 'frozen-repair-convergence:papercusp',
      claimant: 'su-abc',
      rewake: { guaranteed: false, reason: 'max-fires-exhausted' },
    });
    expect(r?.rewakeReason).toBe('max-fires-exhausted');
  });

  it('admits a claimant whose re-wake is guaranteed', () => {
    expect(
      assessGateSingletonClaim({ conditionKey: 'gate-red-streak:papercusp', claimant: 'su-abc', rewake: GUARANTEED }),
    ).toBeNull();
  });

  it('refuses on an unreadable verdict and says to retry rather than to arm a loop', () => {
    const r = assessGateSingletonClaim({ conditionKey: 'gate-red-streak:papercusp', claimant: 'su-abc', rewake: null });
    expect(r?.rewakeReason).toBe('rewake-unverifiable');
    expect(r?.hint).toMatch(/retry the claim/);
    expect(r?.hint).not.toMatch(/Arm one first/);
  });

  it('exempts system:* routine identities explicitly', () => {
    expect(
      assessGateSingletonClaim({ conditionKey: 'gate-red-streak:papercusp', claimant: 'system:release', rewake: NO_LOOP }),
    ).toBeNull();
  });

  it('never refuses an unguarded item, whatever the verdict', () => {
    expect(
      assessGateSingletonClaim({
        conditionKey: `${FROZEN_REPAIR_LEG_CONDITION_PREFIX}papercusp:a.test.ts`,
        claimant: 'su-abc',
        rewake: NO_LOOP,
      }),
    ).toBeNull();
  });
});

describe('checkGateSingletonClaim', () => {
  it('reads the verdict for the claimant it was given and refuses without one', async () => {
    const reader = fakeReader({ conditionKey: 'gate-red-streak:papercusp', rewake: NO_LOOP });
    const r = await checkGateSingletonClaim({ id: 'EI-1', harness: 'papercusp', claimant: 'bee-7' }, reader);
    expect(r?.claimant).toBe('bee-7');
    expect(reader.readRewake).toHaveBeenCalledWith('bee-7');
  });

  it('does not read the loop store for an unguarded item', async () => {
    const reader = fakeReader({ conditionKey: 'git-sync-stall:papercusp', rewake: NO_LOOP });
    expect(await checkGateSingletonClaim({ id: 'EI-1', harness: 'papercusp', claimant: 'bee-7' }, reader)).toBeNull();
    expect(reader.readRewake).not.toHaveBeenCalled();
  });

  it('does not read the loop store for an exempt system claimant', async () => {
    const reader = fakeReader({ conditionKey: 'gate-red-streak:papercusp', rewake: NO_LOOP });
    expect(
      await checkGateSingletonClaim({ id: 'EI-1', harness: 'papercusp', claimant: 'system:release' }, reader),
    ).toBeNull();
    expect(reader.readRewake).not.toHaveBeenCalled();
  });

  it('skips the guard when the condition key is unreadable (advisory column read)', async () => {
    const reader = fakeReader({ conditionKey: new Error('pg down'), rewake: NO_LOOP });
    expect(await checkGateSingletonClaim({ id: 'EI-1', harness: 'papercusp', claimant: 'bee-7' }, reader)).toBeNull();
  });

  it('fails closed when a guarded item meets an unreadable re-wake verdict', async () => {
    const reader = fakeReader({ conditionKey: 'frozen-repair-convergence:papercusp', rewake: new Error('loop store down') });
    const r = await checkGateSingletonClaim({ id: 'EI-1', harness: 'papercusp', claimant: 'bee-7' }, reader);
    expect(r?.rewakeReason).toBe('rewake-unverifiable');
  });
});
