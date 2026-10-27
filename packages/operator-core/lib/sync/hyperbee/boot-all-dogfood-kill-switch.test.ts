/**
 * WI-6554700010029282: PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 governs the SUBSTRATE boot,
 * not just the dogfood join.
 *
 * Pins the 2026-10-26 dev-box incident: the packaged Papercusp Server's harness
 * registry carried the dogfood `papercusp-workspace/papercusp` harness from an
 * earlier boot, so every start booted its substrate. That resolves to the SAME
 * Corestore as the dev fleet's harness; started while bg-host was down, the server
 * took the store lock and held it, and git-sync publication was refused for hours.
 * The kill switch only gated `bootstrapPapercuspHive`, which a pre-existing registry
 * entry never reaches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetHandleMapForTests, bootSingleHarness, isDisabledDogfoodHive } from './boot-all';
import type { BootedHarnessHandle } from './boot';

const DOGFOOD_WS = 'papercusp-workspace';
const DOGFOOD_SLUG = 'papercusp';

function fakeHandle(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  return {
    workspaceId,
    harnessSlug,
    swarm: null,
    registerCloseHook: () => {},
    close: async () => {},
  } as unknown as BootedHarnessHandle;
}

function bootDeps() {
  const bootHarness = vi.fn(async (o: { workspaceId: string; harnessSlug: string }) =>
    fakeHandle(o.workspaceId, o.harnessSlug),
  );
  const wireOutbox = vi.fn(async () => {});
  const wirePresence = vi.fn(async () => {});
  return {
    bootHarness,
    wireOutbox,
    wirePresence,
    opts: {
      resolveSwarmBinding: async () => null,
      bootHarness: bootHarness as never,
      wireSendSide: { wireOutbox, wirePresence },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetHandleMapForTests();
});

describe('boot-all dogfood-hive kill switch (WI-6554700010029282)', () => {
  it('defers the dogfood hive substrate without opening a store when the switch is set', async () => {
    vi.stubEnv('PAPERCUSP_DISABLE_DOGFOOD_HIVE', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = bootDeps();

    const res = await bootSingleHarness(DOGFOOD_WS, DOGFOOD_SLUG, d.opts);

    expect(res).toEqual({
      workspaceId: DOGFOOD_WS,
      harnessSlug: DOGFOOD_SLUG,
      state: 'deferred',
      deferReason: 'dogfood-hive-disabled',
    });
    expect(d.bootHarness).not.toHaveBeenCalled();
    expect(d.wireOutbox).not.toHaveBeenCalled();
    expect(d.wirePresence).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PAPERCUSP_DISABLE_DOGFOOD_HIVE=1'));
  });

  it('still boots every other harness when the switch is set', async () => {
    vi.stubEnv('PAPERCUSP_DISABLE_DOGFOOD_HIVE', '1');
    const d = bootDeps();

    const sameWorkspace = await bootSingleHarness(DOGFOOD_WS, 'other-harness', d.opts);
    const sameSlugElsewhere = await bootSingleHarness('some-other-workspace', DOGFOOD_SLUG, d.opts);

    expect(sameWorkspace.state).toBe('booted');
    expect(sameSlugElsewhere.state).toBe('booted');
    expect(d.bootHarness).toHaveBeenCalledTimes(2);
  });

  it('boots the dogfood hive normally when the switch is unset (the dev fleet is its home)', async () => {
    vi.stubEnv('PAPERCUSP_DISABLE_DOGFOOD_HIVE', '');
    const d = bootDeps();

    const res = await bootSingleHarness(DOGFOOD_WS, DOGFOOD_SLUG, d.opts);

    expect(res.state).toBe('booted');
    expect(d.bootHarness).toHaveBeenCalledTimes(1);
  });

  it('honours only the exact value 1, matching the bootstrap gate', async () => {
    await expect(isDisabledDogfoodHive(DOGFOOD_WS, DOGFOOD_SLUG, { PAPERCUSP_DISABLE_DOGFOOD_HIVE: '1' })).resolves.toBe(true);
    await expect(isDisabledDogfoodHive(DOGFOOD_WS, DOGFOOD_SLUG, { PAPERCUSP_DISABLE_DOGFOOD_HIVE: 'true' })).resolves.toBe(false);
    await expect(isDisabledDogfoodHive(DOGFOOD_WS, DOGFOOD_SLUG, { PAPERCUSP_DISABLE_DOGFOOD_HIVE: '0' })).resolves.toBe(false);
    await expect(isDisabledDogfoodHive(DOGFOOD_WS, DOGFOOD_SLUG, {})).resolves.toBe(false);
  });
});
