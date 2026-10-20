import { describe, expect, it } from 'vitest';
import {
  normalizeProviderOptions,
  normalizeProviderInstanceOrigin,
  bindProviderInstance,
  providerSourceEgressAllows,
  providerCoverageIssues,
  providerSyncProgressIssues,
  providerCursorFreshness,
  PROVIDER_OPTIONS_MAX,
  providerOptionSourceOf,
  PROVIDER_APP_DEFINITION_MAX_LENGTH,
  PROVIDER_APP_DEFINITION_PLACEHOLDER,
  PROVIDER_CREDENTIAL_AUTH_SCHEMES,
  PROVIDER_CREDENTIAL_MAX_LENGTH,
  PROVIDER_INGRESS_NORMALIZE_CAPABILITY,
  providerCredentialHeaderValue,
  providerAppDefinitionText,
  providerAppRegistrationUrl,
  providerCredentialForHost,
  providerCredentialValueIssue,
  providerLiveSearchResultIssue,
  providerPrincipalCredentialForHost,
  PROVIDER_ACL_REF_PATTERN,
  PROVIDER_SEARCH_LIVE_CAPABILITY,
  validateProviderDescriptor,
  providerCapabilityVerificationIssue,
  type ProviderDescriptor,
} from './provider';

describe('host-owned credential authentication headers', () => {
  const base = { id: 'blog-fixture', contractVersion: 1, datatypes: ['blog-post'], capabilities: ['blog.post'], egressHosts: ['blog.test'] };
  const field = { key: 'api_key', label: 'API key', hosts: ['blog.test'] };
  const validate = (auth: unknown, overrides = {}) => validateProviderDescriptor({ ...base,
    setup: { credentials: [{ ...field, auth, ...overrides }] } });
  it('accepts raw, Bot and Bearer authentication values as well as the existing Bearer default', () => {
    for (const header of ['api-key', 'authorization', 'x-api-key']) {
      for (const scheme of PROVIDER_CREDENTIAL_AUTH_SCHEMES) expect(validate({ header, scheme })).toEqual([]);
    }
    expect(validateProviderDescriptor({ ...base, setup: { credentials: [field] } })).toEqual([]);
  });
  it('writes each scheme as its header value', () => {
    expect(PROVIDER_CREDENTIAL_AUTH_SCHEMES).toEqual(['bearer', 'raw', 'bot']);
    expect(providerCredentialHeaderValue('bearer', 'k')).toBe('Bearer k');
    expect(providerCredentialHeaderValue('raw', 'k')).toBe('k');
    expect(providerCredentialHeaderValue('bot', 'k')).toBe('Bot k');
  });
  it.each([null, [], 'raw', {}, { header: 'cookie', scheme: 'raw' }, { header: 'host', scheme: 'raw' },
    { header: 'authorization\r\ninjected', scheme: 'raw' }, { header: 'api-key', scheme: 'Basic' },
    { header: 'api-key', scheme: 'raw', value: 'secret' }])('refuses unsafe auth declarations %j', (auth) => {
    expect(validate(auth).length).toBeGreaterThan(0);
  });
  it('requires a declared host for non-default authentication', () => {
    expect(validate({ header: 'api-key', scheme: 'raw' }, { hosts: undefined })).toContain('provider.setup.credentials[0].auth requires hosts');
  });
});

describe('provider rate budget declarations', () => {
  const base: ProviderDescriptor = { id: 'neutral-provider', contractVersion: 1, datatypes: ['social-post'], capabilities: ['social.reply'], egressHosts: ['example.test'] };
  const budget = () => ({ verifiedAt: '2026-08-23', sources: ['https://example.test/limits'], requestsPerMinute: 60,
    buckets: { shared: { appliesTo: 'list and reply', perDay: 10000, unit: 'units', verbs: ['read', 'reply'] } },
    dynamicQuota: { formula: '4800 * engaged members', driver: 'engaged members', assumedDailyFloor: 4800, retryExtendsBlock: true } });
  const validate = (rateBudget: unknown) => validateProviderDescriptor({ ...base, rateBudget });
  it('accepts separately dated evidence and non-fungible budgets without a usage header', () => {
    expect(validate(budget())).toEqual([]);
    expect(validateProviderDescriptor(base)).toEqual([]);
  });
  it.each([0, -1, NaN, Infinity, '60'])('refuses invalid numeric allowance %s', (requestsPerMinute) => {
    expect(validate({ ...budget(), requestsPerMinute })).toContain('provider.rateBudget.requestsPerMinute must be a finite positive number');
  });
  it.each([
    { verifiedAt: '2026-02-30' }, { verifiedAt: '2026-08-23', sources: [] }, { sources: ['http://example.test/limits'] },
    { buckets: {} }, { buckets: { one: { appliesTo: 'write', perDay: 0, unit: 'calls' } } },
    { buckets: { one: { appliesTo: 'write', perDay: 1, unit: 'unknown' } } },
    { buckets: { one: { appliesTo: 'write', perDay: 1, unit: 'calls', verbs: ['post', 'post'] } } },
    { dynamicQuota: { formula: 'x', driver: 'members', assumedDailyFloor: 0 } },
    { dynamicQuota: { formula: 'x', driver: 'members', assumedDailyFloor: 1, retryExtendsBlock: 'true' } },
    { budgetHeaders: ['X-Usage\r\nInjected'] }, { unrecognizedAllowance: 1000 },
  ])('refuses malformed or unaccountable quota metadata %j', (mutation) => {
    expect(validate({ ...budget(), ...mutation }).length).toBeGreaterThan(0);
  });
});

