/**
 * boot-all — substrate orchestrator tests.
 *
 * Uses fake BootedHarnessHandle injection so the tests don't touch the
 * filesystem (corestore / autobase boot is exercised in its own suites).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

// Producer behavior is unit tested here; durable telemetry has integration
// coverage. Hoist the sink seam so boot decisions cannot enqueue real-PG writes.
vi.mock('../../../degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../degradation/fallback-observations')>()),
  observeFallback: vi.fn(() => true),
}));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
  bootAllHarnessesForActiveWorkspace,
  bootSingleHarness,
  closeAllBootedHarnesses,
  closeBootedHarness,
  defaultResolveSwarmBinding,
  ensureSendSideWired,
  getBootedHarness,
  listBootedHandles,
  listGitServingCapabilities,
  rebootHarness,
  reconcileRemoteHandlesAfterSidecarRestart,
  setSubstrateBootDefaults,
  _resetSubstrateBootDefaultsForTests,
  type SendSideWiringDeps,
  type SwarmBindingResolver,
} from '../boot-all';
import type { BootedHarnessHandle, BootHarnessOpts } from '../boot';
import type { SwarmBinding } from '../derive-swarm-topic';
import { RemoteBootedHarnessHandle, type SubstrateRpcCaller } from '../remote-booted-harness';
import { makeFakeBootedHandle } from './fake-booted-handle';
import {
  _resetOwnLogForkGuardForTests,
  clearOwnLogForkState,
  reportOwnLogForkConflict,
} from '../own-log-fork-guard';

// The DEFAULT discovery path (no discoverHarnessSlugs override) reads the PG
// registry via loadHarnessRegistry — mocked here so unit tests never touch PG.
const loadHarnessRegistryMock = vi.fn(async (_ws?: string) => ({
  projects: [] as Array<{
    slug: string;
    path: string;
    harness_kind?: string;
    remote_hive?: boolean;
    hive_slug?: string;
    registrationOnly?: { commitSha: string };
  }>,
}));
// The ephemeral-foreign surface is mocked alongside loadHarnessRegistry because
// boot-all's projection graph (projections/p2p-peer-grants → p2p/revocation-reaper,
// foreign-clone) transitively imports it. Mocking only
// loadHarnessRegistry left those exports undefined on the mock, which fails the
// whole suite at import time rather than at any assertion. Listing the full
// surface (as lib/fleet/operator-spawn.test.ts does) also keeps a FUTURE
// transitive import from silently reintroducing the same break.
// WI-10007538: boot-all fires a once-per-process, fire-and-forget seed of this
// host's p2p routines (boot-all.ts → p2p/ensure-host-routines). Its default
// writes the routines table in the REAL org Postgres; the unit rail blocks the
// connection and the seeder reports it only via console.log ("seed failed"),
// which no console guard sees. Replace just the boot hook.
const { seedP2pHostRoutinesMock } = vi.hoisted(() => ({ seedP2pHostRoutinesMock: vi.fn() }));
vi.mock('../../../p2p/ensure-host-routines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../p2p/ensure-host-routines')>()),
  ensureP2pHostRoutinesSeededOnce: seedP2pHostRoutinesMock,
}));
// Materialize that mock BEFORE any test boots. boot-all reaches the module only
// through a fire-and-forget dynamic import(), and Vitest 4.1.8's module runner
// keeps the in-flight mock id on a callstack array SHARED by every dynamic
// import from the same importer (startVitestModuleRunner: "this will not work
// if user does Promise.all(import(), import())"). So while the async
// importOriginal factory above is still evaluating, a second boot-all call's
// import() sees the mock id on that callstack and falls through to the REAL
// module, which seeds against the real PG. Observed 2026-10-08 (WI-10007538):
// the double was called AND the real seeder logged "seed failed". Resolving the
// factory once here closes that window deterministically.
beforeAll(async () => {
  const seeded = await import('../../../p2p/ensure-host-routines');
  expect(vi.isMockFunction(seeded.ensureP2pHostRoutinesSeededOnce)).toBe(true);
});
// WI-10007538: every boot here that injects no resolveSwarmBinding runs
// defaultResolveSwarmBinding, which reads two PG-backed resolvers: hive-federation
// → hive-store getHiveBySlug, and resolveHarnessPaths → loadHarnessRegistry. Both
// failed closed against the unit rail and were swallowed (19 attempts per run,
// observed 2026-10-08 19:02Z via the rail's caller chains). resolveHarnessPaths
// reached the REAL harness-registry despite the vi.mock below, so it is stubbed
// at its own namespace rather than trusted to see that mock. Each stub returns
// what an empty registry yields: no hive row, and the unresolved placeholder.
// Tests that need a hive row re-spy getHiveBySlug and mockRestore it after.
beforeEach(async () => {
  const [hiveStore, harnessPaths] = await Promise.all([
    import('../../../hive-store'),
    import('../../../resolve-harness-paths'),
  ]);
  vi.spyOn(hiveStore, 'getHiveBySlug').mockResolvedValue(null);
  vi.spyOn(harnessPaths, 'resolveHarnessPaths').mockImplementation(async (harnessSlug, workspaceId) => {
    const placeholder = `/tmp/papercusp-unresolved/${workspaceId}/${harnessSlug}`;
    return { projectDir: placeholder, stateDir: `${placeholder}/.papercusp` };
  });
});
// The rail's throw-site counter: nothing in this file may reach real Postgres,
// whether or not the caller logged the refusal.
afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});
vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry: (ws?: string) => loadHarnessRegistryMock(ws),
  // boot-all → pinRepoKeysForWorkspace (pot-git/pin-repo-keys.ts) falls back to
  // this export when no `deps.saveRegistry` is injected. A factory mock is
  // TOTAL — anything it omits is simply undefined — so the day pin-repo-keys
  // started calling it, all 9 tests in this file died on "No saveHarnessRegistry
  // export is defined on the mock" even though nothing here changed. Keep this
  // in step with harness-registry's real surface.
  saveHarnessRegistry: vi.fn(async () => {}),
  isEphemeralForeignProject: (p: { ephemeral_foreign?: boolean }) => p.ephemeral_foreign === true,
  ephemeralForeignHarnessSlug: (offerId: string) => `foreign-${offerId}`,
  registerEphemeralForeignHarness: vi.fn(),
  deregisterEphemeralForeignHarness: vi.fn(async () => false),
  sweepOrphanedEphemeralForeignHarnesses: vi.fn(async () => ({ swept: 0, removed: [] })),
}));

/** WI-10007538: no-op send-side wiring. bootSingleHarness's DEFAULT wiring resolves
 *  getOrgPg() (a real Postgres connection the unit rail blocks, which boot-all only
 *  logs), so every boot here that does not set skipSendSideWiring passes this. */
