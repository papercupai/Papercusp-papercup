/**
 * Plugin host ⇄ provider registry lifecycle (generalized-integrations-google-
 * migration-cupboard-workflows-2026-10-05, D-006 / P-001).
 *
 * Load registers a plugin's provider; re-discovery re-registers without a
 * duplicate collision; a refused adapter is reported, not thrown; daemon
 * providers are deferred to the daemon bridge; every unload path (the host
 * reset) removes the plugin's providers from the process-wide registry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '@papercusp/plugin-loader';
import type { Plugin, ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import {
  _injectPluginHostForTests,
  _resetPluginHostForTests,
  isDaemonProviderPlugin,
  registerPluginProviders,
  unregisterPluginProviders,
  type ProviderRegistrationFailure,
} from '../plugin-host-runtime';
import { createProviderRegistry, providerRegistry } from './provider-registry';
import {
  daemonProviderRuntimes,
  resolveProviderCommand,
  stopDaemonProvider,
  type DaemonProviderRuntime,
  type StartDaemonProviderOptions,
} from './daemon-provider';

function descriptor(id: string): ProviderDescriptor {
  return {
    id,
    contractVersion: 1,
    datatypes: ['calendar-event'],
    capabilities: ['calendar.read'],
    egressHosts: ['calendar.example.com'],
  };
}

function adapter(d: ProviderDescriptor): ProviderAdapter {
  return {
    describe: () => d,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async () => ({ ok: true }),
  };
}

function loaded(
  name: string,
  opts: {
    provider?: ProviderDescriptor;
    adapter?: unknown;
    runtime?: 'js' | 'daemon' | 'wasm';
    daemonCommand?: string[];
  } = {},
): LoadedPlugin {
  const plugin = {
    name,
    version: '0.1.0',
    papercusp: '^0.1.0',
    capabilities: [],
    providerAdapter: opts.adapter,
  } as unknown as Plugin;
  return {
    plugin,
    path: `/tmp/${name}`,
    source: 'global',
    runtime: { kind: opts.runtime ?? 'js', daemonCommand: opts.daemonCommand } as LoadedPlugin['runtime'],
    provider: opts.provider,
  };
}

/** A fake sandboxed-daemon starter: records each start and each shutdown. */
function fakeDaemonStarter(opts: { describes?: ProviderDescriptor; fail?: Error } = {}) {
  const starts: StartDaemonProviderOptions[] = [];
  const shutdowns: string[] = [];
  const start = async (o: StartDaemonProviderOptions): Promise<DaemonProviderRuntime> => {
    starts.push(o);
    if (opts.fail) throw opts.fail;
    const described = opts.describes ?? o.declared!;
    const shutdown = async () => {
      shutdowns.push(o.pluginName);
    };
    return {
      descriptor: described,
      adapter: adapter(described),
      handle: { request: async () => undefined as never, shutdown, pid: () => 4242 },
      activeCalls: () => 0,
      shutdown,
    };
  };
  return { start, starts, shutdowns };
}

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

afterEach(async () => {
  _resetPluginHostForTests();
  providerRegistry().clear();
  for (const name of [...daemonProviderRuntimes().keys()]) await stopDaemonProvider(name);
});