describe('provider sync progress', () => {
  it('reads committed sync freshness without interpreting opaque provider cursors', () => {
    const now = Date.parse('2026-10-01T01:00:00Z');
    expect(providerCursorFreshness({ watermark: 'old' }, now)).toBeNull();
    expect(providerCursorFreshness({ provider: 'opaque-position' }, now)).toMatchObject({ state: 'position-only', at: null });
    expect(providerCursorFreshness({ provider: null }, now)).toMatchObject({ state: 'never-synced' });
    const lossRisk = { kind: 'retention-window-exceeded' as const, oldestReachableAt: '2026-10-01T00:00:00Z', detail: 'Remote events were discarded' };
    expect(providerCursorFreshness({ provider: null, providerSync: { lastSyncedAt: '2026-10-01T00:00:00Z', lossRisk } }, now))
      .toMatchObject({ state: 'synced', ageMs: 3_600_000, lossRisk });
    expect(providerCursorFreshness({ provider: 'unknown', providerSync: { lastSyncedAt: 'bad', lossRisk: {} } }, now))
      .toEqual({ state: 'position-only', at: null, ageMs: null, position: 'unknown', detail: 'provider cursor is present; its internal shape is opaque' });
  });

  it('accepts legacy pages and coherent catch-up and retention evidence', () => {
    expect(providerSyncProgressIssues({})).toEqual([]);
    expect(providerSyncProgressIssues({ catchUp: { path: 'cursor-replay' } })).toEqual([]);
    expect(providerSyncProgressIssues({
      catchUp: { path: 'backfill', reason: 'cursor-expired' },
      lossRisk: { kind: 'retention-window-exceeded', oldestReachableAt: '2026-10-01T00:00:00Z', detail: 'Older events are no longer available' },
    })).toEqual([]);
  });

  it('rejects ambiguous paths and unusable loss evidence', () => {
    expect(providerSyncProgressIssues({ catchUp: { path: 'backfill' } })).toContain('catchUp.reason must explain a backfill');
    expect(providerSyncProgressIssues({ catchUp: { path: 'live-only', reason: 'cursor-expired' } })).toContain('catchUp.reason is only valid for backfill');
    for (const lossRisk of [null, [], { kind: 'unknown' }, { kind: 'retention-window-exceeded', oldestReachableAt: 'yesterday', detail: '' }]) {
      expect(providerSyncProgressIssues({ lossRisk }).length).toBeGreaterThan(0);
    }
  });
});

/**
 * Value rules for a provider's OAuth identity endpoint (linear-asana-task-sync-2026-10-05 P-004).
 * Linear answers only GraphQL, so its identity request is a POST with a JSON body; a REST
 * provider (GitHub) keeps the default GET with no body.
 */
function descriptor(identity: Record<string, unknown>): ProviderDescriptor {
  return {
    id: 'example-tracker',
    contractVersion: 1,
    displayName: 'Example tracker',
    datatypes: ['ticket'],
    capabilities: ['ticket.read'],
    egressHosts: ['api.example.com', 'example.com'],
    oauth: {
      authorizeUrl: 'https://example.com/oauth/authorize?actor=app',
      tokenUrl: 'https://api.example.com/oauth/token',
      scopes: ['read'],
      identity: identity as unknown as NonNullable<ProviderDescriptor['oauth']>['identity'],
    },
  };
}

const GRAPHQL_BODY = JSON.stringify({ query: '{ organization { id name } }' });

describe('package-owned sync support', () => {
  it('accepts existing, readable and write-only providers', () => {
    const d = descriptor({ url: 'https://api.example.com/me', idField: 'id' });
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(validateProviderDescriptor({ ...d, sync: true })).toEqual([]);
    expect(validateProviderDescriptor({ ...d, sync: false })).toEqual([]);
  });

  it.each([null, 'false', 0, {}, []])('refuses malformed sync support %j', (sync) => {
    expect(validateProviderDescriptor({ ...descriptor({ url: 'https://api.example.com/me', idField: 'id' }), sync }))
      .toContain('provider.sync must be a boolean');
  });
});

describe('package-owned API contract evidence', () => {
  const verified = (): ProviderDescriptor => ({
    id: 'example-social', contractVersion: 1, datatypes: ['social-post'],
    capabilities: ['social.reply', 'social.delete'], egressHosts: ['api.example.com'],
    verification: { verifiedAt: '2026-10-16', sources: ['https://example.com/api'], capabilities: { 'social.reply': '2026-10-16', 'social.delete': null } },
  });

  it('keeps a declared but unverified write closed and does not invent another verb', () => {
    const d = verified();
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(providerCapabilityVerificationIssue(d, 'social.reply')).toBeNull();
    expect(providerCapabilityVerificationIssue(d, 'social.delete')).toBe('capability-unverified');
    expect(providerCapabilityVerificationIssue(d, 'social.post')).toBe('capability-unsupported');
    delete d.verification;
    expect(validateProviderDescriptor(d)).toEqual([]); // old descriptors remain installable
    expect(providerCapabilityVerificationIssue(d, 'social.reply')).toBe('unverified');
  });

  it('preserves an explicit contract wall even with dated write evidence', () => {
    const d = verified(); d.verification!.blockedOn = 'owner: API access authorization';
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(providerCapabilityVerificationIssue(d, 'social.reply')).toBe('owner-blocked');
    expect(providerCapabilityVerificationIssue(d)).toBe('owner-blocked');
  });

  it('verifies sync/read evidence independently from any write capability', () => {
    const d = verified(); d.capabilities = []; d.verification!.capabilities = {};
    expect(providerCapabilityVerificationIssue(d)).toBeNull();
    expect(providerCapabilityVerificationIssue(d, 'social.reply')).toBe('capability-unsupported');
    d.verification!.verifiedAt = null;
    expect(providerCapabilityVerificationIssue(d)).toBe('unverified');
  });

  it.each([
    { verifiedAt: '2026-02-30' }, { verifiedAt: undefined }, { sources: [] },
    { sources: ['http://example.com/api'] }, { sources: ['https://user:secret@example.com/api'] },
    { capabilities: { 'social.post': '2026-10-16' } }, { capabilities: { 'social.reply': 'tomorrow' } },
    { verifiedAt: null }, { blockedOn: ' ' }, { liveAccepted: true },
  ])('rejects malformed or undeclared attestation %j', (patch) => {
    const d = verified(); Object.assign(d.verification!, patch);
    expect(validateProviderDescriptor(d).some((issue) => issue.startsWith('provider.verification'))).toBe(true);
    expect(providerCapabilityVerificationIssue(d, 'social.reply')).not.toBeNull();
  });

  it('represents an explicitly unverified contract without authorizing any write', () => {
    const d = verified(); d.verification = { verifiedAt: null, sources: [], capabilities: { 'social.reply': null } };
    expect(validateProviderDescriptor(d)).toEqual([]);
    expect(providerCapabilityVerificationIssue(d, 'social.reply')).toBe('unverified');
  });
});