function hermeticSendSide(): SendSideWiringDeps {
  return { wireOutbox: vi.fn(async () => {}), wirePresence: vi.fn(async () => {}) };
}

function fakeHandle(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  return makeFakeBootedHandle({ workspaceId, harnessSlug }).handle;
}

afterEach(async () => {
  await closeAllBootedHarnesses();
  _resetHandleMapForTests();
  _resetOwnLogForkGuardForTests();
});

describe('boot-all — substrate orchestrator', () => {
  it('P514 advertises exact repository authority from the home when a private child cannot serve', async () => {
    const hiveStore = await import('../../../hive-store');
    const hive = vi.spyOn(hiveStore, 'getHiveBySlug').mockResolvedValue({ pubkeyBase64: 'stable-hive' } as Awaited<ReturnType<typeof hiveStore.getHiveBySlug>>);
    loadHarnessRegistryMock.mockResolvedValue({ projects: [
      { slug: 'child', hive_slug: 'home', path: '/child' },
      { slug: 'missing', hive_slug: 'absent-home', path: '/missing' },
    ] });
    const parent = fakeHandle('ws', 'home');
    parent.getGitServingCapability = async request => {
      const now = Date.now();
      return { status: 'ready', capability: { ...request, v: 1, runtimeId: 'home-owner',
        identity: { devicePubkeyBase64: 'home-device', githubUserId: 42, keychainId: 'home-key' },
        context: { ...request.scope, store_generation: 'sg2-1-' + 'a'.repeat(40) }, issuedAtMs: now, expiresAtMs: now + 30_000 } };
    };
    const child = fakeHandle('ws', 'child');
    child.getGitServingCapability = async () => ({ status: 'stopped', retryable: true, reason: 'private child' });
    _setHandleForTests('ws', 'home', parent);
    _setHandleForTests('ws', 'child', child);
    try {
      expect(await listGitServingCapabilities()).toMatchObject([{
        request: { workspaceId: 'ws', installSlug: 'child', potHomeSlug: 'home', scope: { hive_id: 'stable-hive' } },
        state: { status: 'ready', capability: { runtimeId: 'home-owner', identity: { devicePubkeyBase64: 'home-device' } } },
      }]);
    } finally {
      hive.mockRestore();
      loadHarnessRegistryMock.mockResolvedValue({ projects: [] });
    }
  });

  // WI-10000734 regression. Each getGitServingCapability MINTS a capability whose
  // 30s lease starts at ITS OWN mint moment, but the whole batch is published only
  // when the pass ends — so a SERIAL pass burns the lease of everything minted
  // early. Measured on the live box: ~70 entries, ~94s pass, 43/43 capabilities
  // expired on arrival, pot-git serving permanently unavailable, hive canonical and
  // origin/staging frozen ~5h. Asserting OBSERVED CONCURRENCY (not elapsed time)
  // keeps this deterministic: a wall-clock budget would flake on a loaded box, which
  // is precisely the condition this test exists to survive.
  it('WI-10000734: mints serving capabilities in PARALLEL (bounded), so the pass cannot outlive the 30s lease', async () => {
    const hiveStore = await import('../../../hive-store');
    const hive = vi.spyOn(hiveStore, 'getHiveBySlug').mockResolvedValue({ pubkeyBase64: 'stable-hive' } as Awaited<ReturnType<typeof hiveStore.getHiveBySlug>>);
    const ENTRIES = 24;
    const slugs = Array.from({ length: ENTRIES }, (_, i) => `repo-${String(i).padStart(2, '0')}`);
    loadHarnessRegistryMock.mockResolvedValue({
      projects: slugs.map(slug => ({ slug, hive_slug: 'home', path: `/${slug}` })),
    });

    let inFlight = 0;
    let maxInFlight = 0;
    for (const slug of slugs) {
      const handle = fakeHandle('ws', slug);
      handle.getGitServingCapability = async (request) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          // A real timer, so every worker slot is occupied before any completes.
          await new Promise(resolve => setTimeout(resolve, 5));
          const now = Date.now();
          return { status: 'ready', capability: { ...request, v: 1, runtimeId: 'home-owner',
            identity: { devicePubkeyBase64: 'home-device', githubUserId: 42, keychainId: 'home-key' },
            context: { ...request.scope, store_generation: 'sg2-1-' + 'a'.repeat(40) },
            issuedAtMs: now, expiresAtMs: now + 30_000 } };
        } finally {
          inFlight -= 1;
        }
      };
      _setHandleForTests('ws', slug, handle);
    }

    try {
      const ads = await listGitServingCapabilities();

      // The property that failed in production: mints must overlap.
      expect(maxInFlight).toBeGreaterThan(1);
      // ...and stay bounded, so restoring parallelism cannot stampede the keychain.
      expect(maxInFlight).toBeLessThanOrEqual(8);
      // Every entry still advertised, in registry order (mapWithConcurrency is
      // order-preserving; a hand-rolled fan-out would silently scramble this).
      expect(ads).toHaveLength(ENTRIES);
      expect(ads.map(a => a.request.installSlug)).toEqual(slugs);
      expect(ads.every(a => a.state.status === 'ready')).toBe(true);
      // One hive read per DISTINCT pot home. The old `if (!hives.has(slug))` memo
      // was only safe while the pass was serial; resolving up front must preserve
      // the single-read property without a check-then-await race.
      expect(hive).toHaveBeenCalledTimes(1);
    } finally {
      hive.mockRestore();
      loadHarnessRegistryMock.mockResolvedValue({ projects: [] });
    }
  });

  it('getBootedHarness returns null when not booted', () => {
    expect(getBootedHarness('ws-1', 'papercup')).toBeNull();
  });

  it('_setHandleForTests + getBootedHarness round-trip', () => {
    const h = fakeHandle('ws-1', 'papercup');
    _setHandleForTests('ws-1', 'papercup', h);
    expect(getBootedHarness('ws-1', 'papercup')).toBe(h);
  });

  it('keys (workspace, harness) independently', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
    _setHandleForTests('ws-2', 'a', fakeHandle('ws-2', 'a'));
    expect(getBootedHarness('ws-1', 'a')).not.toBeNull();
    expect(getBootedHarness('ws-1', 'b')).not.toBeNull();
    expect(getBootedHarness('ws-2', 'a')).not.toBeNull();
    expect(getBootedHarness('ws-3', 'a')).toBeNull();
  });

  it('closeBootedHarness removes + calls close()', async () => {
    const h = fakeHandle('ws-1', 'papercup');
    _setHandleForTests('ws-1', 'papercup', h);
    const removed = await closeBootedHarness('ws-1', 'papercup');
    expect(removed).toBe(true);
    expect(h.close).toHaveBeenCalledOnce();
    expect(getBootedHarness('ws-1', 'papercup')).toBeNull();
  });

  it('closeBootedHarness on missing returns false', async () => {
    expect(await closeBootedHarness('ws-1', 'missing')).toBe(false);
  });

  it('closeAllBootedHarnesses closes every handle', async () => {
    const a = fakeHandle('ws-1', 'a');
    const b = fakeHandle('ws-1', 'b');
    _setHandleForTests('ws-1', 'a', a);
    _setHandleForTests('ws-1', 'b', b);
    const n = await closeAllBootedHarnesses();
    expect(n).toBe(2);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(getBootedHarness('ws-1', 'a')).toBeNull();
    expect(getBootedHarness('ws-1', 'b')).toBeNull();
  });

  it('bootSingleHarness returns already-booted when cached', async () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    // WI-10007538: the already-booted path still ensures send-side wiring, whose
    // DEFAULT resolves getOrgPg() — a real Postgres connection the unit rail
    // blocks and boot-all only logs. Inject the documented seam instead.
    const result = await bootSingleHarness('ws-1', 'papercup', { wireSendSide: hermeticSendSide() });
    expect(result.state).toBe('already-booted');
  });

  it('bootSingleHarness surfaces boot errors as failed', async () => {
    // Force a failure via a throwing swarm-binding resolver: bootSingleHarness
    // catches it BEFORE ever calling the real bootHarnessSubstrate, so we
    // exercise the failure→'failed' mapping deterministically without spinning
    // up corestore/hypercore native threads. (The prior version raced a 1ms
    // timeout against a real boot, which left native threads that crashed on
    // worker teardown when this file shared a vitest worker with another.)
    const result = await bootSingleHarness('ws-bogus', 'definitely-not-real', {
      resolveSwarmBinding: async () => {
        throw new Error('boot blew up');
      },
    });
    expect(result.state).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(getBootedHarness('ws-bogus', 'definitely-not-real')).toBeNull();
  });

  it('bootSingleHarness refuses the default in-process boot on request-only hosts', async () => {
    const savedVitest = process.env.VITEST;
    const savedBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;
    try {
      delete process.env.VITEST;
      process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
      const result = await bootSingleHarness('ws-request-only', 'papercup', {
        resolveSwarmBinding: async () => null,
      });
      expect(result.state).toBe('failed');
      expect(result.error).toContain('request-only host');
      expect(getBootedHarness('ws-request-only', 'papercup')).toBeNull();
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
      if (savedBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
      else process.env.PAPERCUSP_BACKGROUND_WORKERS = savedBackgroundWorkers;
    }
  });

  it('bootSingleHarness still allows an explicit boot factory on request-only hosts', async () => {
    const savedVitest = process.env.VITEST;
    const savedBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;
    const bootHarness = vi.fn(async (opts: BootHarnessOpts) =>
      fakeHandle(opts.workspaceId, opts.harnessSlug),
    );
    try {
      delete process.env.VITEST;
      process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
      const result = await bootSingleHarness('ws-request-only', 'remote', {
        bootHarness,
        resolveSwarmBinding: async () => null,
        skipSendSideWiring: true,
      });
      expect(result.state).toBe('booted');
      expect(bootHarness).toHaveBeenCalledOnce();
      expect(getBootedHarness('ws-request-only', 'remote')).not.toBeNull();
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
      if (savedBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
      else process.env.PAPERCUSP_BACKGROUND_WORKERS = savedBackgroundWorkers;
    }
  });

  // A resolver that throws makes bootSingleHarness fail BEFORE it ever calls
  // the real bootHarnessSubstrate — so these tests exercise the close+reboot
  // composition without spinning up corestore/hypercore native threads (which
  // crash on teardown when raced by a 1ms boot timeout).
  const throwingResolver: SwarmBindingResolver = async () => {
    throw new Error('skip-real-boot');
  };

  it('rebootHarness closes the existing handle then re-boots', async () => {
    const h = fakeHandle('ws-1', 'papercup');
    _setHandleForTests('ws-1', 'papercup', h);
    const r = await rebootHarness('ws-1', 'papercup', {
      resolveSwarmBinding: throwingResolver,
    });
    expect(r.closed).toBe(true); // stale handle was torn down
    expect(h.close).toHaveBeenCalledOnce();
    expect(r.boot.state).toBe('failed'); // re-boot attempted (resolver threw)
    expect(getBootedHarness('ws-1', 'papercup')).toBeNull();
  });

  it('rebootHarness on a not-booted harness reports closed=false and still boots', async () => {
    const r = await rebootHarness('ws-1', 'never-booted', {
      resolveSwarmBinding: throwingResolver,
    });
    expect(r.closed).toBe(false);
    expect(r.boot.state).toBe('failed');
  });

  // WI-1892 (P-059 zombie-substrate class): a boot that outlives the timeout
  // used to keep running DETACHED — corestore lock held, swarm topic joined,
  // but no registered handle and no send-side drain, so peers saw a live
  // endpoint that answered announces yet never replicated or drained. The fix
  // ADOPTS a late success (register + wire) unless a newer boot won the slot,
  // in which case the late handle is closed to release the corestore.
  it('WI-1892: adopts a late boot after timeout instead of zombifying it', async () => {
    const h = fakeHandle('ws-9', 'slowpoke');
    const r = await bootSingleHarness('ws-9', 'slowpoke', {
      timeoutMs: 5,
      bootHarness: () =>
        new Promise<BootedHarnessHandle>((res) => setTimeout(() => res(h), 40)),
      resolveSwarmBinding: async () => null,
      skipSendSideWiring: true,
    });
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/^boot timeout/);
    // Not yet adopted — the real boot is still running detached.
    expect(getBootedHarness('ws-9', 'slowpoke')).toBeNull();
    await new Promise((res) => setTimeout(res, 80));
    // The late success was ADOPTED: registered exactly like the happy path.
    expect(getBootedHarness('ws-9', 'slowpoke')).toBe(h);
  });

  it('WI-1892: closes the late boot when a newer boot already took the slot', async () => {
    const late = fakeHandle('ws-9', 'raced');
    const r = await bootSingleHarness('ws-9', 'raced', {
      timeoutMs: 5,
      bootHarness: () =>
        new Promise<BootedHarnessHandle>((res) => setTimeout(() => res(late), 40)),
      resolveSwarmBinding: async () => null,
      skipSendSideWiring: true,
    });
    expect(r.state).toBe('failed');
    const winner = fakeHandle('ws-9', 'raced');
    _setHandleForTests('ws-9', 'raced', winner);
    await new Promise((res) => setTimeout(res, 80));
    // The winner keeps the slot; the late boot was closed (corestore released).
    expect(getBootedHarness('ws-9', 'raced')).toBe(winner);
    expect(late.close).toHaveBeenCalled();
  });

  // EI-13317/EI-13521 re-entrancy fix: before this fix, a caller landing in the
  // zombie window (after the artificial timeout rejects, before the real boot
  // settles) saw neither `handles` nor `inflight` for the harness and started a
  // SECOND, independent bootHarness() call for the SAME corestore — contending
  // for the same lock/I/O and self-reinforcing the timeout pile-up under load
  // (root-caused live on gate run 174333: 18 boot timeouts / 10 late-adopts on
  // one rig, and the forceRejoin repair ladder in boot.ts never escalating past
  // "attempt 1/3" because each competing boot reset its closure state to zero).
  it('EI-13317/EI-13521: a re-entrant caller inside the zombie window attaches to the SAME real boot — never a second competing one', async () => {
    const h = fakeHandle('ws-9', 'race-window');
    const bootHarness = vi.fn(
      () => new Promise<BootedHarnessHandle>((res) => setTimeout(() => res(h), 40)),
    );

    // Caller A times out at 5ms; the real boot (40ms) is still running detached.
    const a = await bootSingleHarness('ws-9', 'race-window', {
      timeoutMs: 5,
      bootHarness,
      resolveSwarmBinding: async () => null,
      skipSendSideWiring: true,
    });
    expect(a.state).toBe('failed');
    expect(a.error).toMatch(/^boot timeout/);

    // Caller B arrives INSIDE the zombie window (before the 40ms real boot
    // settles). Before the fix it would find no reservation and call
    // bootHarness a second time; after the fix it attaches to the same
    // in-flight real boot and gets its outcome.
    const b = await bootSingleHarness('ws-9', 'race-window', {
      timeoutMs: 5,
      bootHarness,
      resolveSwarmBinding: async () => null,
      skipSendSideWiring: true,
    });
    expect(b.state).toBe('already-booted');

    // The real boot factory was invoked exactly ONCE — never a second,
    // competing boot for the same corestore.
    expect(bootHarness).toHaveBeenCalledOnce();

    await new Promise((res) => setTimeout(res, 80));
    // Late-adopt still registers the handle exactly once.
    expect(getBootedHarness('ws-9', 'race-window')).toBe(h);
  });

  it('bootAllHarnessesForActiveWorkspace returns 0 attempts for empty workspace list', async () => {
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: [],
    });
    expect(result.attempted).toBe(0);
    expect(result.booted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('bootAllHarnessesForActiveWorkspace skips workspaces whose registry holds no harnesses', async () => {
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-with-empty-registry-12345'],
      discoverHarnessSlugs: async () => [],
    });
    expect(result.attempted).toBe(0);
  });

  it('P-078: boots every slug the registry discovery returns (PG is the source, not the FS)', async () => {
    const discovered: string[] = [];
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-pg-registry'],
      discoverHarnessSlugs: async (ws) => {
        discovered.push(ws);
        return ['h1', 'h2'];
      },
      // Throwing resolver fails each boot BEFORE real corestore spin-up —
      // we only assert the discovery → bootSingleHarness routing here.
      resolveSwarmBinding: async () => {
        throw new Error('skip-real-boot');
      },
    });
    expect(discovered).toEqual(['ws-pg-registry']);
    expect(result.attempted).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.results.map((r) => r.harnessSlug).sort()).toEqual(['h1', 'h2']);
  });

  it('WI-10007538: the boot-time p2p host-routine seed reaches the test double, never the real (PG-writing) seeder', async () => {
    // Guards the vi.mock above. A partial mock that spreads importOriginal can
    // silently leave the SUT bound to the REAL module (Vitest 4 manual-mock
    // callstack fall-through); the only symptom is a swallowed
    // "[p2p-host-routines] ... seed failed — A UNIT test tried to open a REAL
    // Postgres connection" log. Asserting the double is called makes that
    // regression a red test instead of a log line.
    await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-seed-double'],
      discoverHarnessSlugs: async () => ['seed-h0'],
      skipSendSideWiring: true,
      resolveSwarmBinding: async () => null,
      bootHarness: async ({ workspaceId, harnessSlug }) => fakeHandle(workspaceId, harnessSlug),
    });
    await vi.waitFor(() => expect(seedP2pHostRoutinesMock).toHaveBeenCalled());
  });

  it('WI-779: bounds substrate-boot concurrency so a joiner with many members does not time out ALL of them', async () => {
    let active = 0;
    let peak = 0;
    const slugs = Array.from({ length: 12 }, (_, i) => `conc-h${i}`);
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-conc'],
      discoverHarnessSlugs: async () => slugs,
      bootConcurrency: 3,
      skipSendSideWiring: true,
      resolveSwarmBinding: async () => null,
      bootHarness: async ({ workspaceId, harnessSlug }) => {
        active++;
        peak = Math.max(peak, active);
        // Hold the slot briefly so genuinely-overlapping boots are observable.
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return fakeHandle(workspaceId, harnessSlug);
      },
    });
    expect(result.attempted).toBe(12);
    expect(result.booted).toBe(12); // ALL boot — the unbounded Promise.all timed every one out
    expect(peak).toBeLessThanOrEqual(3); // never more than bootConcurrency in flight
    expect(peak).toBeGreaterThan(1); // ...but it IS concurrent, not serialized
  });

  it('WI-790 (verifies WI-779): cap=4 keeps 12 substrates under the boot timeout against a shared resource that degrades past a concurrency threshold — the fed-rig failure mode reproduced + the default cap evaluated', async () => {
    // Model of the live fed-rig incident (WI-779): the shared boot resource
    // (hyperswarm/DHT join) tolerates a small number of concurrent joins fast, but
    // past a threshold every IN-FLIGHT boot degrades past the per-harness timeout —
    // observed live: 2 concurrent -> booted in 5.5s; 11 concurrent -> ALL timed out
    // (>30s). Modeled here as a hard threshold (SAFE_PEAK) rather than a
    // continuously-scaling latency, so the assertion isn't sensitive to real-timer
    // jitter near a boundary: at or under the threshold every boot is fast; once a
    // batch's peak concurrency exceeds it, every boot in that batch is slow enough to
    // miss perHarnessTimeoutMs — the same all-or-nothing shape actually witnessed.
    const TIMEOUT_MS = 200;
    const FAST_MS = 20; // well under TIMEOUT_MS
    const SLOW_MS = 2_000; // well over TIMEOUT_MS -> that boot times out
    const SAFE_PEAK = 4; // the DEFAULT bootConcurrency (WI-779)
    const N = 12;

    async function runWithConcurrency(bootConcurrency: number) {
      let active = 0;
      let peak = 0;
      const slugs = Array.from({ length: N }, (_, i) => `fed-h${i}`);
      return bootAllHarnessesForActiveWorkspace({
        // Distinct workspace per run — bootSingleHarness caches handles by
        // (workspace, harness), so a reused 'ws-fed' would make the second run
        // short-circuit every slug to 'already-booted' without ever invoking
        // bootHarness (failed=0 and nothing measured).
        workspaceIds: [`ws-fed-c${bootConcurrency}`],
        discoverHarnessSlugs: async () => slugs,
        bootConcurrency,
        perHarnessTimeoutMs: TIMEOUT_MS,
        skipSendSideWiring: true,
        resolveSwarmBinding: async () => null,
        bootHarness: async ({ workspaceId, harnessSlug }) => {
          active++;
          peak = Math.max(peak, active);
          // Once ANY boot has pushed the batch's peak concurrency past the safe
          // threshold, the shared resource is saturated for every boot still
          // in flight — not just the newest one (matches "11 concurrent -> all
          // timeout", not "only the 11th times out").
          const latency = peak > SAFE_PEAK ? SLOW_MS : FAST_MS;
          await new Promise((r) => setTimeout(r, latency));
          active--;
          return fakeHandle(workspaceId, harnessSlug);
        },
      });
    }

    // Default cap (4): peak concurrency never exceeds SAFE_PEAK -> every boot stays
    // fast. This is the WI-779 acceptance bar restated at N=12: booted === attempted.
    const capped = await runWithConcurrency(SAFE_PEAK);
    expect(capped.attempted).toBe(N);
    expect(capped.booted).toBe(N);
    expect(capped.failed).toBe(0);

    // Unbounded (12, one worker per harness): peak concurrency hits 12 immediately,
    // saturating the shared resource -> every in-flight boot misses the timeout ->
    // reproduces the live incident (11 concurrent -> all timeout). Confirms cap=4
    // sits with real margin below the observed failure threshold (>2, <=11), not
    // just barely under it.
    const uncapped = await runWithConcurrency(N);
    expect(uncapped.failed).toBeGreaterThan(0);
    expect(uncapped.booted).toBeLessThan(N);
    // WI-10006055: the simulated boots are bounded by TIMEOUT_MS above; this outer
    // budget only has to cover module loading, which overran 10s under gate load.
  }, 60_000);

  it('P-078: default discovery boots live managed entries and excludes registration-only roots', async () => {
    const liveDir = mkdtempSync(join(tmpdir(), 'boot-all-live-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // NOT mockResolvedValueOnce: boot-all now loads the registry TWICE per
    // workspace — pinRepoKeysForWorkspace (EI-18788176839043286) reads it before
    // discover() does. A one-shot value was silently eaten by the pin step, so
    // discovery saw the default empty mock and attempted 0 boots. Overriding the
    // implementation for the duration of the test is robust to the call COUNT
    // changing again; it is restored in `finally` because the shared mock carries
    // a default implementation that later tests rely on.
    const prevRegistryImpl = loadHarnessRegistryMock.getMockImplementation();
    try {
      loadHarnessRegistryMock.mockImplementation(async () => ({
        projects: [
          { slug: 'live-h', path: liveDir },
          { slug: 'passive-h', path: liveDir, registrationOnly: { commitSha: 'a'.repeat(40) } },
          { slug: 'dead-h', path: '/nonexistent/papercusp-boot-all-test' },
        ],
      }));
      const result = await bootAllHarnessesForActiveWorkspace({
        workspaceIds: ['ws-pg-default-discovery'],
        // NO discoverHarnessSlugs override — exercises harnessSlugsFromPgRegistry.
        resolveSwarmBinding: async () => {
          throw new Error('skip-real-boot');
        },
      });
      expect(loadHarnessRegistryMock).toHaveBeenCalledWith('ws-pg-default-discovery');
      expect(result.attempted).toBe(1); // stale and passive entries are excluded
      expect(result.results[0]).toMatchObject({ harnessSlug: 'live-h' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dead-h'));
    } finally {
      loadHarnessRegistryMock.mockImplementation(prevRegistryImpl!);
      warnSpy.mockRestore();
      rmSync(liveDir, { recursive: true, force: true });
    }
  });

  it('D-057: a JOINED (remote_hive) hive view boots even when its gist-backed state dir is ABSENT', async () => {
    // The live spawned-sidecar cross-machine blocker: a joined hive's
    // `remote_hive` HOME view is gist/PG-backed (no code checkout), so its
    // `path` (~/.papercusp/remote-hives/<slug>) need not exist on the spawned
    // sidecar / cloud frame. PRE-FIX harnessSlugsFromPgRegistry filtered it out
    // via existsSync(path) → the joined-hive substrate never booted → no outbox
    // drain wired → every cross-machine content/coord probe = 0. POST-FIX the
    // enumeration aligns with the swarm-join's hive-identity source of truth and
    // boots it. The genuine code-checkout debris (no hive kind) is STILL filtered
    // (the WI-779 thundering-herd guard stays intact).
    const liveClone = mkdtempSync(join(tmpdir(), 'boot-all-member-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // See the P-078 test above: pinRepoKeysForWorkspace reads the registry before
    // discover() does, so a one-shot value never reaches discovery.
    const prevRegistryImpl = loadHarnessRegistryMock.getMockImplementation();
    try {
      loadHarnessRegistryMock.mockImplementation(async () => ({
        projects: [
          // The joined-hive HOME view — gist-backed; its dir is ABSENT here.
          {
            slug: 'joined-hive',
            path: '/nonexistent/papercusp-remote-hives/joined-hive',
            harness_kind: 'hive',
            remote_hive: true,
          },
          // A genuinely-dead CODE checkout (no hive kind) — must STILL be skipped.
          { slug: 'dead-clone', path: '/nonexistent/papercusp-boot-all-dead-clone' },
          // A live member clone — control (real on-disk checkout).
          { slug: 'member-h', path: liveClone, hive_slug: 'joined-hive' },
        ],
      }));
      const booted: string[] = [];
      const result = await bootAllHarnessesForActiveWorkspace({
        workspaceIds: ['ws-joined-hive'],
        // NO discoverHarnessSlugs override — exercises harnessSlugsFromPgRegistry.
        resolveSwarmBinding: async () => null,
        skipSendSideWiring: true,
        bootHarness: async ({ workspaceId, harnessSlug }) => {
          booted.push(harnessSlug);
          return fakeHandle(workspaceId, harnessSlug);
        },
      });
      // PRE-FIX: only 'member-h' enumerated (attempted=1) — the joined hive was
      // dropped. POST-FIX: the joined hive view + the live member both boot.
      expect(booted.sort()).toEqual(['joined-hive', 'member-h']);
      expect(result.attempted).toBe(2);
      expect(result.booted).toBe(2);
      // The thundering-herd guard is intact: dead code-checkout debris is skipped.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dead-clone'));
    } finally {
      loadHarnessRegistryMock.mockImplementation(prevRegistryImpl!);
      warnSpy.mockRestore();
      rmSync(liveClone, { recursive: true, force: true });
    }
  });

  it('P-078: a discovery failure is LOUD and does not abort the other workspaces', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await bootAllHarnessesForActiveWorkspace({
        workspaceIds: ['ws-bad', 'ws-good'],
        discoverHarnessSlugs: async (ws) => {
          if (ws === 'ws-bad') throw new Error('pg exploded');
          return ['h-good'];
        },
        resolveSwarmBinding: async () => {
          throw new Error('skip-real-boot');
        },
      });
      // ws-bad contributed nothing but ws-good still booted (failed = fake boot).
      expect(result.attempted).toBe(1);
      expect(result.results[0]).toMatchObject({ workspaceId: 'ws-good', harnessSlug: 'h-good' });
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("harness discovery failed for workspace 'ws-bad'"),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('sidecar cutover: bootSingleHarness caches the injected remote handle and skips main-process send-side wiring', async () => {
    const handle = fakeHandle('ws-sidecar-cutover', 'h-sidecar');
    const bootHarness = vi.fn(async () => handle);
    const wireOutbox = vi.fn(async () => {});
    const wirePresence = vi.fn(async () => {});

    const result = await bootSingleHarness('ws-sidecar-cutover', 'h-sidecar', {
      workspaceRoot: '/tmp/papercusp-sidecar-cutover',
      resolveSwarmBinding: async () => ({ kind: 'gh', github_repository_id: 12 }),
      bootHarness,
      skipSendSideWiring: true,
      wireSendSide: { wireOutbox, wirePresence },
    });

    expect(result.state).toBe('booted');
    expect(getBootedHarness('ws-sidecar-cutover', 'h-sidecar')).toBe(handle);
    expect(bootHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/tmp/papercusp-sidecar-cutover',
        workspaceId: 'ws-sidecar-cutover',
        harnessSlug: 'h-sidecar',
        swarmBinding: { kind: 'gh', github_repository_id: 12 },
      }),
    );
    expect(wireOutbox).not.toHaveBeenCalled();
    expect(wirePresence).not.toHaveBeenCalled();
  });

  it('sidecar cutover: bootAll forwards the injected boot factory and send-side skip to each harness', async () => {
    const booted: string[] = [];
    const bootHarness = vi.fn(async (opts) => {
      booted.push(`${opts.workspaceId}::${opts.harnessSlug}`);
      return fakeHandle(opts.workspaceId, opts.harnessSlug);
    });

    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-remote'],
      discoverHarnessSlugs: async () => ['h1', 'h2'],
      resolveSwarmBinding: async () => null,
      bootHarness,
      skipSendSideWiring: true,
    });

    expect(result).toMatchObject({ attempted: 2, booted: 2, failed: 0 });
    expect(booted.sort()).toEqual(['ws-remote::h1', 'ws-remote::h2']);
    expect(getBootedHarness('ws-remote', 'h1')).not.toBeNull();
    expect(getBootedHarness('ws-remote', 'h2')).not.toBeNull();
  });

  it('listBootedHandles returns empty when no handles', () => {
    expect(listBootedHandles()).toEqual([]);
  });

  it('listBootedHandles enumerates every cached handle', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
    _setHandleForTests('ws-2', 'a', fakeHandle('ws-2', 'a'));
    const list = listBootedHandles();
    expect(list).toHaveLength(3);
    const keys = list.map((l) => `${l.workspaceId}::${l.harnessSlug}`).sort();
    expect(keys).toEqual(['ws-1::a', 'ws-1::b', 'ws-2::a']);
  });

  it('listBootedHandles returns a fresh array each call', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    const a = listBootedHandles();
    const b = listBootedHandles();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('boot-all — Phase 11 P-078 swarm-binding resolution', () => {
  it('defaultResolveSwarmBinding returns null when projectDir resolves to placeholder', async () => {
    // Without a populated PG harness_registry, resolveHarnessPaths
    // returns the /tmp/papercusp-unresolved/... placeholder which the
    // default resolver explicitly maps to null (no swarm join).
    const got = await defaultResolveSwarmBinding(
      'ws-with-no-registry-entry',
      'no-such-harness-slug',
    );
    expect(got).toBeNull();
  });

  it('bootSingleHarness invokes the resolver with (workspaceId, harnessSlug)', async () => {
    const calls: Array<[string, string]> = [];
    const fakeResolver: SwarmBindingResolver = async (ws, slug) => {
      calls.push([ws, slug]);
      return null;
    };
    await bootSingleHarness('ws-resolver-spy', 'my-slug', {
      workspaceRoot: '/tmp/nonexistent-substrate-boot-test-resolver',
      wireSendSide: hermeticSendSide(), // WI-10007538: default wiring = real org PG
      timeoutMs: 1,
      resolveSwarmBinding: fakeResolver,
    });
    expect(calls).toEqual([['ws-resolver-spy', 'my-slug']]);
  });

  it('bootSingleHarness still attempts boot when resolver returns null', async () => {
    const fakeResolver: SwarmBindingResolver = async () => null;
    const result = await bootSingleHarness('ws-null-resolver', 'slug-x', {
      workspaceRoot: '/tmp/nonexistent-substrate-boot-test-null',
      wireSendSide: hermeticSendSide(),
      timeoutMs: 1,
      resolveSwarmBinding: fakeResolver,
    });
    // Boot fails (no real substrate) but the failure path is still
    // exercised — resolver returning null does NOT throw.
    expect(result.state).toBe('failed');
  });

  it('bootSingleHarness still attempts boot when resolver returns a binding', async () => {
    const binding: SwarmBinding = { kind: 'gh', github_repository_id: 42 };
    const fakeResolver: SwarmBindingResolver = async () => binding;
    const result = await bootSingleHarness('ws-with-binding', 'slug-y', {
      workspaceRoot: '/tmp/nonexistent-substrate-boot-test-binding',
      wireSendSide: hermeticSendSide(),
      timeoutMs: 1,
      resolveSwarmBinding: fakeResolver,
    });
    expect(result.state).toBe('failed');
  });

  it('bootAllHarnessesForActiveWorkspace forwards resolveSwarmBinding to per-harness', async () => {
    // Empty registry → no per-harness boots, but we can verify the
    // option is accepted without error.
    const calls: number = 0;
    const fakeResolver: SwarmBindingResolver = async () => {
      // never called when there are no harnesses, but the type is exercised
      return null;
    };
    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: ['ws-empty-registry-resolver'],
      discoverHarnessSlugs: async () => [],
      resolveSwarmBinding: fakeResolver,
    });
    expect(result.attempted).toBe(0);
    expect(calls).toBe(0);
  });
});

describe('ensureSendSideWired — EI-521: send-side wiring is idempotent + retryable', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('a transient outbox-wiring failure is RETRIED on the next call (not permanently skipped)', async () => {
    const handle = fakeHandle('ws-wire-retry', 'h');
    let attempt = 0;
    const wireOutbox = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('getOrgPg hiccup'); // first boot fails
    });
    const wirePresence = vi.fn(async () => {});

    // Call 1: outbox throws → NOT marked wired; presence succeeds → wired.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);

    // Call 2: outbox is re-attempted (the EI-521 fix — previously this was
    // skipped forever because the handle was already cached) → now succeeds;
    // presence already wired → skipped.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(2);
    expect(wirePresence).toHaveBeenCalledTimes(1);

    // Call 3: both wired → no-op (no further wiring attempts).
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(2);
    expect(wirePresence).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls COALESCE — a step never double-starts (one drain loop, not two)', async () => {
    const handle = fakeHandle('ws-wire-coalesce', 'h');
    let resolveOutbox: (() => void) | undefined;
    const wireOutbox = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveOutbox = res;
        }),
    );
    const wirePresence = vi.fn(async () => {});

    // Fire two concurrent calls while the first is still in-flight.
    const p1 = ensureSendSideWired(handle, { wireOutbox, wirePresence });
    const p2 = ensureSendSideWired(handle, { wireOutbox, wirePresence });
    // The second call coalesces onto the first's in-flight promise — wireOutbox
    // started exactly once (a second startOutboxDrain would double-append/GC).
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    resolveOutbox?.();
    await Promise.all([p1, p2]);
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);
  });

  it('a presence-wiring failure does NOT block the outbox drain (and presence retries independently)', async () => {
    const handle = fakeHandle('ws-wire-presence-fail', 'h');
    const wireOutbox = vi.fn(async () => {});
    let presenceAttempt = 0;
    const wirePresence = vi.fn(async () => {
      presenceAttempt += 1;
      if (presenceAttempt === 1) throw new Error('presence announce failed');
    });

    // Call 1: outbox wired (the critical send-side path), presence throws → not wired.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);

    // Call 2: outbox already wired → NOT re-attempted; presence retried → succeeds.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox, 'outbox must not re-wire after success').toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(2);
  });

  it('bootSingleHarness RE-WIRES on the already-booted path after a transient wiring failure (EI-521 integration)', async () => {
    // A handle cached by a prior boot whose drain wiring FAILED — the EI-521
    // shape (handle cached, peer_connected ✓, but no drain loop).
    const handle = fakeHandle('ws-rewire', 'h');
    _setHandleForTests('ws-rewire', 'h', handle);
    let attempt = 0;
    const wireOutbox = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('getOrgPg hiccup on first wire');
    });
    const wirePresence = vi.fn(async () => {});

    // First boot pass: already-booted, wiring fails → drain NOT online.
    const r1 = await bootSingleHarness('ws-rewire', 'h', { wireSendSide: { wireOutbox, wirePresence } });
    expect(r1.state).toBe('already-booted');
    expect(wireOutbox).toHaveBeenCalledTimes(1);

    // Next boot pass (boot-all reconcile / rebootHarness): the already-booted
    // short-circuit RE-ATTEMPTS the unwired drain — THE EI-521 FIX. Pre-fix this
    // was skipped forever, so federation stayed dead until a process restart.
    const r2 = await bootSingleHarness('ws-rewire', 'h', { wireSendSide: { wireOutbox, wirePresence } });
    expect(r2.state).toBe('already-booted');
    expect(wireOutbox, 'already-booted path must re-attempt the failed wiring').toHaveBeenCalledTimes(2);

    // Once wired, further passes are no-ops (no redundant drain loops).
    await bootSingleHarness('ws-rewire', 'h', { wireSendSide: { wireOutbox, wirePresence } });
    expect(wireOutbox).toHaveBeenCalledTimes(2);
  });

  it('WI-3684 send-side twin: a SESSION_CLOSED self-stop un-marks wiring so the next pass RE-WIRES fresh', async () => {
    // ensureSendSideWired passes each wire fn an `onSessionClosed` callback
    // (markSendSideUnwired) — captured here so the test can simulate the
    // drain/announce loop itself later detecting a permanently-closed own-log
    // session and firing it, exactly as outbox-drain.ts / presence-announce.ts
    // do on a SESSION_CLOSED append failure.
    const handle = fakeHandle('ws-session-closed-rewire', 'h');
    let capturedOnSessionClosed: (() => void) | undefined;
    const wireOutbox = vi.fn(async (_h: BootedHarnessHandle, onSessionClosed: () => void) => {
      capturedOnSessionClosed = onSessionClosed;
    });
    const wirePresence = vi.fn(async () => {});

    // Call 1: both steps wire successfully (outbox captures its onSessionClosed).
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);
    expect(capturedOnSessionClosed).toBeDefined();

    // Call 2 while nothing has changed: both already wired → no-op.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);

    // Simulate the outbox drain loop itself detecting SESSION_CLOSED on a later
    // poll tick and self-stopping — it fires the captured onSessionClosed,
    // which is markSendSideUnwired('outbox') un-marking JUST the outbox step.
    capturedOnSessionClosed?.();

    // Next boot pass (a reconcile / rebootHarness call against a fresh handle
    // once a new session is available): outbox RE-WIRES fresh; presence, never
    // un-marked, stays skipped — proving the un-mark is step-scoped.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox, 'the un-marked outbox step must re-wire on the next pass').toHaveBeenCalledTimes(2);
    expect(wirePresence, 'presence was never un-marked — must not re-wire').toHaveBeenCalledTimes(1);

    // And once re-wired it settles again (no-op on a further pass).
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(2);
    expect(wirePresence).toHaveBeenCalledTimes(1);
  });

  it('EI-21157761175098740: a latched own-log fork blocks every cross-rewire attempt until store-reset recovery clears it', async () => {
    const workspaceId = 'ws-fork-circuit-breaker';
    const harnessSlug = 'h';
    const handle = fakeHandle(workspaceId, harnessSlug);
    _setHandleForTests(workspaceId, harnessSlug, handle);

    let capturedOnSessionClosed: (() => void) | undefined;
    const wireOutbox = vi.fn(async (_h: BootedHarnessHandle, onSessionClosed: () => void) => {
      capturedOnSessionClosed = onSessionClosed;
    });
    const wirePresence = vi.fn(async () => {});

    // The healthy handle wires once. A later Hypercore conflict latches the
    // permanent fork before the drain observes SESSION_CLOSED and self-stops.
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    reportOwnLogForkConflict(
      {
        workspaceId,
        harnessSlug,
        keyHex: 'f'.repeat(64),
        detail: 'test conflict closes the own-log session',
      },
      { onEpisode: () => {} },
    );
    capturedOnSessionClosed?.();

    // The old implementation recursively called ensureSendSideWired here,
    // creating ~45-50 fresh drains/sec against the SAME closed handle. Neither
    // that callback nor repeated boot-all reconcile passes may wire again while
    // the durable fork latch remains set.
    await Promise.resolve();
    for (let i = 0; i < 50; i += 1) {
      await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    }
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(wirePresence).toHaveBeenCalledTimes(1);

    // The supported store-reset recovery clears this exact latch and reboots;
    // model that post-reset boundary and prove normal one-shot wiring resumes.
    clearOwnLogForkState(workspaceId, harnessSlug);
    await ensureSendSideWired(handle, { wireOutbox, wirePresence });
    expect(wireOutbox).toHaveBeenCalledTimes(2);
    expect(wirePresence).toHaveBeenCalledTimes(1);
  });
});

