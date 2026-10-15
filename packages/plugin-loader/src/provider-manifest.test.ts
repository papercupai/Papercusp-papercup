/**
 * Loader validation for the integration provider declaration
 * (generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
 * D-006 / P-001).
 *
 * Asserts: a plugin whose manifest declares a valid `provider` loads and
 * exposes the descriptor on `LoadedPlugin.provider` alongside the entry's
 * `providerAdapter`; an invalid descriptor (unsupported contract version,
 * secret in the OAuth block, OAuth endpoint outside egress) is refused at
 * load with a named manifest error, so the host never sees it.
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginFromDir, type LoadedPlugin } from './index.ts';

const ROOT = join(tmpdir(), `papercusp-provider-manifest-test-${process.pid}`);

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixture-mail',
    contractVersion: 1,
    datatypes: ['email-message'],
    capabilities: ['mail.read'],
    egressHosts: ['mail.example.com', 'auth.example.com'],
    oauth: {
      authorizeUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: ['mail.read'],
      pkce: true,
    },
    ...overrides,
  };
}

async function makeProviderPlugin(name: string, provider: Record<string, unknown>): Promise<string> {
  const dir = join(ROOT, name);
  await fs.mkdir(dir, { recursive: true });
  const manifest = { name, version: '0.1.0', papercusp: '^0.1.0', capabilities: [], tools: [], provider };
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest), 'utf8');
  const entry = [
    `const provider = ${JSON.stringify(provider)};`,
    'module.exports = {',
    `  name: ${JSON.stringify(name)}, version: '0.1.0', papercusp: '^0.1.0', capabilities: [],`,
    '  providerAdapter: {',
    '    describe: () => provider,',
    '    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),',
    '    invoke: async () => ({ ok: true }),',
    '  },',
    '};',
  ].join('\n');
  await fs.writeFile(join(dir, 'index.cjs'), entry, 'utf8');
  return dir;
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('provider manifest declaration', () => {
  it('loads an explicit reauthorization policy and rejects unknown expiry policies', async () => {
    for (const refreshPolicy of ['refresh-token', 'reauthorize']) {
      const d = descriptor();
      (d.oauth as Record<string, unknown>).refreshPolicy = refreshPolicy;
      const result = await loadPluginFromDir(await makeProviderPlugin(`fixture-${refreshPolicy}`, d), 'global');
      assert(!('error' in result), JSON.stringify(result));
    }
    const bad = descriptor();
    (bad.oauth as Record<string, unknown>).refreshPolicy = 'ignore-expiry';
    const result = await loadPluginFromDir(await makeProviderPlugin('fixture-ignore-expiry', bad), 'global');
    assert('error' in result);
    assert.match(result.error, /refreshPolicy/);
  });

  it('loads a valid provider plugin and exposes descriptor + adapter', async () => {
    const dir = await makeProviderPlugin('fixture-provider-ok', descriptor());
    const r = await loadPluginFromDir(dir, 'global');
    assert(!('error' in r), `expected load, got: ${(r as { error?: string }).error}`);
    assert(!('skipped' in r));
    const lp = r as LoadedPlugin;
    assert.equal(lp.provider?.id, 'fixture-mail');
    assert.deepEqual(lp.provider?.datatypes, ['email-message']);
    assert.equal(typeof lp.plugin.providerAdapter?.syncPage, 'function');
  });

  it('refuses an unsupported contract version at load', async () => {
    const dir = await makeProviderPlugin('fixture-provider-v9', descriptor({ contractVersion: 9 }));
    const r = await loadPluginFromDir(dir, 'global');
    assert('error' in r, 'expected a manifest error');
    assert.match((r as { error: string }).error, /manifest invalid: .*provider\.contractVersion/);
  });

  it('refuses a client secret in the OAuth descriptor', async () => {
    const bad = descriptor();
    (bad.oauth as Record<string, unknown>).clientSecret = 'leak';
    const dir = await makeProviderPlugin('fixture-provider-secret', bad);
    const r = await loadPluginFromDir(dir, 'global');
    assert('error' in r, 'expected a manifest error');
    assert.match((r as { error: string }).error, /clientSecret/);
  });

  it('refuses an OAuth endpoint outside the declared egress hosts', async () => {
    const dir = await makeProviderPlugin('fixture-provider-egress', descriptor({ egressHosts: ['mail.example.com'] }));
    const r = await loadPluginFromDir(dir, 'global');
    assert('error' in r, 'expected a manifest error');
    assert.match((r as { error: string }).error, /auth\.example\.com/);
  });
});