describe('registerPluginProviders', () => {
  it('registers a js provider and ignores plugins without one', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-cal');
    const errors: ProviderRegistrationFailure[] = [];
    const ids = await registerPluginProviders(
      [loaded('plain'), loaded('cal', { provider: d, adapter: adapter(d) })],
      (e) => errors.push(e),
      registry,
    );
    expect(ids).toEqual(['fixture-cal']);
    expect(errors).toEqual([]);
    expect(registry.get('fixture-cal')?.pluginName).toBe('cal');
    expect(registry.forDatatype('calendar-event').map((p) => p.descriptor.id)).toEqual(['fixture-cal']);
  });

  it('re-discovery re-registers the same plugin without a duplicate-provider refusal', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-cal');
    const lp = loaded('cal', { provider: d, adapter: adapter(d) });
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders([lp], (e) => errors.push(e), registry);
    await registerPluginProviders([lp], (e) => errors.push(e), registry);
    expect(errors).toEqual([]);
    expect(registry.list()).toHaveLength(1);
  });

  it('reports a second plugin claiming a taken provider id as duplicate-provider', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-cal');
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders(
      [loaded('cal-a', { provider: d, adapter: adapter(d) }), loaded('cal-b', { provider: d, adapter: adapter(d) })],
      (e) => errors.push(e),
      registry,
    );
    expect(errors.map((e) => [e.plugin, e.code])).toEqual([['cal-b', 'duplicate-provider']]);
    expect(registry.get('fixture-cal')?.pluginName).toBe('cal-a');
  });

  it('reports a missing adapter without throwing and leaves nothing registered', async () => {
    const registry = createProviderRegistry();
    const errors: ProviderRegistrationFailure[] = [];
    const ids = await registerPluginProviders(
      [loaded('cal', { provider: descriptor('fixture-cal') })],
      (e) => errors.push(e),
      registry,
    );
    expect(ids).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(['invalid-adapter']);
    expect(registry.list()).toEqual([]);
  });

  it('refuses wasm providers', async () => {
    const registry = createProviderRegistry();
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders(
      [loaded('w', { provider: descriptor('fixture-wasm'), runtime: 'wasm' })],
      (e) => errors.push(e),
      registry,
    );
    expect(registry.list()).toEqual([]);
    expect(errors.map((e) => [e.plugin, e.code])).toEqual([['w', 'unsupported-runtime']]);
  });

  it('unregisterPluginProviders removes only the named plugins', async () => {
    const registry = createProviderRegistry();
    const a = descriptor('fixture-a');
    const b = descriptor('fixture-b');
    const lpA = loaded('a', { provider: a, adapter: adapter(a) });
    const lpB = loaded('b', { provider: b, adapter: adapter(b) });
    await registerPluginProviders([lpA, lpB], () => {}, registry);
    expect(unregisterPluginProviders([lpA], registry)).toEqual(['fixture-a']);
    expect(registry.list().map((p) => p.descriptor.id)).toEqual(['fixture-b']);
  });
});