// WI-1877: after a substrate-sidecar crash+respawn, cached RemoteBootedHarnessHandle
// entries still point at the OLD (now-gone) sidecar instance — the new sidecar boots
// with zero harnesses registered, so federation goes silently dark until a full app
// restart unless something re-issues bootHarness for each one.
describe('reconcileRemoteHandlesAfterSidecarRestart (WI-1877)', () => {
  function fakeRemoteHandle(workspaceId: string, harnessSlug: string): RemoteBootedHarnessHandle {
    return new RemoteBootedHarnessHandle({
      workspaceId,
      harnessSlug,
      storeId: `store-${workspaceId}-${harnessSlug}`,
      ownLogKey: 'a'.repeat(64),
      // vi.fn erases the generic `call<T>` signature, so cast it back to the injected type.
      client: { call: vi.fn(async () => ({})) as unknown as SubstrateRpcCaller['call'] },
    });
  }

  afterEach(() => {
    _resetSubstrateBootDefaultsForTests();
  });

  it('re-boots every cached REMOTE handle onto the fresh sidecar via the installed default boot factory', async () => {
    const remoteA = fakeRemoteHandle('ws-1', 'remote-a');
    const remoteB = fakeRemoteHandle('ws-1', 'remote-b');
    _setHandleForTests('ws-1', 'remote-a', remoteA);
    _setHandleForTests('ws-1', 'remote-b', remoteB);

    const rebootCalls: string[] = [];
    setSubstrateBootDefaults({
      bootHarness: async ({ workspaceId, harnessSlug }) => {
        rebootCalls.push(`${workspaceId}::${harnessSlug}`);
        return fakeRemoteHandle(workspaceId, harnessSlug);
      },
      skipSendSideWiring: true,
    });

    const result = await reconcileRemoteHandlesAfterSidecarRestart();

    expect(rebootCalls.sort()).toEqual(['ws-1::remote-a', 'ws-1::remote-b']);
    expect(result.rebooted.sort()).toEqual(['ws-1::remote-a', 'ws-1::remote-b']);
    expect(result.failed).toEqual([]);
    // The stale handles were torn down (rebootHarness closes-then-boots) and
    // replaced with fresh ones registered against the NEW sidecar.
    expect(getBootedHarness('ws-1', 'remote-a')).not.toBe(remoteA);
    expect(getBootedHarness('ws-1', 'remote-b')).not.toBe(remoteB);
  });

  it('leaves IN-PROCESS (non-remote) handles completely untouched', async () => {
    const local = fakeHandle('ws-1', 'local-only');
    _setHandleForTests('ws-1', 'local-only', local);
    setSubstrateBootDefaults({ bootHarness: async () => fakeHandle('ws-1', 'unused'), skipSendSideWiring: true });

    const result = await reconcileRemoteHandlesAfterSidecarRestart();

    expect(result.rebooted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(local.close).not.toHaveBeenCalled();
    expect(getBootedHarness('ws-1', 'local-only')).toBe(local);
  });

  it('one harness failing to re-boot never blocks the others', async () => {
    const remoteA = fakeRemoteHandle('ws-1', 'ok');
    const remoteB = fakeRemoteHandle('ws-1', 'boom');
    _setHandleForTests('ws-1', 'ok', remoteA);
    _setHandleForTests('ws-1', 'boom', remoteB);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setSubstrateBootDefaults({
      bootHarness: async ({ workspaceId, harnessSlug }) => {
        if (harnessSlug === 'boom') throw new Error('sidecar rejected boot');
        return fakeRemoteHandle(workspaceId, harnessSlug);
      },
      skipSendSideWiring: true,
    });

    const result = await reconcileRemoteHandlesAfterSidecarRestart();

    expect(result.rebooted).toEqual(['ws-1::ok']);
    expect(result.failed).toEqual([{ key: 'ws-1::boom', error: 'sidecar rejected boot' }]);
    errSpy.mockRestore();
  });

  it('returns cleanly with no work when nothing is cached', async () => {
    const result = await reconcileRemoteHandlesAfterSidecarRestart();
    expect(result).toEqual({ rebooted: [], failed: [] });
  });

  it('bounds concurrency (mirrors the WI-779 boot-all guard) instead of firing every reboot at once', async () => {
    const N = 10;
    for (let i = 0; i < N; i++) {
      _setHandleForTests('ws-conc', `r${i}`, fakeRemoteHandle('ws-conc', `r${i}`));
    }
    let active = 0;
    let peak = 0;
    setSubstrateBootDefaults({
      bootHarness: async ({ workspaceId, harnessSlug }) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return fakeRemoteHandle(workspaceId, harnessSlug);
      },
      skipSendSideWiring: true,
    });

    const result = await reconcileRemoteHandlesAfterSidecarRestart(3);

    expect(result.rebooted).toHaveLength(N);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
