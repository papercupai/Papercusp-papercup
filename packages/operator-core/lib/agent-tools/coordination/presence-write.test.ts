/**
 * Focused writePresence regression coverage for EI-25230829452100843.
 *
 * The coord_presence upsert is the essential operation. Hive resolution,
 * capability detection, fleet membership, adv-session reactivation, and the
 * successor brief are best-effort enrichments; a wedged one must degrade to
 * its explicit fallback instead of turning a declaration into a transport
 * timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storeWrite: vi.fn(async (..._args: unknown[]) => 'previous-intent' as string | null),
  capabilityProbe: vi.fn(async (..._args: unknown[]) => ['node', 'docker']),
  appendFleetMembership: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
  reactivateAdvSession: vi.fn(async (..._args: unknown[]) => false),
  writeSessionBrief: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
  potHomeSlugForHarness: vi.fn(async (..._args: unknown[]) => 'derived-hive' as string | null),
  reconcilePresencePot: vi.fn((...args: unknown[]) => {
    const requested = (args[0] as { requested: string | null }).requested;
    return { potSlug: requested, corrected: false, note: '' };
  }),
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: vi.fn() }),
}));

vi.mock('@papercusp/coordination/presence', () => {
  class FakePresenceStore {
    write(...args: unknown[]): Promise<string | null> {
      return mocks.storeWrite(...args);
    }

    async touchHeartbeat(): Promise<void> {}
    async touchActivity(): Promise<void> {}
    async setCompactionLimit(): Promise<void> {}
    async setContextEstimate(): Promise<boolean> { return true; }
    async clearContextEstimate(): Promise<void> {}
    async heartbeat(): Promise<void> {}
    async clear(): Promise<void> {}
    async list(): Promise<never[]> { return []; }
    async get(): Promise<null> { return null; }
    async sweepStale(): Promise<number> { return 0; }
  }

  return { PgPresenceStore: FakePresenceStore, PRESENCE_STALE_MS: 60_000 };
});

vi.mock('./machine-capability-tags', () => ({
  getCachedMachineCapabilityTags: (...args: unknown[]) => mocks.capabilityProbe(...args),
}));

vi.mock('../../fleet-membership-store', () => ({
  appendFleetMembershipEvent: vi.fn(async () => undefined),
  appendFleetMembershipIfAbsent: (...args: unknown[]) => mocks.appendFleetMembership(...args),
}));

vi.mock('../../session-brief', () => ({
  writeSessionBrief: (...args: unknown[]) => mocks.writeSessionBrief(...args),
}));

vi.mock('./control-anchor', () => ({
  refreshControlAnchorAfterMutation: vi.fn(async () => undefined),
}));

vi.mock('../../hive-federation', () => ({
  potHomeSlugForHarness: (...args: unknown[]) => mocks.potHomeSlugForHarness(...args),
}));

vi.mock('../../work-scope-policy', () => ({
  reconcilePresencePot: (...args: unknown[]) => mocks.reconcilePresencePot(...args),
}));

vi.mock('../../adv-sessions', () => ({
  reactivateAdvSessionByOwner: (...args: unknown[]) => mocks.reactivateAdvSession(...args),
}));

import {
  writePresence,
  WRITE_PRESENCE_OPTIONAL_LEG_TIMEOUT_MS,
} from './presence';

const identity = {
  ownerId: 'su-write-presence-test',
  ownerLabel: 'su · write-presence-test',
  source: 'omp-hook-session' as const,
  workspaceId: 'papercusp-workspace',
  userId: null,
};

const never = <T>(): Promise<T> => new Promise<T>(() => {});

let previousFleetSlug: string | undefined;
let previousFleetRole: string | undefined;

beforeEach(() => {
  previousFleetSlug = process.env.PAPERCUSP_FLEET_SLUG;
  previousFleetRole = process.env.PAPERCUSP_FLEET_ROLE;
  delete process.env.PAPERCUSP_FLEET_SLUG;
  delete process.env.PAPERCUSP_FLEET_ROLE;
  vi.useFakeTimers();
  mocks.storeWrite.mockReset().mockResolvedValue('previous-intent');
  mocks.capabilityProbe.mockReset().mockResolvedValue(['node', 'docker']);
  mocks.appendFleetMembership.mockReset().mockResolvedValue(undefined);
  mocks.reactivateAdvSession.mockReset().mockResolvedValue(false);
  mocks.writeSessionBrief.mockReset().mockResolvedValue(undefined);
  mocks.potHomeSlugForHarness.mockReset().mockResolvedValue('derived-hive');
  mocks.reconcilePresencePot.mockReset().mockImplementation((...args: unknown[]) => {
    const requested = (args[0] as { requested: string | null }).requested;
    return { potSlug: requested, corrected: false, note: '' };
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (previousFleetSlug === undefined) delete process.env.PAPERCUSP_FLEET_SLUG;
  else process.env.PAPERCUSP_FLEET_SLUG = previousFleetSlug;
  if (previousFleetRole === undefined) delete process.env.PAPERCUSP_FLEET_ROLE;
  else process.env.PAPERCUSP_FLEET_ROLE = previousFleetRole;
});

async function settleAfterOptionalDeadline<T>(promise: Promise<T>): Promise<T> {
  // Let the async function arm its bounded leg before moving fake time.
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(WRITE_PRESENCE_OPTIONAL_LEG_TIMEOUT_MS + 1);
  return promise;
}

describe('writePresence optional-leg deadlines (EI-25230829452100843)', () => {
  it('keeps the essential upsert when capability detection wedges, using node as the fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.capabilityProbe.mockImplementationOnce(() => never<string[]>());

      const result = await settleAfterOptionalDeadline(
        writePresence(identity, { intent: 'work' }),
      );

      expect(result).toBe('previous-intent');
      expect(mocks.storeWrite).toHaveBeenCalledWith(
        identity,
        expect.objectContaining({ capabilityTags: ['node'] }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('writePresence:capability-probe'));
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves an explicitly requested pot when the hive lookup wedges', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.potHomeSlugForHarness.mockImplementationOnce(() => never<string | null>());

      await settleAfterOptionalDeadline(
        writePresence(identity, { intent: 'work', potSlug: 'requested-pot' }, 'papercusp'),
      );

      expect(mocks.storeWrite).toHaveBeenCalledWith(
        identity,
        expect.objectContaining({ potSlug: 'requested-pot' }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('writePresence:hive-lookup'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not hold the declaration on a wedged fleet-membership append', async () => {
    process.env.PAPERCUSP_FLEET_SLUG = 'fleet-under-test';
    process.env.PAPERCUSP_FLEET_ROLE = 'member';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.appendFleetMembership.mockImplementationOnce(() => never<void>());

      const result = await settleAfterOptionalDeadline(writePresence(identity, { intent: 'work' }));

      expect(result).toBe('previous-intent');
      expect(mocks.storeWrite).toHaveBeenCalledTimes(1);
      expect(mocks.reactivateAdvSession).toHaveBeenCalledTimes(1);
      expect(mocks.writeSessionBrief).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('writePresence:fleet-membership'));
    } finally {
      warn.mockRestore();
    }
  });

  it('runs the successor brief after adv-session reactivation times out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.reactivateAdvSession.mockImplementationOnce(() => never<boolean>());

      const result = await settleAfterOptionalDeadline(writePresence(identity, { intent: 'work' }));

      expect(result).toBe('previous-intent');
      expect(mocks.writeSessionBrief).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('writePresence:adv-session-reactivation'));
    } finally {
      warn.mockRestore();
    }
  });

  it('returns after a wedged successor-brief write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.writeSessionBrief.mockImplementationOnce(() => never<void>());

      const result = await settleAfterOptionalDeadline(writePresence(identity, { intent: 'work' }));

      expect(result).toBe('previous-intent');
      expect(mocks.storeWrite).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('writePresence:session-brief'));
    } finally {
      warn.mockRestore();
    }
  });
});