describe('daemon providers (P-002, D-006)', () => {
  it('starts the daemon under the provider sandbox with the manifest command, dir and descriptor, and registers it as runtime daemon', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-daemon');
    const fake = fakeDaemonStarter();
    const errors: ProviderRegistrationFailure[] = [];
    const ids = await registerPluginProviders(
      [loaded('d', { provider: d, runtime: 'daemon', daemonCommand: ['node', 'provider.js'] })],
      (e) => errors.push(e),
      registry,
      fake.start,
    );
    expect(errors).toEqual([]);
    expect(ids).toEqual(['fixture-daemon']);
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]).toMatchObject({
      pluginName: 'd',
      pluginDir: '/tmp/d',
      cmd: ['node', 'provider.js'],
      declared: d,
    });
    const entry = registry.get('fixture-daemon');
    expect(entry?.runtime).toBe('daemon');
    expect(entry?.pluginName).toBe('d');
    expect(daemonProviderRuntimes().has('d')).toBe(true);
  });

  it('registers the MANIFEST descriptor, so a daemon cannot widen its egress hosts by describing more', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-daemon');
    const wider = { ...d, egressHosts: [...d.egressHosts, 'exfil.example.net'] };
    const fake = fakeDaemonStarter({ describes: wider });
    await registerPluginProviders(
      [loaded('d', { provider: d, runtime: 'daemon', daemonCommand: ['node', 'p.js'] })],
      () => {},
      registry,
      fake.start,
    );
    expect(registry.get('fixture-daemon')?.descriptor.egressHosts).toEqual(['calendar.example.com']);
  });

  it('reports a refused sandbox start by its code and registers nothing (no unsandboxed fallback)', async () => {
    const registry = createProviderRegistry();
    const refusal = Object.assign(new Error('provider sandbox unavailable'), { code: 'sandbox-unavailable' });
    const fake = fakeDaemonStarter({ fail: refusal });
    const errors: ProviderRegistrationFailure[] = [];
    const ids = await registerPluginProviders(
      [loaded('d', { provider: descriptor('fixture-daemon'), runtime: 'daemon', daemonCommand: ['node', 'p.js'] })],
      (e) => errors.push(e),
      registry,
      fake.start,
    );
    expect(ids).toEqual([]);
    expect(errors.map((e) => [e.plugin, e.code])).toEqual([['d', 'sandbox-unavailable']]);
    expect(registry.list()).toEqual([]);
    expect(daemonProviderRuntimes().has('d')).toBe(false);
  });

  it('shuts the daemon down when registration is refused after it started', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-daemon');
    // The daemon describes a different contract version than the manifest declares.
    const fake = fakeDaemonStarter({ describes: { ...d, contractVersion: 2 } as ProviderDescriptor });
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders(
      [loaded('d', { provider: d, runtime: 'daemon', daemonCommand: ['node', 'p.js'] })],
      (e) => errors.push(e),
      registry,
      fake.start,
    );
    expect(errors.map((e) => e.code)).toEqual(['descriptor-mismatch']);
    expect(fake.shutdowns).toEqual(['d']);
    expect(registry.list()).toEqual([]);
    expect(daemonProviderRuntimes().has('d')).toBe(false);
  });

  it('reports a daemon provider with no command without starting anything', async () => {
    const registry = createProviderRegistry();
    const fake = fakeDaemonStarter();
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders(
      [loaded('d', { provider: descriptor('fixture-daemon'), runtime: 'daemon' })],
      (e) => errors.push(e),
      registry,
      fake.start,
    );
    expect(errors.map((e) => e.code)).toEqual(['daemon-command-missing']);
    expect(fake.starts).toEqual([]);
  });

  it('re-discovery stops the running daemon before starting its replacement', async () => {
    const registry = createProviderRegistry();
    const lp = loaded('d', { provider: descriptor('fixture-daemon'), runtime: 'daemon', daemonCommand: ['node', 'p.js'] });
    const fake = fakeDaemonStarter();
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders([lp], (e) => errors.push(e), registry, fake.start);
    await registerPluginProviders([lp], (e) => errors.push(e), registry, fake.start);
    expect(errors).toEqual([]);
    expect(fake.starts).toHaveLength(2);
    expect(fake.shutdowns).toEqual(['d']);
    expect(registry.list()).toHaveLength(1);
  });

  it('unregisterPluginProviders stops the plugin’s daemon and forgets it', async () => {
    const registry = createProviderRegistry();
    const lp = loaded('d', { provider: descriptor('fixture-daemon'), runtime: 'daemon', daemonCommand: ['node', 'p.js'] });
    const fake = fakeDaemonStarter();
    await registerPluginProviders([lp], () => {}, registry, fake.start);
    expect(unregisterPluginProviders([lp], registry)).toEqual(['fixture-daemon']);
    expect(daemonProviderRuntimes().has('d')).toBe(false);
    await flushMicrotasks();
    expect(fake.shutdowns).toEqual(['d']);
  });

  it('marks only daemon plugins that declare a provider as provider daemons (no unsandboxed action daemon)', () => {
    const d = descriptor('fixture-daemon');
    expect(isDaemonProviderPlugin(loaded('a', { provider: d, runtime: 'daemon', daemonCommand: ['x'] }))).toBe(true);
    expect(isDaemonProviderPlugin(loaded('b', { runtime: 'daemon', daemonCommand: ['x'] }))).toBe(false);
    expect(isDaemonProviderPlugin(loaded('c', { provider: d, adapter: adapter(d) }))).toBe(false);
  });
});

describe('daemon provider command resolution', () => {
  it('maps a bare node to this host’s node and leaves other commands alone', () => {
    expect(resolveProviderCommand(['node', 'provider.js'])).toEqual([process.execPath, 'provider.js']);
    expect(resolveProviderCommand(['/opt/bin/prov', '--serve'])).toEqual(['/opt/bin/prov', '--serve']);
  });
});

describe('plugin host unload', () => {
  it('the host reset (every unload path) removes the loaded plugins’ providers', async () => {
    const d = descriptor('fixture-host-cal');
    const lp = loaded('host-cal', { provider: d, adapter: adapter(d) });
    _injectPluginHostForTests([lp]);
    await registerPluginProviders([lp], () => {});
    expect(providerRegistry().get('fixture-host-cal')).toBeDefined();
    _resetPluginHostForTests();
    expect(providerRegistry().get('fixture-host-cal')).toBeUndefined();
  });
});
