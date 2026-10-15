/**
 * WI-10006703 — plugin providers enter providerRegistry() only during plugin discovery, and a
 * request-only host (PAPERCUSP_BACKGROUND_WORKERS=0, :3170; :3070/:3270 under the bg-host
 * topology) defers discovery to the first request that needs it. A reader that took the registry
 * bare listed no Linear/Asana providers on Settings → Integrations and could not start their OAuth.
 *
 * Pins (1) readyProviderRegistry()'s contract and (2) that production code reads the registry bare
 * only where a stated reason holds; a new bare reader fails here and is told to await readiness.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { stripCommentsOnly } from '../../../../scripts/lib/strip-comments-and-strings.mjs';
import { ProviderRegistryNotReadyError, providerRegistry, readyProviderRegistry } from './provider-registry';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('readyProviderRegistry', () => {
  it('waits for provider registration before handing out the registry', async () => {
    let release: () => void = () => {};
    const registered = new Promise<void>((resolveRegistered) => {
      release = resolveRegistered;
    });
    let settled = false;
    const pending = readyProviderRegistry({ whenRegistered: () => registered, timeoutMs: 5_000 }).then((registry) => {
      settled = true;
      return registry;
    });
    await new Promise((tick) => setTimeout(tick, 25));
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toBe(providerRegistry());
  });

  it('refuses as not-ready rather than return a registry that silently lacks the plugin providers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const never = () => new Promise<void>(() => {});
    const error = await readyProviderRegistry({ whenRegistered: never, timeoutMs: 30 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRegistryNotReadyError);
    expect((error as ProviderRegistryNotReadyError).code).toBe('provider_registry_not_ready');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider registration exceeded 30ms'));
    warn.mockRestore();
  });

  it('treats a discovery that failed as not ready', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = () => Promise.reject(new Error('discovery threw'));
    await expect(readyProviderRegistry({ whenRegistered: failed, timeoutMs: 1_000 })).rejects.toBeInstanceOf(
      ProviderRegistryNotReadyError,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider registration failed: discovery threw'));
    warn.mockRestore();
  });
});

/**
 * Every production file allowed to call providerRegistry() bare, with why it is safe. Anything
 * else awaits readyProviderRegistry() (or awaitDescriptorProviders() for a token-store plugin).
 */
const BARE_READERS: Record<string, string> = {
  'integrations/provider-registry.ts': 'the definition itself',
  'plugin-host-runtime.ts': 'the plugin host registers and unregisters providers during discovery',
  'integrations/connection-lifecycle.ts':
    'descriptorGroupMembers: resolveOAuthProvider, connectionAccessToken and both OAuth routes await awaitDescriptorProviders() before reaching it',
  'integrations/source-host-fetch.ts':
    'default for callers that pass no registry; connector-runtime and record-source hold a ready registry before fetching',
  'providers/connector-runtime.ts':
    'defaultHostFetchFor runs only inside runConnectorSync, after it awaited readyProviderRegistry()',
};

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
    return [path];
  });
}

/** Files under lib/ whose CODE (comments stripped) calls providerRegistry(). */
function bareReaders(): string[] {
  return productionFiles(LIB)
    .filter((path) => {
      const source = readFileSync(path, 'utf8');
      if (!source.includes('providerRegistry(')) return false;
      const code = stripCommentsOnly(source, path).replace(/\bfunction\s+providerRegistry\s*\(/g, '');
      return /\bproviderRegistry\(\s*\)/.test(code);
    })
    .map((path) => relative(LIB, path).split('\\').join('/'))
    .sort();
}

describe('bare providerRegistry() readers (WI-10006703)', () => {
  const found = bareReaders();

  it('only appear where readiness is already established', () => {
    const unexplained = found.filter((file) => !(file in BARE_READERS));
    expect(
      unexplained,
      `these files read providerRegistry() bare; on a request-only host it is empty until plugin discovery runs. ` +
        `Await readyProviderRegistry() instead, or add the file to BARE_READERS with the reason it is safe`,
    ).toEqual([]);
  });

  it('every listed reader still reads it bare (no stale reasons; also proves the scan sees real calls)', () => {
    const stale = Object.keys(BARE_READERS).filter(
      (file) => file !== 'integrations/provider-registry.ts' && !found.includes(file),
    );
    expect(stale, 'remove these from BARE_READERS: they no longer call providerRegistry() bare').toEqual([]);
    expect(found).toContain('plugin-host-runtime.ts');
  });
});
