/**
 * WI-10006703 — whenProvidersRegistered() is how a reader on a request-only host (which never
 * warms the plugin host at boot) gets the plugin providers into providerRegistry(): it must START
 * discovery when nothing has, and must not resolve until discovery has registered providers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({
  release: null as null | (() => void),
  calls: 0,
}));

vi.mock('@papercusp/plugin-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/plugin-loader')>()),
  loadPlugins: vi.fn(() => {
    loader.calls += 1;
    return new Promise((resolveLoad) => {
      loader.release = () => resolveLoad({ loaded: [], errors: [] });
    });
  }),
}));

import {
  _injectPluginHostForTests,
  _resetPluginHostForTests,
  getPluginHost,
  whenProvidersRegistered,
} from './plugin-host-runtime';

afterEach(() => {
  loader.release?.();
  loader.release = null;
  loader.calls = 0;
  _resetPluginHostForTests();
});

const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 25));

describe('whenProvidersRegistered', () => {
  it('starts plugin discovery in a process that has not run it, and waits for it', async () => {
    _resetPluginHostForTests();
    let settled = false;
    const ready = whenProvidersRegistered().then(() => {
      settled = true;
    });
    // discover() first imports the design-compare host and scans harnesses, so loading starts late.
    await vi.waitFor(() => expect(loader.calls).toBe(1), { timeout: 30_000, interval: 50 });
    await tick();
    expect(settled).toBe(false);

    loader.release?.();
    await ready;
    expect(settled).toBe(true);
    await getPluginHost();
    // One discovery, shared: asking again neither restarts it nor waits.
    await whenProvidersRegistered();
    expect(loader.calls).toBe(1);
  }, 60_000);

  it('resolves at once for an injected host (its providers are registered by the test itself)', async () => {
    _injectPluginHostForTests([]);
    await expect(whenProvidersRegistered()).resolves.toBeUndefined();
    expect(loader.calls).toBe(0);
  });
});
