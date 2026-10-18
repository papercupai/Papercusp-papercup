/**
 * boot-all-merge-cursor-injection.test.ts — WI-3297: the IN-PROCESS boot path
 * must inject the process-global merge-cursor-store factory into
 * `bootHarnessSubstrate`, and ONLY that path.
 *
 * The WI-2105 PG-cursor store was constructed solely in substrate-sidecar-host,
 * so packaged installs (substrate in-process, SUBSTRATE_SIDECAR off) booted
 * with `mergeCursorStore: null`: harness_shared.substrate_merge_cursor stayed
 * empty and every process boot re-folded every admitted log from index 0
 * (112k ops + the epoch-decrypt-fail storm on a seeded install — the VM repro).
 *
 * `../boot` is partially mocked (spy bootHarnessSubstrate returning a fake
 * handle) so boot-all's imported reference IS the spy — the `bootHarness ===
 * bootHarnessSubstrate` injection gate stays exercised without a corestore.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootHarnessOpts } from '../boot';
import type { MergeCursorStore } from '../read-merge';
import { makeFakeBootedHandle } from './fake-booted-handle';

// See boot-all.test.ts: boot-all's projection graph transitively imports the
// ephemeral-foreign helpers via p2p/revocation-reaper, so they must exist on the
// mock or the suite fails at import time.
vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: [] as Array<{ slug: string; path: string }> }),
  isEphemeralForeignProject: (p: { ephemeral_foreign?: boolean }) => p.ephemeral_foreign === true,
  ephemeralForeignHarnessSlug: (offerId: string) => `foreign-${offerId}`,
  registerEphemeralForeignHarness: vi.fn(),
  deregisterEphemeralForeignHarness: vi.fn(async () => false),
  sweepOrphanedEphemeralForeignHarnesses: vi.fn(async () => ({ swept: 0, removed: [] })),
}));

vi.mock('../boot', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../boot')>();
  return {
    ...orig,
    bootHarnessSubstrate: vi.fn(async (opts: BootHarnessOpts) => {
      return makeFakeBootedHandle({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
      }).handle;
    }),
  };
});

import { bootHarnessSubstrate } from '../boot';
import {
  bootSingleHarness,
  markSubstrateBootRoutingFailed,
  markSubstrateBootRoutingPending,
  setSubstrateBootDefaults,
  _resetSubstrateBootDefaultsForTests,
  _resetHandleMapForTests,
} from '../boot-all';

const bootSpy = vi.mocked(bootHarnessSubstrate);

function fakeStore(): MergeCursorStore {
  return { load: async () => new Map(), save: async () => {} };
}

const bootOpts = {
  workspaceRoot: '/tmp/nonexistent-ws-root',
  skipSendSideWiring: true,
  resolveSwarmBinding: async () => null,
};

beforeEach(() => {
  _resetHandleMapForTests();
  _resetSubstrateBootDefaultsForTests();
  bootSpy.mockClear();
});
afterEach(() => {
  _resetHandleMapForTests();
  _resetSubstrateBootDefaultsForTests();
});

describe('WI-3297 merge-cursor-store injection (in-process boot path)', () => {
  it('fails closed immediately when the migration-gated routing decision fails', async () => {
    markSubstrateBootRoutingPending();
    markSubstrateBootRoutingFailed('migration gate failed: 1111-acceptance-bar-contract-seed.sql');

    const r = await bootSingleHarness('ws-migration-failed', 'harness-migration-failed', bootOpts);
    expect(r.state).toBe('failed');
    expect(r.error).toContain('migration gate failed');
    // No in-process engine may start while host-bootstrap has withheld the
    // schema-dependent background plane.
    expect(bootSpy).not.toHaveBeenCalled();
  });

  it('routing-latch timeout fails closed instead of starting a duplicate engine', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      markSubstrateBootRoutingPending();
      const pending = bootSingleHarness('ws-routing-timeout', 'harness-routing-timeout', bootOpts);

      // SUBSTRATE_ROUTING_WAIT_MS is intentionally 300s in production. Drive
      // that exact timeout here so the regression covers the last-resort path
      // without sleeping in the suite.
      await vi.advanceTimersByTimeAsync(300_000);
      const r = await pending;
      expect(r.state).toBe('failed');
      expect(r.error).toContain('substrate routing undecided after 300000ms');
      expect(bootSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('last-resort in-process fallback refused'),
      );
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });

  it('injects the installed factory into the default in-process boot', async () => {
    const store = fakeStore();
    const factory = vi.fn((_ws: string, _slug: string) => store);
    setSubstrateBootDefaults({ mergeCursorStoreFactory: factory });

    const r = await bootSingleHarness('ws-a', 'harness-a', bootOpts);
    expect(r.state).toBe('booted');
    expect(factory).toHaveBeenCalledWith('ws-a', 'harness-a');
    expect(bootSpy).toHaveBeenCalledTimes(1);
    expect(bootSpy.mock.calls[0][0].mergeCursorStore).toBe(store);
  });

  it('boots with NO store when no factory is installed (hermetic default)', async () => {
    const r = await bootSingleHarness('ws-b', 'harness-b', bootOpts);
    expect(r.state).toBe('booted');
    expect(bootSpy).toHaveBeenCalledTimes(1);
    expect(bootSpy.mock.calls[0][0].mergeCursorStore).toBeUndefined();
  });

  it('never injects into a per-call bootHarness override', async () => {
    const factory = vi.fn(() => fakeStore());
    setSubstrateBootDefaults({ mergeCursorStoreFactory: factory });
    const override = vi.fn(async (opts: BootHarnessOpts) => {
      return makeFakeBootedHandle({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
      }).handle;
    });

    const r = await bootSingleHarness('ws-c', 'harness-c', { ...bootOpts, bootHarness: override });
    expect(r.state).toBe('booted');
    expect(override).toHaveBeenCalledTimes(1);
    expect(override.mock.calls[0][0].mergeCursorStore).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(bootSpy).not.toHaveBeenCalled();
  });

  it('never injects into an installed default bootHarness (sidecar factory)', async () => {
    const factory = vi.fn(() => fakeStore());
    const sidecarLike = vi.fn(async (opts: BootHarnessOpts) => {
      return makeFakeBootedHandle({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
      }).handle;
    });
    // A sidecar install clears the factory; install BOTH here to prove the
    // bootHarness identity gate alone protects the non-default path.
    setSubstrateBootDefaults({ bootHarness: sidecarLike, mergeCursorStoreFactory: factory });

    const r = await bootSingleHarness('ws-d', 'harness-d', bootOpts);
    expect(r.state).toBe('booted');
    expect(sidecarLike).toHaveBeenCalledTimes(1);
    expect(sidecarLike.mock.calls[0][0].mergeCursorStore).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('reset clears the installed factory', async () => {
    setSubstrateBootDefaults({ mergeCursorStoreFactory: vi.fn(() => fakeStore()) });
    _resetSubstrateBootDefaultsForTests();
    const r = await bootSingleHarness('ws-e', 'harness-e', bootOpts);
    expect(r.state).toBe('booted');
    expect(bootSpy.mock.calls[0][0].mergeCursorStore).toBeUndefined();
  });

  it('WI-38376 threads the frozen grace env independently from the zombie grace', async () => {
    const savedZombie = process.env.PAPERCUSP_REPLICATION_STALL_GRACE_MS;
    const savedFrozen = process.env.PAPERCUSP_REPLICATION_FROZEN_GRACE_MS;
    try {
      process.env.PAPERCUSP_REPLICATION_STALL_GRACE_MS = '15000';
      process.env.PAPERCUSP_REPLICATION_FROZEN_GRACE_MS = '45000';

      const r = await bootSingleHarness('ws-frozen-grace', 'harness-frozen-grace', bootOpts);
      expect(r.state).toBe('booted');
      expect(bootSpy).toHaveBeenCalledTimes(1);
      const forwarded = bootSpy.mock.calls[0]![0];
      expect(forwarded.connectedNeverReplicatedGraceMs).toBe(15_000);
      expect(forwarded.frozenGraceMs).toBe(45_000);
      // The legacy/general axis remains on its production default. Reusing
      // either short rig value here would recreate WI-5686's false positives.
      expect(forwarded.replicationStallGraceMs).toBeUndefined();
    } finally {
      if (savedZombie === undefined) delete process.env.PAPERCUSP_REPLICATION_STALL_GRACE_MS;
      else process.env.PAPERCUSP_REPLICATION_STALL_GRACE_MS = savedZombie;
      if (savedFrozen === undefined) delete process.env.PAPERCUSP_REPLICATION_FROZEN_GRACE_MS;
      else process.env.PAPERCUSP_REPLICATION_FROZEN_GRACE_MS = savedFrozen;
    }
  });
});