describe('host-held pasted credential session descriptors', () => {
  const sessionDescriptor: ProviderDescriptor = {
    id: 'session-example', contractVersion: 1, datatypes: ['social-post'], capabilities: ['social.post'],
    egressHosts: ['api.example.com'], setup: {
      credentials: [{ key: 'account', label: 'Account' }, { key: 'password', label: 'App password' }],
      session: { url: 'https://api.example.com/login', refreshUrl: 'https://api.example.com/refresh',
        parameters: { identifier: 'account', password: 'password' }, hosts: ['api.example.com'],
        accessTokenField: 'access', refreshTokenField: 'refresh', activeField: 'active', maxAgeSeconds: 3600,
        identity: { idField: 'id', displayNameField: 'name', credentialKey: 'account' } },
    },
  };
  it('admits pure-data login/refresh metadata without OAuth or a pasted bearer host', () => {
    expect(validateProviderDescriptor(sessionDescriptor)).toEqual([]);
    const noActive = structuredClone(sessionDescriptor); delete noActive.setup!.session!.activeField;
    expect(validateProviderDescriptor(noActive)).toEqual([]);
  });
  it.each([
    { url: 'https://foreign.example/login' }, { refreshUrl: 'https://other.example/refresh' },
    { url: 'https://api.example.com/login?password=literal' }, { hosts: ['*.example.com'] },
    { parameters: { password: 'undeclared' } }, { accessTokenField: '__proto__.token' },
    { activeField: 'constructor.active' }, { maxAgeSeconds: 59 }, { maxAgeSeconds: 86401 },
    { identity: { idField: 'access' } },
  ])('rejects invalid endpoint, credential mapping, lifetime or response path %j', (patch) => {
    const d = structuredClone(sessionDescriptor); Object.assign(d.setup!.session!, patch);
    expect(validateProviderDescriptor(d).length).toBeGreaterThan(0);
  });
  it('rejects per-person login parameters and competing bearer credentials on the session host', () => {
    const perPerson = structuredClone(sessionDescriptor); perPerson.setup!.credentials![1].perPrincipal = true;
    expect(validateProviderDescriptor(perPerson)).toContain('provider.setup.session.parameters must reference declared source credential keys');
    const overlap = structuredClone(sessionDescriptor); overlap.setup!.credentials![1].hosts = ['api.example.com'];
    expect(validateProviderDescriptor(overlap)).toContain('provider.setup.session.hosts cannot overlap another credential');
  });
});

describe('instance-scoped OAuth descriptors', () => {
  const instance: ProviderDescriptor = { ...descriptor({ url: '/api/v1/accounts/verify_credentials', idField: 'id' }), egressHosts: [],
    oauth: { instance: true, authorizeUrl: '/oauth/authorize', tokenUrl: '/oauth/token', scopes: ['read'],
      identity: { url: '/api/v1/accounts/verify_credentials', idField: 'id' } } };

  it('binds all relative endpoints to a saved public HTTPS origin without mutating the descriptor', () => {
    expect(validateProviderDescriptor(instance)).toEqual([]);
    const bound = bindProviderInstance(instance, 'https://social.example.com/');
    expect(validateProviderDescriptor(bound)).toEqual([]);
    expect(bound.egressHosts).toEqual(['social.example.com']);
    expect(bound.oauth).toMatchObject({ authorizeUrl: 'https://social.example.com/oauth/authorize', tokenUrl: 'https://social.example.com/oauth/token',
      identity: { url: 'https://social.example.com/api/v1/accounts/verify_credentials' } });
    expect(bound.oauth).not.toHaveProperty('instance');
    expect(instance.oauth!.authorizeUrl).toBe('/oauth/authorize');
  });

  it('refuses insecure, credential-bearing, IP, private-literal and non-origin registration values', () => {
    for (const value of ['http://social.example.com', 'https://name:secret@social.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://0x7f000001',
      'https://localhost', 'https://host.local', 'https://host.internal', 'https://social.example.com:8443', 'https://social.example.com/path',
      'https://social.example.com?next=elsewhere', 'https://social.example.com#part', ' https://social.example.com', 'https://social.example.com\\evil', null]) {
      expect(normalizeProviderInstanceOrigin(value), String(value)).toBeNull();
      expect(() => bindProviderInstance(instance, value)).toThrow('provider_instance_origin_invalid');
    }
  });

  it('binds instance app setup paths and refuses authority escapes or unscoped relative setup', () => {
    const scoped = { ...instance, setup: { appRegistration: { createUrl: '/settings/applications/new' } } };
    expect(validateProviderDescriptor(scoped)).toEqual([]);
    expect(bindProviderInstance(scoped, 'https://social.example.com').setup?.appRegistration?.createUrl).toBe('https://social.example.com/settings/applications/new');
    expect(scoped.setup.appRegistration.createUrl).toBe('/settings/applications/new');
    for (const createUrl of ['//evil.example.com/new', '/\\evil.example.com/new', '/new#part']) {
      const bad = { ...scoped, setup: { appRegistration: { createUrl } } };
      expect(validateProviderDescriptor(bad).some((issue) => issue.includes('createUrl'))).toBe(true);
      expect(() => bindProviderInstance(bad, 'https://social.example.com')).toThrow('provider_instance_endpoint_invalid');
    }
    expect(validateProviderDescriptor({ ...descriptor({ url: 'https://api.example.com/me', idField: 'id' }), setup: scoped.setup }).some((issue) => issue.includes('createUrl'))).toBe(true);
  });

  it('refuses static host budgets and endpoints that select another authority', () => {
    expect(validateProviderDescriptor({ ...instance, egressHosts: ['collector.example.com'] })).toContain('provider.egressHosts must be empty for an instance-scoped OAuth grant');
    for (const authorizeUrl of ['https://collector.example.com/oauth', '//collector.example.com/oauth', '/\\collector.example.com', '/oauth#fragment']) {
      const bad = { ...instance, oauth: { ...instance.oauth!, authorizeUrl } };
      expect(validateProviderDescriptor(bad).some((issue) => issue.includes('authorizeUrl'))).toBe(true);
      expect(() => bindProviderInstance(bad, 'https://social.example.com')).toThrow('provider_instance_endpoint_invalid');
    }
    expect(validateProviderDescriptor({ ...instance, oauth: { ...instance.oauth!, instance: false } })).toContain('provider.oauth.instance must be true when present');
  });

  it('permits only the persisted source origin, including its port, never a caller-selected or static host', () => {
    const config = { connectionOrigin: 'https://social.example.com' };
    expect(providerSourceEgressAllows(instance, new URL('https://social.example.com/api/v1/timelines/home'), config)).toBe(true);
    for (const value of ['https://other.example.com/api', 'https://social.example.com:8443/api', 'https://social.example.com.evil.com/api', 'http://social.example.com/api', 'https://user@social.example.com/api']) {
      expect(providerSourceEgressAllows(instance, new URL(value), config)).toBe(false);
    }
    expect(providerSourceEgressAllows(instance, new URL('https://social.example.com/api'))).toBe(false);
    expect(providerSourceEgressAllows(instance, new URL('https://social.example.com/api'), { connectionOrigin: 'https://127.0.0.1' })).toBe(false);
  });
});

