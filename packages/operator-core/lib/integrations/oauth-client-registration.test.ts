/**
 * OAuth client registrations saved from Settings → Integrations (plan
 * cupboard-distributable-integrations-2026-10-10 P-009).
 *
 * SPEC-R-2-P-009: a registration saved here is the one the provider's connect flow reads, under the
 * key that flow derives (group lead's clientRegistrationRef, else the group id).
 * SPEC-R-7-P-009: no read returns the client secret, and a refusal never echoes a submitted value.
 * Also pinned: the write keeps every other entry (the legacy GitHub/Facebook loader shares the
 * file), is mode 0600, and never overwrites a file it cannot parse.
 *
 * Runs against a real oauth-apps.json under a temporary PAPERCUSP_HOME. Fixture values are
 * neutral, low-entropy strings, not vendor-token-shaped.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderDescriptor, ProviderOAuthDescriptor } from '@papercusp/plugin-sdk';

// Provider discovery is the plugin host's job; the round-trip case registers descriptors directly.
vi.mock('../plugin-host-runtime', () => ({ whenProvidersRegistered: async () => undefined }));

import { providerRegistry } from './provider-registry';
import { resolveOAuthProvider } from './connection-lifecycle';
import {
  clientRegistrationRefOf,
  OAuthClientRegistrationError,
  oauthClientRegistrationStatus,
  oauthClientRegistrationStatuses,
  readOAuthClientRegistration,
  saveOAuthClientRegistration,
} from './oauth-client-registration';

const PLUGIN_NAME = 'oauth-client-registration-unit';
const OPERATOR_BASE = 'https://operator.unit.test';
const SECRET = 'unit-secret-value';
const OTHER_SECRET = 'other-secret-value';

let home: string;

const file = () => join(home, 'oauth-apps.json');
const readFile = async () => JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, Record<string, unknown>>;

function descriptor(id: string, oauth: Partial<ProviderOAuthDescriptor> | null): ProviderDescriptor {
  return {
    id,
    contractVersion: 1,
    datatypes: ['ticket'],
    capabilities: ['ticket.sync'],
    egressHosts: ['*.unit-oauth.test'],
    ...(oauth
      ? {
          oauth: {
            authorizeUrl: 'https://auth.unit-oauth.test/authorize',
            tokenUrl: 'https://auth.unit-oauth.test/token',
            scopes: ['read'],
            ...oauth,
          },
        }
      : {}),
  };
}

function adapter(d: ProviderDescriptor): ProviderAdapter {
  return {
    describe: () => d,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async () => ({ ok: true }),
  };
}

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-oauth-client-unit-'));
  vi.stubEnv('PAPERCUSP_HOME', home);
  vi.stubEnv('PAPERCUSP_OPERATOR_BASE', OPERATOR_BASE);
  providerRegistry().unregisterPlugin(PLUGIN_NAME);
});

afterEach(async () => {
  providerRegistry().unregisterPlugin(PLUGIN_NAME);
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('clientRegistrationRefOf', () => {
  it('is the group id by default, the lead member’s clientRegistrationRef when set, and null without OAuth', () => {
    const solo = descriptor('unit-solo', {});
    const leadA = descriptor('unit-a-chat', { credentialGroup: 'unit-a', clientRegistrationRef: 'byo-a' });
    const memberB = descriptor('unit-b-tickets', { credentialGroup: 'unit-a', clientRegistrationRef: 'ignored-b' });
    expect(clientRegistrationRefOf(solo, [])).toBe('unit-solo');
    // The lead is the first member by id, whichever member asks.
    expect(clientRegistrationRefOf(memberB, [leadA, memberB])).toBe('byo-a');
    expect(clientRegistrationRefOf(leadA, [leadA, memberB])).toBe('byo-a');
    expect(clientRegistrationRefOf(descriptor('unit-plain', null), [])).toBeNull();
  });
});

describe('saveOAuthClientRegistration', () => {
  it('reports an unsaved registration as not configured, with the operator callback as redirect URL', async () => {
    expect(await oauthClientRegistrationStatus('unit-solo')).toEqual({
      ref: 'unit-solo',
      configured: false,
      clientId: null,
      hasClientSecret: false,
      redirectUri: `${OPERATOR_BASE}/api/oauth/callback`,
      savedAt: null,
    });
  });

  it('stores the secret host-side, mode 0600, keeps other entries, and never returns the secret', async () => {
    await fs.writeFile(file(), JSON.stringify({ github: { clientId: 'gh-client', clientSecretFile: '/elsewhere/gh' } }));

    const status = await saveOAuthClientRegistration('unit-solo', { clientId: ' unit-client ', clientSecret: SECRET }, { requireSecret: true });

    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(status).toMatchObject({ ref: 'unit-solo', configured: true, clientId: 'unit-client', hasClientSecret: true });
    expect(typeof status.savedAt).toBe('string');
    const saved = await readFile();
    expect(saved.github).toEqual({ clientId: 'gh-client', clientSecretFile: '/elsewhere/gh' });
    expect(saved['unit-solo']).toMatchObject({ clientId: 'unit-client', clientSecret: SECRET });
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600);

    // Every later read is status only.
    expect(JSON.stringify(await oauthClientRegistrationStatus('unit-solo'))).not.toContain(SECRET);
    expect(JSON.stringify([...(await oauthClientRegistrationStatuses(['unit-solo', 'github'])).values()])).not.toContain(SECRET);
  });

  it('keeps the saved secret when re-saved without one, and an inline secret replaces a secret file', async () => {
    await fs.writeFile(file(), JSON.stringify({ 'unit-solo': { clientId: 'old', clientSecretFile: '/elsewhere/s', redirectUri: 'https://relay.unit.test/cb' } }));

    await saveOAuthClientRegistration('unit-solo', { clientId: 'renamed' }, { requireSecret: true });
    expect((await readFile())['unit-solo']).toMatchObject({ clientId: 'renamed', clientSecretFile: '/elsewhere/s', redirectUri: 'https://relay.unit.test/cb' });

    const status = await saveOAuthClientRegistration('unit-solo', { clientId: 'renamed', clientSecret: OTHER_SECRET }, { requireSecret: true });
    const entry = (await readFile())['unit-solo'];
    expect(entry.clientSecret).toBe(OTHER_SECRET);
    expect(entry).not.toHaveProperty('clientSecretFile');
    // A registration's own redirect URL is what the page shows.
    expect(status.redirectUri).toBe('https://relay.unit.test/cb');
  });

  it('refuses a missing secret when the flow needs one, but not for a PKCE flow', async () => {
    const refusal = await saveOAuthClientRegistration('unit-solo', { clientId: 'unit-client' }, { requireSecret: true }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(OAuthClientRegistrationError);
    expect((refusal as OAuthClientRegistrationError).code).toBe('client-secret-required');
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' });

    const pkce = await saveOAuthClientRegistration('unit-pkce', { clientId: 'public-client' }, { requireSecret: false });
    expect(pkce).toMatchObject({ configured: true, hasClientSecret: false });
  });

  it('refuses a malformed value by name without echoing it, and writes nothing', async () => {
    for (const [input, code] of [
      [{ clientId: '', clientSecret: SECRET }, 'invalid-client-id'],
      [{ clientId: 'has space', clientSecret: SECRET }, 'invalid-client-id'],
      [{ clientId: 'unit-client', clientSecret: 'bad secret value' }, 'invalid-client-secret'],
      [{ clientId: 'unit-client', clientSecret: 42 }, 'invalid-client-secret'],
      [{ clientId: 'x'.repeat(513), clientSecret: SECRET }, 'invalid-client-id'],
    ] as const) {
      const error = (await saveOAuthClientRegistration('unit-solo', input, { requireSecret: true }).catch((e: unknown) => e)) as OAuthClientRegistrationError;
      expect(error.code).toBe(code);
      expect(error.message).not.toContain('bad secret value');
      expect(error.message).not.toContain('has space');
    }
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites a registrations file it cannot parse', async () => {
    await fs.writeFile(file(), '{ not json');
    const error = (await saveOAuthClientRegistration('unit-solo', { clientId: 'c', clientSecret: SECRET }, { requireSecret: true }).catch((e: unknown) => e)) as OAuthClientRegistrationError;
    expect(error.code).toBe('registrations-unreadable');
    expect(await fs.readFile(file(), 'utf8')).toBe('{ not json');
  });

  it('serializes concurrent saves so neither entry is lost', async () => {
    await Promise.all([
      saveOAuthClientRegistration('unit-one', { clientId: 'one', clientSecret: SECRET }, { requireSecret: true }),
      saveOAuthClientRegistration('unit-two', { clientId: 'two', clientSecret: OTHER_SECRET }, { requireSecret: true }),
    ]);
    const saved = await readFile();
    expect(saved['unit-one']?.clientId).toBe('one');
    expect(saved['unit-two']?.clientId).toBe('two');
  });
});

describe('the connect flow reads what the page saved (SPEC-R-2-P-009)', () => {
  it('resolveOAuthProvider builds the provider from the saved registration under the derived key', async () => {
    const lead = descriptor('unit-a-chat', { credentialGroup: 'unit-a', clientRegistrationRef: 'byo-a' });
    const member = descriptor('unit-b-tickets', { credentialGroup: 'unit-a' });
    for (const d of [lead, member]) {
      await providerRegistry().register({ descriptor: d, adapter: adapter(d), pluginName: PLUGIN_NAME });
    }
    expect(await resolveOAuthProvider('provider:unit-a')).toBeNull();

    const registered = providerRegistry().list().map((entry) => entry.descriptor);
    const ref = clientRegistrationRefOf(member, registered)!;
    await saveOAuthClientRegistration(ref, { clientId: 'page-client', clientSecret: SECRET }, { requireSecret: true });

    expect(await readOAuthClientRegistration('byo-a')).toMatchObject({ clientId: 'page-client' });
    const provider = await resolveOAuthProvider('provider:unit-a');
    expect(provider?.config).toMatchObject({ clientId: 'page-client', clientSecret: SECRET, redirectUri: `${OPERATOR_BASE}/api/oauth/callback` });
  });
});
