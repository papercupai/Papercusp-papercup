import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { ProviderDescriptor, ProviderOAuthDescriptor, ProviderOAuthIdentity } from '@papercusp/plugin-sdk';
import { validateManifest } from './manifest-validate';

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const r = validateManifest({ name: 'mytool', version: '0.1.0' });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rejects unknown top-level fields', () => {
    const r = validateManifest({ name: 'mytool', version: '0.1.0', wibble: true });
    expect(r.ok).toBe(false);
    const msg = r.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/unknown property "wibble"/);
  });

  it('rejects an invalid plugin id', () => {
    const r = validateManifest({ name: 'My-TOOL', version: '0.1.0' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/name')).toBe(true);
  });

  it('rejects an id that is too short', () => {
    const r = validateManifest({ name: 'ab', version: '0.1.0' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/name')).toBe(true);
  });

  it('accepts scoped ids', () => {
    const r = validateManifest({ name: '@papercupai/cloudflare-pages', version: '0.1.0' });
    expect(r.ok).toBe(true);
  });

  it('rejects bad semver', () => {
    const r = validateManifest({ name: 'mytool', version: 'not-a-version' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/version')).toBe(true);
  });

  it('accepts known optional fields', () => {
    const r = validateManifest({
      name: 'mytool',
      version: '0.1.0',
      description: 'hi',
      papercusp: '^0.1.0',
      protocol: '^1.0',
      capabilities: ['http:fetch:example.com'],
      kind: 'plugin',
    });
    expect(r.ok).toBe(true);
  });
});

describe('$schema meta-keyword', () => {
  it('allows $schema field for editor LSP autocomplete', () => {
    const r = validateManifest({
      $schema: 'https://papercupai.com/papercusp-plugin.schema.json',
      name: '@test/with-schema',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });
});

describe('plugin dependency + config fields', () => {
  it('accepts requires + recommends arrays', () => {
    const r = validateManifest({
      name: '@test/with-deps',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      requires: ['@papercupai/cloudflare-pages'],
      recommends: ['@papercupai/github-repo'],
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts defaultConfig object', () => {
    const r = validateManifest({
      name: '@test/with-default-config',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      defaultConfig: { apiKey: 'placeholder', retries: 3 },
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects requires as non-array', () => {
    const r = validateManifest({
      name: '@test/bad-requires',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      requires: 'not-an-array',
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(false);
  });
});

describe('triggerPack manifest shape (external-triggers P-012)', () => {
  const triggerPack = {
    inputs: { type: 'object', properties: {} },
    defaultStormPolicy: { maxRuns: 5, windowSeconds: 60 },
    targets: [{
      id: 'draft-reply',
      kind: 'plan',
      path: 'plan.md',
      inputSchema: { type: 'object', properties: { trigger: { type: 'object' } } },
    }],
    bindings: [{
      id: 'gmail-to-draft',
      source: { kind: 'external', sourceKind: 'gmail', oauthField: 'googleWorkspace' },
      target: 'draft-reply',
      eventPattern: 'ext:gmail:message.received',
      filter: { direction: 'inbound' },
      mapping: { mode: 'payload-context' },
    }],
    edges: [],
  };

  it('accepts the strict pure-data declaration', () => {
    expect(validateManifest({
      name: '@test/email-draft-responder',
      version: '0.1.0',
      kind: 'plugin',
      triggerPack,
    }).ok).toBe(true);
  });

  it('refuses an inline armed bit — install and arm stay separate', () => {
    const r = validateManifest({
      name: '@test/email-draft-responder',
      version: '0.1.0',
      kind: 'plugin',
      triggerPack: {
        ...triggerPack,
        bindings: [{ ...triggerPack.bindings[0], armed: true }],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.map((issue) => issue.message).join(' ')).toMatch(/unknown property "armed"/);
  });

  it('refuses unknown nested fields and invalid storm limits', () => {
    const r = validateManifest({
      name: '@test/email-draft-responder',
      version: '0.1.0',
      triggerPack: {
        ...triggerPack,
        bindings: [{
          ...triggerPack.bindings[0],
          source: { ...triggerPack.bindings[0].source, token: 'leak' },
          stormPolicy: { maxRuns: 0 },
        }],
      },
    });
    expect(r.ok).toBe(false);
  });

  it('requires recipe args declarations and an explicit dead-letter retry disposition', () => {
    const recipeTarget = {
      id: 'record-draft',
      kind: 'recipe',
      ref: 'recipes:record-draft',
    };
    const recipeBinding = {
      id: 'record-draft-binding',
      source: { kind: 'manual' },
      target: 'record-draft',
      mapping: { mode: 'type-match' },
      retry: { maxAttempts: 2 },
    };
    const r = validateManifest({
      name: '@test/recipe-pack',
      version: '0.1.0',
      kind: 'plugin',
      triggerPack: {
        inputs: { type: 'object', properties: {} },
        targets: [recipeTarget],
        bindings: [recipeBinding],
        edges: [],
      },
    });

    expect(r.ok).toBe(false);
    expect(r.issues.map((issue) => issue.message).join(' ')).toMatch(
      /required property 'argsSchema'.*required property 'onExhausted'/,
    );
  });
});

describe('provides.events + dependencies.events (events-as-a-dependency axis, D-003/P-005)', () => {
  const base = { name: '@test/events', version: '0.1.0', kind: 'plugin', papercusp: '^1.0', capabilities: [] as string[] };

  it('accepts a provides.events family declaration', () => {
    const r = validateManifest({
      ...base,
      provides: {
        events: [
          {
            family: 'widget-done',
            keyTemplate: 'widget:done:<id>',
            params: [{ name: 'id', required: true, describe: 'the widget id' }],
            describe: 'A widget finished.',
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a no-param (literal-key) provided family', () => {
    const r = validateManifest({
      ...base,
      provides: { events: [{ family: 'heartbeat', keyTemplate: 'widget:heartbeat' }] },
    });
    expect(r.ok).toBe(true);
  });

  it('accepts dependencies.events with an optional flag', () => {
    const r = validateManifest({
      ...base,
      dependencies: { events: [{ family: 'widget-done' }, { family: 'other', optional: true }] },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a provided event missing keyTemplate', () => {
    const r = validateManifest({ ...base, provides: { events: [{ family: 'x' }] } });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown subfield on a provided event (additionalProperties:false)', () => {
    const r = validateManifest({
      ...base,
      provides: { events: [{ family: 'x', keyTemplate: 'a:b', wat: 1 }] },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown key under provides (additionalProperties:false)', () => {
    const r = validateManifest({ ...base, provides: { tools: ['x'] } });
    expect(r.ok).toBe(false);
  });

  it('rejects a dependencies.events entry missing family', () => {
    const r = validateManifest({ ...base, dependencies: { events: [{ optional: true }] } });
    expect(r.ok).toBe(false);
  });
});

/**
 * The manifest JSON schema must accept every field of the SDK's provider descriptor type. The
 * fixture is typed `Required<…>` at every level, so adding a field to ProviderDescriptor,
 * ProviderOAuthDescriptor or ProviderOAuthIdentity fails the typecheck here until the fixture
 * carries it, and then this test fails until the schema accepts it. (Regression: P-003 added
 * `oauth.identity` to the type but not the schema, so a real package declaring it was refused
 * at load — found by the P-010 GitHub issues provider.)
 */
describe('validateManifest: provider descriptor schema matches the SDK type', () => {
  const identity: Required<ProviderOAuthIdentity> = {
    url: 'https://api.example.com/user',
    idField: 'id',
    displayNameField: 'login',
    method: 'POST',
    body: '{"query":"{ viewer { id } }"}',
  };
  const oauth: Required<ProviderOAuthDescriptor> = {
    authorizeUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    scopes: ['read'],
    scopeSeparator: ',',
    pkce: true,
    clientRegistrationRef: 'example',
    credentialGroup: 'example-suite',
    identity,
  };
  const provider: Required<ProviderDescriptor> = {
    id: 'example-provider',
    contractVersion: 1,
    displayName: 'Example',
    datatypes: ['ticket'],
    capabilities: ['ticket.read', 'push.subscribe', 'push.unsubscribe', 'ingress.normalize'],
    oauth,
    egressHosts: ['api.example.com', 'example.com', 'pubsub.example.com'],
    configSchema: { type: 'object' },
    defaultDestinations: { ticket: ['record'] },
    membership: { identityProvider: 'example' },
    serviceCredentials: [{ ref: 'example-service', hosts: ['pubsub.example.com'] }],
    push: {
      handshake: { header: 'x-hook-secret' },
      signature: { header: 'x-hook-signature', algorithm: 'hmac-sha256', encoding: 'hex' },
    },
    setup: {
      credentials: [
        { key: 'app_token', label: 'App token', pattern: 'xapp-[A-Za-z0-9-]+', help: 'Basic Information', helpUrl: 'https://example.com/help', placeholder: 'xapp-…' },
        { key: 'bot_token', label: 'Bot token', hosts: ['api.example.com'] },
      ],
      appRegistration: {
        createUrl: 'https://example.com/apps?manifest_json={definition}',
        definition: { settings: { socket_mode_enabled: true } },
        docsUrl: 'https://example.com/docs',
        copyHint: 'From a manifest',
      },
    },
    ingress: {
      socket: {
        credential: 'app_token',
        open: { url: 'https://api.example.com/apps.connections.open', method: 'POST', urlField: 'url' },
        ackField: 'envelope_id',
        reconnect: { field: 'type', values: ['disconnect'] },
      },
    },
  };
  const manifest = (p: unknown) => ({ name: 'example-provider', version: '0.1.0', papercusp: '^0.1.0', provider: p });

  it('accepts a descriptor carrying every declared field', () => {
    const r = validateManifest(manifest(provider));
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('refuses a missing, malformed or extra membership declaration field', () => {
    for (const membership of [{}, { identityProvider: '' }, { identityProvider: 'Git Hub' },
      { identityProvider: 'example', members: [] }, 'example']) {
      expect(validateManifest(manifest({ ...provider, membership })).ok).toBe(false);
    }
  });

  it('still refuses an unknown oauth or identity property', () => {
    expect(validateManifest(manifest({ ...provider, oauth: { ...oauth, clientSecret: 'x' } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, oauth: { ...oauth, identity: { ...identity, token: 'x' } } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, oauth: { ...oauth, identity: { url: identity.url } } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, oauth: { ...oauth, identity: { ...identity, method: 'PUT' } } })).ok).toBe(false);
  });

  it('refuses a default destination outside record/event/document, an empty list or a repeat', () => {
    expect(validateManifest(manifest({ ...provider, defaultDestinations: { ticket: ['inbox'] } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, defaultDestinations: { ticket: [] } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, defaultDestinations: { ticket: ['record', 'record'] } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, defaultDestinations: ['ticket'] })).ok).toBe(false);
  });

  it('still refuses a malformed service credential', () => {
    expect(validateManifest(manifest({ ...provider, serviceCredentials: [{ ref: 'example-service' }] })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, serviceCredentials: [{ ref: 'x', hosts: ['pubsub.example.com'], secret: 'y' }] })).ok).toBe(false);
  });

  it('refuses a push scheme with an unknown key, an unsupported algorithm or a non-lowercase header', () => {
    // Schema shape only. The capability rule (a handshake needs push.subscribe/unsubscribe) is
    // semantic: validateProviderDescriptor, covered in plugin-sdk/src/provider.test.ts.
    const signature = provider.push.signature;
    expect(validateManifest(manifest({ ...provider, push: { signature, secret: 'x' } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, push: { signature: { ...signature, algorithm: 'sha1' } } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, push: { signature: { ...signature, header: 'X-Hook-Signature' } } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, push: { handshake: { header: 'x-hook-secret' } } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, push: { signature } })).issues).toEqual([]);
  });

  it('refuses a socket ingress with an unknown kind or key, a carried token, a non-https open URL or an empty reconnect list (P-003)', () => {
    // Schema shape only; credential-key, egress and capability rules are semantic
    // (validateProviderDescriptor, plugin-sdk/src/provider.test.ts).
    const socket = provider.ingress.socket;
    expect(validateManifest(manifest({ ...provider, ingress: { socket, webhook: {} } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, ingress: { socket: { ...socket, token: 'xapp-1' } } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, ingress: { socket: { ...socket, open: { ...socket.open, url: 'http://api.example.com/x' } } } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, ingress: { socket: { ...socket, reconnect: { field: 'type', values: [] } } } })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, ingress: {} })).ok).toBe(false);
    expect(validateManifest(manifest({ ...provider, ingress: { socket: { credential: 'app_token', open: { url: 'https://api.example.com/open', urlField: 'url' } } } })).issues).toEqual([]);
  });
});

/**
 * Runtime guard over the REAL first-party plugins (WI-10006546). The `Required<…>` fixture above
 * only fails under a typecheck, and vitest never typechecks, so a field added to the SDK type and
 * used by a bundled manifest shipped while every test stayed green: the Gmail plugin declared
 * provider.serviceCredentials, the schema refused it, and the plugin failed to load in every
 * process. Validating each bundled manifest here fails at TEST time instead.
 */
describe('validateManifest: every bundled first-party plugin manifest validates', () => {
  const pluginsDir = process.env.PAPERCUSP_BUNDLED_PLUGINS_DIR
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/plugins');
  const manifests = existsSync(pluginsDir)
    ? readdirSync(pluginsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(pluginsDir, entry.name, 'papercusp.json'))
        .filter((path) => existsSync(path))
    : [];

  it('finds the bundled plugins, including the provider plugins', () => {
    expect(manifests.length).toBeGreaterThan(10);
    const providers = manifests.filter((path) => 'provider' in JSON.parse(readFileSync(path, 'utf8')));
    expect(providers.map((path) => basename(dirname(path)))).toEqual(expect.arrayContaining(['gmail', 'google-calendar']));
  });

  it.each(manifests.map((path) => [basename(dirname(path)), path] as const))('%s', (_name, path) => {
    const result = validateManifest(JSON.parse(readFileSync(path, 'utf8')));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