/** A new source's starting destination policy (WI-10006213): keyed by declared datatypes only. */
describe('validateProviderDescriptor: defaultDestinations', () => {
  const base = { ...descriptor({ url: 'https://api.example.com/user', idField: 'id' }), datatypes: ['ticket', 'ticket-comment'] };

  it('accepts declared datatypes routed to record, event or document', () => {
    expect(validateProviderDescriptor({ ...base, defaultDestinations: { ticket: ['record'], 'ticket-comment': ['document'] } })).toEqual([]);
  });

  it('refuses a datatype the provider does not declare', () => {
    expect(validateProviderDescriptor({ ...base, defaultDestinations: { 'email-message': ['document'] } }))
      .toContain('provider.defaultDestinations key "email-message" is not one of provider.datatypes');
  });

  it('refuses an unknown destination, an empty list, a repeat and a non-map', () => {
    const issues = (defaults: unknown) =>
      validateProviderDescriptor({ ...base, defaultDestinations: defaults as ProviderDescriptor['defaultDestinations'] });
    expect(issues({ ticket: ['inbox'] })).toContain('provider.defaultDestinations.ticket entry "inbox" must be one of record, event, document');
    expect(issues({ ticket: [] })).toContain('provider.defaultDestinations.ticket must list at least one destination');
    expect(issues({ ticket: ['record', 'record'] })).toContain('provider.defaultDestinations.ticket repeats "record"');
    expect(issues(['ticket'])).toContain('provider.defaultDestinations must map datatypes to destination lists');
  });
});

describe('validateProviderDescriptor: membership', () => {
  const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });

  it('accepts a membership feed that names its identity namespace', () => {
    expect(validateProviderDescriptor({ ...base, membership: { identityProvider: 'github' } })).toEqual([]);
  });

  it('refuses a missing, empty or malformed identity namespace', () => {
    const refusal = `provider.membership.identityProvider must match /^[a-z][a-z0-9-]{1,62}$/`;
    for (const membership of [{}, { identityProvider: '' }, { identityProvider: 'Git Hub' }, 'github', ['github']]) {
      expect(validateProviderDescriptor({ ...base, membership } as unknown as ProviderDescriptor)).toEqual([refusal]);
    }
  });

  // A source made of containers with their own members (cupboard-distributable-integrations-2026-10-10 D-026).
  it('accepts a containers flag and refuses one that is not a boolean', () => {
    expect(validateProviderDescriptor({ ...base, membership: { identityProvider: 'slack', containers: true } })).toEqual([]);
    expect(validateProviderDescriptor({ ...base, membership: { identityProvider: 'slack', containers: false } })).toEqual([]);
    expect(
      validateProviderDescriptor({ ...base, membership: { identityProvider: 'slack', containers: 'yes' } } as unknown as ProviderDescriptor),
    ).toEqual(['provider.membership.containers must be true or false']);
  });

  it('container refs are printable, without spaces, and at most 200 characters', () => {
    for (const ref of ['T01:C02', 'drive/folder-1', '#general', 'team@example.com']) expect(PROVIDER_ACL_REF_PATTERN.test(ref)).toBe(true);
    for (const ref of ['', 'two words', 'line\nbreak', 'x'.repeat(201)]) expect(PROVIDER_ACL_REF_PATTERN.test(ref)).toBe(false);
  });
});

describe('validateProviderDescriptor: oauth.clientIdParameter', () => {
  it('accepts only supported client-id form keys', () => {
    const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });
    for (const clientIdParameter of ['client_id', 'client_key'] as const) {
      expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, clientIdParameter } })).toEqual([]);
    }
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, clientIdParameter: 'redirect_uri' as 'client_key' } }))
      .toContain('provider.oauth.clientIdParameter must be client_id or client_key');
  });
});

describe('validateProviderDescriptor: oauth.userAgentRequired', () => {
  it('accepts an explicit requirement and rejects values that could silently disable it', () => {
    const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, userAgentRequired: true } })).toEqual([]);
    for (const value of [false, 'true', 1]) {
      expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, userAgentRequired: value as true } }))
        .toContain('provider.oauth.userAgentRequired must be true when present');
    }
  });
});

describe('validateProviderDescriptor: oauth.tokenEndpointAuthMethod', () => {
  it('accepts the two host-held client authentication methods and rejects unknown methods', () => {
    const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });
    for (const tokenEndpointAuthMethod of ['client_secret_post', 'client_secret_basic'] as const) {
      expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, tokenEndpointAuthMethod } })).toEqual([]);
    }
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, tokenEndpointAuthMethod: 'none' as 'client_secret_basic' } }))
      .toContain('provider.oauth.tokenEndpointAuthMethod must be client_secret_post or client_secret_basic');
  });
});

describe('validateProviderDescriptor: oauth.scopeSeparator', () => {
  it('accepts a space or a comma and refuses anything else', () => {
    const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, scopeSeparator: ',' } })).toEqual([]);
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, scopeSeparator: ' ' } })).toEqual([]);
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, scopeSeparator: ';' as unknown as ',' } }))
      .toContain('provider.oauth.scopeSeparator must be " " or ","');
  });
});

describe('validateProviderDescriptor: oauth.identity request', () => {
  it('accepts explicit reauthorization and rejects an expiry bypass', () => {
    const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });
    for (const refreshPolicy of ['refresh-token', 'reauthorize'] as const) {
      expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, refreshPolicy } })).toEqual([]);
    }
    expect(validateProviderDescriptor({ ...base, oauth: { ...base.oauth!, refreshPolicy: 'ignore-expiry' } } as unknown as ProviderDescriptor))
      .toContain('provider.oauth.refreshPolicy must be refresh-token or reauthorize');
  });

  it('accepts a GET identity endpoint with no method (the REST default)', () => {
    expect(validateProviderDescriptor(descriptor({ url: 'https://api.example.com/user', idField: 'id' }))).toEqual([]);
  });

  it('accepts a POST identity endpoint with a JSON body (a GraphQL API)', () => {
    expect(validateProviderDescriptor(descriptor({
      url: 'https://api.example.com/graphql', idField: 'data.organization.id', method: 'POST', body: GRAPHQL_BODY,
    }))).toEqual([]);
  });

  it('refuses an unknown method', () => {
    expect(validateProviderDescriptor(descriptor({ url: 'https://api.example.com/user', idField: 'id', method: 'PUT' })))
      .toContain('provider.oauth.identity.method must be GET or POST');
  });

  it('refuses a body without POST, and a body that is not JSON', () => {
    expect(validateProviderDescriptor(descriptor({ url: 'https://api.example.com/user', idField: 'id', body: GRAPHQL_BODY })))
      .toContain('provider.oauth.identity.body needs method POST');
    expect(validateProviderDescriptor(descriptor({
      url: 'https://api.example.com/graphql', idField: 'id', method: 'POST', body: '{ organization { id } }',
    }))).toContain('provider.oauth.identity.body must be a JSON string');
  });

  it('keeps the identity host inside the egress allow-list', () => {
    expect(validateProviderDescriptor(descriptor({
      url: 'https://elsewhere.test/graphql', idField: 'id', method: 'POST', body: GRAPHQL_BODY,
    }))).toContain('provider.oauth endpoint host "elsewhere.test" is not in provider.egressHosts');
  });
});

