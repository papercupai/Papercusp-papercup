/**
 * Pins the "How OAuth providers resolve a client today" section of the design note
 * agent-insights/hosted-one-click-oauth-client-design-note (plan
 * cupboard-distributable-integrations-2026-10-10, P-013 / D-008) to the code it describes.
 *
 * The note's hosted-client proposal rests on these claims, so each one is driven through the real
 * provider registry and the real `resolveOAuthProvider` against a host-held `oauth-apps.json`
 * written under a temporary PAPERCUSP_HOME:
 *  - a package can never carry a client secret: the registry refuses a `/secret/i` key in `provider.oauth`;
 *  - the client comes from `oauth-apps.json` under `clientRegistrationRef`, defaulting to the group id;
 *  - `clientSecret` or `clientSecretFile` supplies the secret;
 *  - scopes are the union of every member of the credential group;
 *  - the redirect defaults to the operator's provider-neutral `/api/oauth/callback`.
 * The last block checks the note still states each claim, so text and code move together.
 */
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderDescriptor, ProviderOAuthDescriptor } from '@papercusp/plugin-sdk';

// Provider discovery is the plugin host's job; this suite registers its descriptors directly.
vi.mock('../plugin-host-runtime', () => ({ whenProvidersRegistered: async () => undefined }));

import { providerRegistry } from './provider-registry';
import { resolveOAuthProvider } from './connection-lifecycle';

const PLUGIN_NAME = 'oauth-client-registration-suite';
const OPERATOR_BASE = 'https://operator.suite.test';
const NOTE_PATH = new URL(
  '../../../../apps/operator-docs/src/content/docs/agent-insights/hosted-one-click-oauth-client-design-note.mdx',
  import.meta.url,
);

let home: string;

function descriptor(id: string, group: string, scopes: string[], oauth: Partial<ProviderOAuthDescriptor> = {}): ProviderDescriptor {
  return {
    id,
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: ['chat.read'],
    egressHosts: ['*.suite-oauth.test'],
    oauth: {
      authorizeUrl: 'https://auth.suite-oauth.test/authorize',
      tokenUrl: 'https://auth.suite-oauth.test/token',
      scopes,
      credentialGroup: group,
      ...oauth,
    },
  };
}

function adapter(d: ProviderDescriptor): ProviderAdapter {
  return {
    describe: () => d,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async () => ({ ok: true }),
  };
}

async function register(...descriptors: ProviderDescriptor[]): Promise<void> {
  for (const d of descriptors) {
    await providerRegistry().register({ descriptor: d, adapter: adapter(d), pluginName: PLUGIN_NAME });
  }
}

async function writeRegistrations(entries: Record<string, unknown>): Promise<void> {
  await fs.writeFile(join(home, 'oauth-apps.json'), JSON.stringify(entries));
}

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'paperhome-oauth-client-registration-'));
  vi.stubEnv('PAPERCUSP_HOME', home);
  vi.stubEnv('PAPERCUSP_OPERATOR_BASE', OPERATOR_BASE);
  providerRegistry().unregisterPlugin(PLUGIN_NAME);
});