/** Push-wake scheme (linear-asana-task-sync-2026-10-05 D-016): pure data the host verifies. */
describe('validateProviderDescriptor: push', () => {
  const base = descriptor({ url: 'https://api.example.com/user', idField: 'id' });
  const signature = { header: 'x-hook-signature', algorithm: 'hmac-sha256', encoding: 'hex' } as const;
  const withPush = (push: unknown, capabilities = ['ticket.read', 'push.subscribe', 'push.unsubscribe']) =>
    validateProviderDescriptor({ ...base, capabilities, push } as ProviderDescriptor);

  it('accepts a handshake scheme with both push capabilities, and a signature-only scheme without them', () => {
    expect(withPush({ handshake: { header: 'x-hook-secret' }, signature })).toEqual([]);
    expect(withPush({ signature }, ['ticket.read'])).toEqual([]);
  });

  it('validates declared challenge credentials and normalization capability before registering push', () => {
    const verification = { modeParam: 'hub.mode', modeValue: 'subscribe', tokenParam: 'hub.verify_token', challengeParam: 'hub.challenge', credentialRef: 'verify_token' };
    const push = { signature: { ...signature, prefix: 'sha256=', oauthClientSecret: true }, verification, delivery: 'normalize' as const };
    expect(validateProviderDescriptor({ ...base, capabilities: ['ingress.normalize'], setup: { credentials: [{ key: 'verify_token', label: 'Verify token' }] }, push })).toEqual([]);
    expect(withPush(push)).toContain('provider.push.delivery normalize needs capability ingress.normalize');
    expect(withPush(push)).toContain('provider.push.verification.credentialRef must name a host-held setup credential');
    expect(withPush({ signature: { ...signature, prefix: 'sha256=\n' } })).toContain('provider.push.signature.prefix must be a short literal prefix');
    expect(withPush({ signature: { ...signature, oauthClientSecret: true }, handshake: { header: 'x-secret' } })).toContain('provider.push.signature.oauthClientSecret needs OAuth and cannot use a handshake');
  });

  it('a handshake needs push.subscribe and push.unsubscribe, since its secret only arrives during a subscribe', () => {
    expect(withPush({ handshake: { header: 'x-hook-secret' }, signature }, ['ticket.read', 'push.subscribe']))
      .toEqual(['provider.push.handshake needs capability push.unsubscribe']);
    expect(withPush({ handshake: { header: 'x-hook-secret' }, signature }, ['ticket.read'])).toHaveLength(2);
  });

  it('refuses a missing or malformed signature, a non-lowercase header, and a handshake sharing the signature header', () => {
    expect(withPush({})).toEqual([
      'provider.push.signature.header must be a lowercase header name',
      'provider.push.signature.algorithm must be hmac-sha256',
      'provider.push.signature.encoding must be hex',
    ]);
    expect(withPush({ signature: { ...signature, header: 'X-Hook-Signature' } }))
      .toContain('provider.push.signature.header must be a lowercase header name');
    expect(withPush({ signature: { ...signature, algorithm: 'sha1' } })).toContain('provider.push.signature.algorithm must be hmac-sha256');
    expect(withPush({ handshake: { header: 'x-hook-signature' }, signature }))
      .toContain('provider.push.handshake.header must differ from provider.push.signature.header');
    expect(withPush('push')).toEqual(['provider.push must be an object']);
  });
});

/**
 * Paste-a-secret setup fields (cupboard-distributable-integrations-2026-10-10 P-001,
 * SPEC-R-2-P-001 / SPEC-R-7-P-001). A descriptor describes a secret's shape; it never carries one,
 * and every injected host has exactly one credential.
 */
describe('validateProviderDescriptor: setup.credentials', () => {
  const base: ProviderDescriptor = {
    id: 'example-chat',
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: ['chat.send'],
    egressHosts: ['api.example.com', '*.hooks.example.com'],
  };
  const withCredentials = (credentials: unknown, extra: Partial<ProviderDescriptor> = {}) =>
    validateProviderDescriptor({ ...base, ...extra, setup: { credentials } } as unknown as ProviderDescriptor);
  const bot = { key: 'bot_token', label: 'Bot token', pattern: 'xoxb-[A-Za-z0-9-]+', hosts: ['api.example.com'] };

  it('accepts injected and ingress-only fields with help text', () => {
    expect(
      withCredentials([
        { ...bot, help: 'OAuth & Permissions → Bot User OAuth Token', helpUrl: 'https://api.example.com/apps', placeholder: 'xoxb-…' },
        { key: 'app-token', label: 'App-level token', pattern: 'xapp-[A-Za-z0-9-]+' },
      ]),
    ).toEqual([]);
    // A host covered by an egress wildcard can carry a credential.
    expect(withCredentials([{ ...bot, hosts: ['in.hooks.example.com'] }])).toEqual([]);
  });

  it('refuses a field that carries a value', () => {
    for (const forbidden of ['value', 'default', 'secret', 'token']) {
      expect(withCredentials([{ ...bot, [forbidden]: 'xoxb-1' }])).toContain(
        `provider.setup.credentials[0].${forbidden} is not allowed: a descriptor never carries a credential value`,
      );
    }
  });

  it('refuses bad keys, repeats, missing labels and broken patterns', () => {
    expect(withCredentials([{ ...bot, key: 'Bot Token' }])).toContain(
      `provider.setup.credentials[0].key must match ${/^[a-z][a-z0-9_-]{0,62}$/}`,
    );
    expect(withCredentials([bot, { ...bot, hosts: undefined }])).toContain('provider.setup.credentials repeats key "bot_token"');
    expect(withCredentials([{ ...bot, label: '' }])).toContain('provider.setup.credentials[0].label must be a non-empty string');
    expect(withCredentials([{ ...bot, pattern: 'xoxb-[' }])).toContain('provider.setup.credentials[0].pattern is not a valid regular expression');
    expect(withCredentials([{ ...bot, helpUrl: 'http://example.com' }])).toContain('provider.setup.credentials[0].helpUrl must be an https URL');
    expect(withCredentials([])).toEqual(['provider.setup.credentials must list at least one field']);
    expect(validateProviderDescriptor({ ...base, setup: 'creds' } as unknown as ProviderDescriptor)).toEqual(['provider.setup must be an object']);
  });

  it('refuses a host outside egressHosts, a wildcard host, and a host two credentials claim', () => {
    expect(withCredentials([{ ...bot, hosts: ['api.other.com'] }])).toContain(
      "provider.setup.credentials[0] host 'api.other.com' is not in provider.egressHosts",
    );
    expect(withCredentials([{ ...bot, hosts: ['*.hooks.example.com'] }])).toContain(
      "provider.setup.credentials[0].hosts entry '*.hooks.example.com' is not a hostname",
    );
    expect(withCredentials([bot, { ...bot, key: 'user_token' }])).toContain(
      "provider.setup.credentials[1] host 'api.example.com' is already given a credential by provider.setup.credentials[0]",
    );
    expect(withCredentials([bot], { serviceCredentials: [{ ref: 'pubsub', hosts: ['api.example.com'] }] })).toContain(
      "provider.setup.credentials[0] host 'api.example.com' is already given a credential by provider.serviceCredentials",
    );
  });

  // Each person's own credential (D-026): it only ever rides host.fetch calls made for that person.
  const user = { key: 'user_token', label: 'Your user token', pattern: 'xoxp-[A-Za-z0-9-]+', hosts: ['api.example.com'], perPrincipal: true };

  it('accepts a per-person credential for a host the source credential also covers', () => {
    expect(withCredentials([bot, user])).toEqual([]);
  });

  it('refuses a per-person credential without hosts, a non-boolean flag, and two per-person credentials for one host', () => {
    expect(withCredentials([{ ...user, hosts: undefined }])).toContain(
      'provider.setup.credentials[0].perPrincipal needs hosts: a per-person credential is only ever injected into host.fetch',
    );
    expect(withCredentials([{ ...bot, perPrincipal: 'yes' }])).toContain('provider.setup.credentials[0].perPrincipal must be true or false');
    expect(withCredentials([bot, user, { ...user, key: 'other_user_token' }])).toContain(
      "provider.setup.credentials[2] host 'api.example.com' is already given a credential by provider.setup.credentials[1]",
    );
  });
});