afterEach(async () => {
  providerRegistry().unregisterPlugin(PLUGIN_NAME);
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe('a provider package cannot carry a client secret', () => {
  it.each(['clientSecret', 'client_secret', 'secretFile'])('the registry refuses provider.oauth.%s', async (key) => {
    const leaky = descriptor('suite-leaky', 'suite-leaky', ['chat.read'], { [key]: 'pasted-secret' } as Partial<ProviderOAuthDescriptor>);
    await expect(register(leaky)).rejects.toThrow(`provider.oauth.${key} must not carry a secret; use clientRegistrationRef`);
    expect(providerRegistry().list().some((entry) => entry.descriptor.id === 'suite-leaky')).toBe(false);
  });

  it('accepts clientRegistrationRef, the only way a package names its client', async () => {
    await expect(register(descriptor('suite-ref-ok', 'suite-ref-ok', ['chat.read'], { clientRegistrationRef: 'byo-app' }))).resolves.toBeUndefined();
  });
});

describe('resolveOAuthProvider reads the host-held registration', () => {
  it('uses the registration named by clientRegistrationRef, not the group id', async () => {
    await register(descriptor('suite-a-chat', 'suite-a', ['chat.read'], { clientRegistrationRef: 'hosted-like-ref' }));
    await writeRegistrations({
      'suite-a': { clientId: 'group-client', clientSecret: 'group-secret' },
      'hosted-like-ref': { clientId: 'ref-client', clientSecret: 'ref-secret', redirectUri: 'https://relay.suite.test/cb' },
    });

    const provider = await resolveOAuthProvider('provider:suite-a');

    expect(provider?.config).toMatchObject({ clientId: 'ref-client', clientSecret: 'ref-secret', redirectUri: 'https://relay.suite.test/cb' });
    const authorize = new URL(provider!.buildAuthorizeUrl(['chat.read'], 'state-1', {}));
    expect(authorize.searchParams.get('client_id')).toBe('ref-client');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://relay.suite.test/cb');
  });

  it('defaults the registration to the group id and the redirect to the operator callback', async () => {
    await register(descriptor('suite-b-chat', 'suite-b', ['chat.read']));
    await writeRegistrations({ 'suite-b': { clientId: 'group-client', clientSecret: 'group-secret' } });

    const provider = await resolveOAuthProvider('provider:suite-b');

    expect(provider?.config).toMatchObject({
      clientId: 'group-client',
      clientSecret: 'group-secret',
      redirectUri: `${OPERATOR_BASE}/api/oauth/callback`,
    });
  });

  it('reads the secret from clientSecretFile when the registration holds no inline secret', async () => {
    const secretFile = join(home, 'suite-c.secret');
    await fs.writeFile(secretFile, 'file-secret\n');
    await register(descriptor('suite-c-chat', 'suite-c', ['chat.read']));
    await writeRegistrations({ 'suite-c': { clientId: 'file-client', clientSecretFile: secretFile } });

    const provider = await resolveOAuthProvider('provider:suite-c');

    expect(provider?.config).toMatchObject({ clientId: 'file-client', clientSecret: 'file-secret' });
  });

  it('requests the union of every group member scope', async () => {
    await register(
      descriptor('suite-d-chat', 'suite-d', ['chat.read', 'users.read']),
      descriptor('suite-d-files', 'suite-d', ['files.read', 'users.read']),
    );
    await writeRegistrations({ 'suite-d': { clientId: 'union-client' } });

    const provider = await resolveOAuthProvider('provider:suite-d');

    expect([...(provider?.defaultScopes ?? [])].sort()).toEqual(['chat.read', 'files.read', 'users.read']);
  });

  it('returns no provider when the host holds no registration for the ref', async () => {
    await register(descriptor('suite-e-chat', 'suite-e', ['chat.read'], { clientRegistrationRef: 'not-registered' }));
    await writeRegistrations({ 'suite-e': { clientId: 'group-client' } });

    await expect(resolveOAuthProvider('provider:suite-e')).resolves.toBeNull();
  });
});

describe('the design note states the claims this suite checks', () => {
  const note = readFileSync(NOTE_PATH, 'utf8');
  const section = note.slice(note.indexOf('## How OAuth providers resolve a client today'), note.indexOf('## Proposal'));

  it.each([
    '`clientRegistrationRef`',
    '`/secret/i`',
    '`resolveOAuthProvider`',
    '`packages/operator-core/lib/integrations/connection-lifecycle.ts`',
    '`packages/plugin-sdk/src/provider.ts`',
    'default: the provider group id',
    '`oauth-apps.json`',
    '`clientSecretFile`',
    'unions the scopes of every member of the group',
    '`/api/oauth/callback`',
  ])('names %s', (claim) => {
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain(claim);
  });

  it('cites source files that exist', () => {
    for (const path of ['packages/operator-core/lib/integrations/connection-lifecycle.ts', 'packages/plugin-sdk/src/provider.ts']) {
      expect(() => readFileSync(new URL(`../../../../${path}`, import.meta.url))).not.toThrow();
    }
  });
});