describe('providerCredentialValueIssue', () => {
  const field = { label: 'Bot token', pattern: 'xoxb-[A-Za-z0-9-]+' };

  it('accepts a whole-value match, trimming surrounding space', () => {
    expect(providerCredentialValueIssue(field, 'xoxb-123-abc')).toBeNull();
    expect(providerCredentialValueIssue(field, '  xoxb-123-abc\n')).toBeNull();
    expect(providerCredentialValueIssue({ label: 'Key' }, 'anything-goes')).toBeNull();
  });

  it('refuses a value that only partly matches, is empty, contains spaces, or is too long', () => {
    expect(providerCredentialValueIssue(field, 'xapp-123')).toBe('Bot token does not have the expected format');
    expect(providerCredentialValueIssue(field, 'prefix xoxb-123')).toBe('Bot token must not contain spaces or line breaks');
    expect(providerCredentialValueIssue(field, 'xoxb-123!')).toBe('Bot token does not have the expected format');
    expect(providerCredentialValueIssue(field, '   ')).toBe('Bot token is required');
    expect(providerCredentialValueIssue(field, undefined)).toBe('Bot token is required');
    expect(providerCredentialValueIssue(field, `xoxb-${'a'.repeat(PROVIDER_CREDENTIAL_MAX_LENGTH)}`)).toBe(
      `Bot token is longer than ${PROVIDER_CREDENTIAL_MAX_LENGTH} characters`,
    );
  });

  it('reports an invalid provider pattern instead of throwing', () => {
    expect(providerCredentialValueIssue({ label: 'Key', pattern: '(' }, 'x')).toBe("Key cannot be checked: the provider's format is invalid");
  });
});

describe('providerCredentialForHost', () => {
  const d = { setup: { credentials: [{ key: 'bot_token', label: 'Bot', hosts: ['slack.com'] }, { key: 'app_token', label: 'App' }] } };
  it('finds the credential injected for a host, case-insensitively, and none for an ingress-only field', () => {
    expect(providerCredentialForHost(d, 'Slack.com')?.key).toBe('bot_token');
    expect(providerCredentialForHost(d, 'api.slack.com')).toBeNull();
    expect(providerCredentialForHost({}, 'slack.com')).toBeNull();
  });

  it('keeps per-person credentials apart from the source credential for the same host (D-026)', () => {
    const both = {
      setup: {
        credentials: [
          { key: 'user_token', label: 'User', hosts: ['slack.com'], perPrincipal: true },
          { key: 'bot_token', label: 'Bot', hosts: ['slack.com'] },
        ],
      },
    };
    expect(providerCredentialForHost(both, 'slack.com')?.key).toBe('bot_token');
    expect(providerPrincipalCredentialForHost(both, 'SLACK.com')?.key).toBe('user_token');
    expect(providerPrincipalCredentialForHost(d, 'slack.com')).toBeNull();
  });
});

describe('providerLiveSearchResultIssue (D-026)', () => {
  const hit = {
    externalId: 'C1:1700000000.000100',
    title: '#general',
    text: 'the deploy is stuck',
    occurredAt: '2026-10-12T09:00:00.000Z',
    participants: ['U1'],
    permalink: 'https://example.slack.com/archives/C1/p1700000000000100',
  };

  it('names the capability and accepts hits with nullable time and link', () => {
    expect(PROVIDER_SEARCH_LIVE_CAPABILITY).toBe('search.live');
    expect(providerLiveSearchResultIssue({ hits: [] })).toBeNull();
    expect(providerLiveSearchResultIssue({ hits: [hit, { ...hit, externalId: 'x', occurredAt: null, permalink: null }] })).toBeNull();
  });

  it('refuses a result without hits and a hit missing or mistyping a field', () => {
    expect(providerLiveSearchResultIssue(null)).toBe('search.live result must carry a hits list');
    expect(providerLiveSearchResultIssue({ hits: 'none' })).toBe('search.live result must carry a hits list');
    expect(providerLiveSearchResultIssue({ hits: [{ ...hit, externalId: '' }] })).toBe('search.live hits[0].externalId must be a non-empty string');
    expect(providerLiveSearchResultIssue({ hits: [hit, { ...hit, text: undefined }] })).toBe('search.live hits[1] needs title and text strings');
    expect(providerLiveSearchResultIssue({ hits: [{ ...hit, occurredAt: 1700000000 }] })).toBe(
      'search.live hits[0].occurredAt must be a string or null',
    );
    expect(providerLiveSearchResultIssue({ hits: [{ ...hit, participants: [1] }] })).toBe(
      'search.live hits[0].participants must be a list of strings',
    );
    expect(providerLiveSearchResultIssue({ hits: [{ ...hit, permalink: undefined }] })).toBe('search.live hits[0].permalink must be a string or null');
  });
});

/**
 * The vendor app the owner creates before connecting (cupboard-distributable-integrations-2026-10-10
 * P-002, SPEC-R-2-P-002): a Create app link with the definition filled in, plus a copyable definition.
 */
describe('setup.appRegistration', () => {
  const base: ProviderDescriptor = {
    id: 'example-chat',
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: ['chat.send'],
    egressHosts: ['api.example.com'],
  };
  const manifest = { display_information: { name: 'Papercusp' }, settings: { socket_mode_enabled: true } };
  const slackLike = {
    createUrl: 'https://api.example.com/apps?new_app=1&manifest_json={definition}',
    definition: manifest,
    docsUrl: 'https://api.example.com/docs/app-manifests',
    copyHint: 'Choose Create New App, then From a manifest, and paste it.',
  };
  const withRegistration = (appRegistration: unknown) =>
    validateProviderDescriptor({ ...base, setup: { appRegistration } } as unknown as ProviderDescriptor);

  it('accepts a create link with the definition placeholder, docs and a copy hint, alone or beside credentials', () => {
    expect(withRegistration(slackLike)).toEqual([]);
    expect(withRegistration({ createUrl: 'https://api.example.com/apps/new' })).toEqual([]);
    expect(
      validateProviderDescriptor({
        ...base,
        setup: { appRegistration: slackLike, credentials: [{ key: 'bot_token', label: 'Bot token', hosts: ['api.example.com'] }] },
      }),
    ).toEqual([]);
  });

  it('opens the vendor page with the definition URL-encoded where the placeholder sits', () => {
    const url = providerAppRegistrationUrl(slackLike);
    expect(url.startsWith('https://api.example.com/apps?new_app=1&manifest_json=')).toBe(true);
    expect(url).not.toContain(PROVIDER_APP_DEFINITION_PLACEHOLDER);
    expect(JSON.parse(new URL(url).searchParams.get('manifest_json') ?? 'null')).toEqual(manifest);
    expect(providerAppRegistrationUrl({ createUrl: 'https://api.example.com/apps/new' })).toBe('https://api.example.com/apps/new');
  });

  it('copies the definition as pretty JSON, and offers nothing to copy when none is declared', () => {
    expect(providerAppDefinitionText(slackLike)).toBe(JSON.stringify(manifest, null, 2));
    expect(providerAppDefinitionText({})).toBeNull();
  });

  it('refuses a non-https link, an unknown placeholder, a placeholder with no definition, and a secret', () => {
    expect(withRegistration({ createUrl: 'http://api.example.com/apps' })).toContain('provider.setup.appRegistration.createUrl must be an https URL');
    expect(withRegistration({ createUrl: 'https://api.example.com/apps?team={team}', definition: manifest })).toContain(
      "provider.setup.appRegistration.createUrl placeholder '{team}' is unknown; only {definition} is filled in",
    );
    expect(withRegistration({ createUrl: slackLike.createUrl })).toContain(
      'provider.setup.appRegistration.createUrl uses {definition} but no definition is declared',
    );
    expect(withRegistration({ ...slackLike, clientSecret: 'x' })).toContain(
      'provider.setup.appRegistration.clientSecret is not allowed: a descriptor never carries a credential value',
    );
    expect(withRegistration({ ...slackLike, docsUrl: 'ftp://example.com' })).toContain('provider.setup.appRegistration.docsUrl must be an https URL');
    expect(withRegistration('slack')).toEqual(['provider.setup.appRegistration must be an object']);
  });

  it('refuses a definition that is not a JSON object or is too long to travel in a URL', () => {
    expect(withRegistration({ ...slackLike, definition: ['a'] })).toContain('provider.setup.appRegistration.definition must be a JSON object');
    const huge = { blob: 'x'.repeat(PROVIDER_APP_DEFINITION_MAX_LENGTH) };
    expect(withRegistration({ ...slackLike, definition: huge })).toContain(
      `provider.setup.appRegistration.definition is longer than ${PROVIDER_APP_DEFINITION_MAX_LENGTH} characters as JSON`,
    );
  });
});

describe('validateProviderDescriptor: ingress.socket (P-003, D-009)', () => {
  const socket = {
    credential: 'app_token',
    open: { url: 'https://api.example.com/apps.connections.open', urlField: 'url' },
    ackField: 'envelope_id',
    reconnect: { field: 'type', values: ['disconnect'] },
  };
  const base: ProviderDescriptor = {
    id: 'example-chat',
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: ['chat.send', 'ingress.normalize'],
    egressHosts: ['api.example.com'],
    setup: {
      credentials: [
        { key: 'bot_token', label: 'Bot token', hosts: ['api.example.com'] },
        { key: 'app_token', label: 'App token', pattern: 'xapp-[A-Za-z0-9-]+' },
      ],
    },
    ingress: { socket },
  };
  const withSocket = (patch: Record<string, unknown>) =>
    validateProviderDescriptor({ ...base, ingress: { socket: { ...socket, ...patch } } } as unknown as ProviderDescriptor);

  it('accepts a socket opened with a host-only setup credential, with or without ack and reconnect rules', () => {
    expect(validateProviderDescriptor(base)).toEqual([]);
    expect(validateProviderDescriptor({ ...base, ingress: { socket: { credential: 'app_token', open: { url: socket.open.url, method: 'GET', urlField: 'data.socket.url' } } } })).toEqual([]);
    expect(withSocket({ immediate: { field: 'type', values: ['interactive'] } })).toEqual([]);
    expect(PROVIDER_INGRESS_NORMALIZE_CAPABILITY).toBe('ingress.normalize');
  });

  it('refuses a credential that is not a declared setup field, including when the provider declares no setup', () => {
    expect(withSocket({ credential: 'signing_secret' })).toContain(
      "provider.ingress.socket.credential 'signing_secret' is not a provider.setup.credentials key",
    );
    expect(withSocket({ credential: '' })).toContain('provider.ingress.socket.credential must name a provider.setup.credentials key');
    expect(validateProviderDescriptor({ ...base, setup: undefined })).toContain(
      "provider.ingress.socket.credential 'app_token' is not a provider.setup.credentials key",
    );
  });

  it("refuses a per-person credential as the socket's credential: the host's connection is the source's (D-026)", () => {
    const setup = {
      credentials: [
        { key: 'bot_token', label: 'Bot token', hosts: ['api.example.com'] },
        { key: 'app_token', label: 'App token', hosts: ['api.example.com'], perPrincipal: true },
      ],
    };
    expect(validateProviderDescriptor({ ...base, setup })).toEqual([
      "provider.ingress.socket.credential 'app_token' is a per-person credential; the host's connection needs the source's own",
    ]);
  });

  it('refuses an open URL that is not https or whose host is outside egressHosts', () => {
    expect(withSocket({ open: { ...socket.open, url: 'http://api.example.com/open' } })).toContain('provider.ingress.socket.open.url must be an https URL');
    expect(withSocket({ open: { ...socket.open, url: 'https://evil.example.net/open' } })).toContain(
      "provider.ingress.socket.open.url host 'evil.example.net' is not in provider.egressHosts",
    );
    expect(withSocket({ open: { ...socket.open, method: 'PUT' } })).toContain('provider.ingress.socket.open.method must be GET or POST');
    expect(withSocket({ open: { url: socket.open.url } })).toContain('provider.ingress.socket.open.urlField must be a dot path to the socket URL in the response');
    expect(withSocket({ open: undefined })).toContain('provider.ingress.socket.open must be an object');
  });

  it('refuses a socket ingress whose provider does not declare ingress.normalize', () => {
    expect(validateProviderDescriptor({ ...base, capabilities: ['chat.send'] })).toEqual([
      'provider.ingress.socket needs capability ingress.normalize',
    ]);
  });

  it('refuses malformed ack and reconnect fields, a carried token and an unknown ingress kind', () => {
    expect(withSocket({ ackField: 'envelope.id' })).toContain('provider.ingress.socket.ackField must be a top-level envelope field name');
    expect(withSocket({ reconnect: { field: 'type', values: [] } })).toContain('provider.ingress.socket.reconnect.values must list at least one value');
    expect(withSocket({ reconnect: { field: 'type', values: ['disconnect', 'disconnect'] } })).toContain(
      'provider.ingress.socket.reconnect.values repeats "disconnect"',
    );
    expect(withSocket({ reconnect: { values: ['disconnect'] } })).toContain('provider.ingress.socket.reconnect.field must be a top-level envelope field name');
    // `immediate` is held to the same envelope-match rules as `reconnect`.
    expect(withSocket({ immediate: ['interactive'] })).toContain('provider.ingress.socket.immediate must be an object');
    expect(withSocket({ immediate: { field: 'payload.type', values: ['interactive'] } })).toContain(
      'provider.ingress.socket.immediate.field must be a top-level envelope field name',
    );
    expect(withSocket({ immediate: { field: 'type', values: [''] } })).toContain('provider.ingress.socket.immediate.values must list at least one value');
    expect(withSocket({ immediate: { field: 'type', values: ['interactive', 'interactive'] } })).toContain(
      'provider.ingress.socket.immediate.values repeats "interactive"',
    );
    expect(withSocket({ token: 'xapp-1-abc' })).toContain(
      'provider.ingress.socket.token is not allowed: a descriptor never carries a credential value',
    );
    expect(validateProviderDescriptor({ ...base, ingress: { socket, webhook: {} } } as unknown as ProviderDescriptor)).toContain(
      'provider.ingress.webhook is not a known ingress kind (known: socket)',
    );
    expect(validateProviderDescriptor({ ...base, ingress: 'socket' } as unknown as ProviderDescriptor)).toEqual(['provider.ingress must be an object']);
    expect(validateProviderDescriptor({ ...base, ingress: {} } as unknown as ProviderDescriptor)).toEqual(['provider.ingress.socket must be an object']);
  });
});

describe('provider option sources (P-004, D-005)', () => {
  it('reads an x-options source off a schema property and ignores a malformed one', () => {
    expect(providerOptionSourceOf({ type: 'string', 'x-options': { capability: 'chat.channels' } }))
      .toEqual({ capability: 'chat.channels' });
    expect(providerOptionSourceOf({ type: 'string', 'x-options': { capability: 'ticket.containers', args: { kind: 'project' } } }))
      .toEqual({ capability: 'ticket.containers', args: { kind: 'project' } });
    expect(providerOptionSourceOf({ type: 'string' })).toBeNull();
    expect(providerOptionSourceOf({ type: 'string', 'x-options': { capability: 'chat.channels.list' } })).toBeNull();
  });

  it('keeps the documented option shape, dropping malformed and repeated entries', () => {
    expect(normalizeProviderOptions({
      options: [
        { value: 'C1', label: '#general', description: 'Company-wide' },
        { value: 'C2' },
        { value: 'C1', label: 'duplicate' },
        { label: 'no value' },
        'not an object',
      ],
    })).toEqual({
      options: [
        { value: 'C1', label: '#general', description: 'Company-wide' },
        { value: 'C2', label: 'C2' },
      ],
      truncated: false,
    });
  });

  it('reads the ticket.containers result as options without the provider changing', () => {
    expect(normalizeProviderOptions({
      containers: [{ id: '120', name: 'Bugs', kind: 'project', sections: [] }, { id: '121', kind: 'project' }],
      truncated: true,
    })).toEqual({ options: [{ value: '120', label: 'Bugs' }, { value: '121', label: '121' }], truncated: true });
  });

  it('caps the list and reports it as truncated', () => {
    const many = Array.from({ length: PROVIDER_OPTIONS_MAX + 5 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    const list = normalizeProviderOptions({ options: many });
    expect(list.options).toHaveLength(PROVIDER_OPTIONS_MAX);
    expect(list.truncated).toBe(true);
    expect(normalizeProviderOptions(null)).toEqual({ options: [], truncated: false });
  });
});

describe('providerCoverageIssues (WI-6554700010012278)', () => {
  const datatypes = ['chat.message'];
  const window = {
    datatype: 'chat.message',
    containerRef: 'C123',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-08T00:00:00.000Z',
    nativeIds: ['C123:1.0'],
  };

  it('accepts no coverage, a container window, a thread window and an empty live set', () => {
    expect(providerCoverageIssues(undefined, datatypes)).toEqual([]);
    expect(providerCoverageIssues([window], datatypes)).toEqual([]);
    expect(providerCoverageIssues([{ datatype: 'chat.message', containerRef: 'C123', threadRef: '1.0', nativeIds: [] }], datatypes))
      .toEqual([]);
  });

  it('refuses each malformed field, because coverage erases whatever it does not name', () => {
    expect(providerCoverageIssues({}, datatypes)).toEqual(['coverage must be an array']);
    expect(providerCoverageIssues([null], datatypes)).toEqual(['coverage[0] must be an object']);
    expect(providerCoverageIssues([{ ...window, datatype: 'mail.message' }], datatypes))
      .toEqual(["coverage[0].datatype must be one of the descriptor's datatypes"]);
    expect(providerCoverageIssues([{ ...window, containerRef: 'has space' }], datatypes)).toHaveLength(1);
    expect(providerCoverageIssues([{ ...window, threadRef: ' ' }], datatypes)).toEqual(['coverage[0].threadRef must be a non-empty string']);
    expect(providerCoverageIssues([{ ...window, from: 'yesterday' }], datatypes)).toEqual(['coverage[0].from must be an ISO-8601 time']);
    expect(providerCoverageIssues([{ ...window, from: window.to, to: window.from }], datatypes))
      .toEqual(['coverage[0].from must not be after coverage[0].to']);
    expect(providerCoverageIssues([{ ...window, nativeIds: undefined }], datatypes))
      .toEqual(['coverage[0].nativeIds must be an array of non-empty native ids']);
    expect(providerCoverageIssues([{ ...window, nativeIds: [''] }], datatypes))
      .toEqual(['coverage[0].nativeIds must be an array of non-empty native ids']);
  });
});
