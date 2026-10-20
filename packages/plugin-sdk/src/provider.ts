/**
 * Integration provider contract (generalized-integrations-google-migration-
 * cupboard-workflows-2026-10-05, D-006 / P-001).
 *
 * A provider is a plugin that declares a `provider` descriptor in its
 * manifest and implements a small request/response adapter. The descriptor is
 * pure data (validated at load and install time); the adapter is code. The
 * host owns everything stateful — connections, credentials, leases, cursors,
 * retry, health, receipts and grants. The provider owns HTTP details,
 * pagination and the mapping into canonical records.
 *
 * Providers never receive tokens. All network access goes through
 * `host.fetch({ source, request })`, which checks the URL against the declared
 * egress hosts and injects the access token for exactly that source.
 */

/** Contract versions this SDK understands. A descriptor naming any other version is refused. */
export const PROVIDER_CONTRACT_VERSIONS = [1] as const;
export type ProviderContractVersion = (typeof PROVIDER_CONTRACT_VERSIONS)[number];

/** Provider ids are stable, lowercase, and used inside `ext:<provider>:<event>` provenance keys. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
/** Canonical datatype ids (e.g. `email-message`, `calendar-event`, `ticket`). */
export const PROVIDER_DATATYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Capabilities are `<domain>.<verb>` (e.g. `mail.read`, `mail.draft`, `calendar.write`). */
export const PROVIDER_CAPABILITY_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$/;
/** Egress hosts are exact hostnames or a single leading `*.` wildcard label. */
export const PROVIDER_EGRESS_HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface ProviderOAuthDescriptor {
  /** Each connection selects its own HTTPS origin. Endpoints are absolute-path references;
   * the host binds them to its saved registration, never to a provider-supplied request URL.
   * The source carries that bound origin as connection-owned config.connectionOrigin. */
  instance?: true;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /**
   * How the authorize URL joins `scopes`: a space (OAuth 2.0 default) or a comma (Linear
   * documents `scope=read,write`).
   */
  scopeSeparator?: ' ' | ',';
  /** Form/query key for the host-held client id. TikTok uses client_key. */
  clientIdParameter?: 'client_id' | 'client_key';
  /** How the host authenticates exchange and refresh at the token endpoint (RFC 6749).
   * Defaults to client_secret_post. Client credentials always remain host-held. */
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic';
  /** Require an owner-supplied User-Agent in the host-held OAuth app registration.
   * The host sends it on token, identity and API requests; packages cannot override it. */
  userAgentRequired?: true;
  /** Expiring grants normally require a refresh token. Opt into owner reauthorization
   * for APIs that issue none; the host still expires the grant and blocks the source. */
  refreshPolicy?: 'refresh-token' | 'reauthorize';
  pkce?: boolean;
  /** Reference to a host-held client registration. Never a client secret. */
  clientRegistrationRef?: string;
  /** Optional shared-credential group (e.g. one Google Workspace grant serving mail + calendar). */
  credentialGroup?: string;
  /**
   * Account-identity endpoint. The HOST fetches it with the fresh access token
   * after consent (the provider never sees the token) and reads the stable
   * account id at `idField` (dot path). Must be https and inside `egressHosts`.
   */
  identity?: ProviderOAuthIdentity;
  /**
   * Some APIs mint a resource credential from the connected account (for example a Page
   * credential). The host selects the resource from the SOURCE config and injects its token;
   * neither the account token nor the exchange response is exposed to the package.
   */
  resourceToken?: ProviderOAuthResourceToken;
}

export interface ProviderOAuthResourceToken {
  /** Account-authenticated HTTPS collection endpoint, inside egressHosts. */
  url: string;
  /** Hosts on which the resource token replaces the account token. */
  hosts: string[];
  collectionField: string;
  idField: string;
  tokenField: string;
  /** String source-config field identifying the resource. Never supplied by the package call. */
  configKey: string;
  /** All listed permissions must be present on the selected resource before any API call. */
  permissions?: { field: string; required: string[] };
  /** Optional next-page URL field; the host follows only the same origin and path. */
  nextUrlField?: string;
}

export interface ProviderOAuthIdentity {
  url: string;
  idField: string;
  displayNameField?: string;
  /**
   * Request method, default GET. POST is for identity endpoints that only answer a request
   * body, such as a GraphQL API (Linear: `POST /graphql` with a `viewer`/`organization` query).
   */
  method?: 'GET' | 'POST';
  /** JSON request body, sent with `content-type: application/json`. Only with `method: 'POST'`. */
  body?: string;
}

/**
 * Where a source's records of one datatype go (`data_sources.destination_policy` values): a
 * mirrored `record`, a create-once `event`, or a documents-corpus `document`. The host writes a
 * datatype only to its own registered nature, so a destination naming another nature routes nothing.
 */
export const PROVIDER_DESTINATIONS = ['record', 'event', 'document'] as const;
export type ProviderDestination = (typeof PROVIDER_DESTINATIONS)[number];

export interface ProviderDescriptor {
  /** Stable provider id, e.g. `gmail`, `google-calendar`, `outlook-mail`, `github-issues`. */
  id: string;
  /** Contract version the adapter implements. */
  contractVersion: number;
  displayName?: string;
  /** Canonical datatypes this provider's `syncPage` produces. */
  datatypes: string[];
  /** Whether inbound sync is supported. Omitted means true for existing
   * providers; false declares a write-only package that the host does not poll. */
  sync?: boolean;
  /** Capability subset `invoke` accepts. */
  capabilities: string[];
  /** Dated API-contract evidence shipped with this package. This is neither account consent
   * nor live-account acceptance. Capability declarations alone do not verify a write contract. */
  verification?: ProviderVerificationDescriptor;
  /** Declared vendor budgets, with their own dated evidence. These are inputs to
   * host admission policy, never permission to perform an undeclared capability. */
  rateBudget?: ProviderRateBudget;
  /** OAuth connection descriptor; omitted for providers that need no account grant. */
  oauth?: ProviderOAuthDescriptor;
  /** Hosts `host.fetch` may reach for this provider. Everything else is refused. */
  egressHosts: string[];
  /** JSON Schema for per-source configuration (account/calendar choices etc.). */
  configSchema?: Record<string, unknown>;
  /**
   * Destination policy a newly connected source starts with: datatype -> the destinations its
   * records go to (the shape of `data_sources.destination_policy`). The host writes it when it
   * creates the source, and on a reconnect only when the source still has no policy, so a policy
   * the owner edited is never overwritten. Every key must be one of `datatypes`. Omit it and a new
   * source routes nothing until its policy is set.
   */
  defaultDestinations?: Record<string, ProviderDestination[]>;
  /**
   * Host-held service credentials, by reference (D-018.1). A request to one of
   * `hosts` carries the credential the host registered under `ref` instead of
   * the source account's token. Every host must also be in `egressHosts`. The
   * provider never sees either credential; it receives the credential's
   * non-secret parameters on `services[ref]` of each sync and invoke request.
   */
  serviceCredentials?: ProviderServiceCredential[];
  /**
   * How the provider's own webhooks reach the host and are verified (D-016). Pure data: the HOST
   * checks the handshake and the signature, so the ingress never branches on a provider name. A
   * verified delivery wakes the source's next sync by default. A descriptor may instead route it
   * through ingress.normalize and the same record admission path as socket ingress and sync.
   */
  push?: ProviderPushDescriptor;
  /**
   * Declares that this provider's sync pages may carry a {@link ProviderMembershipSnapshot}: who
   * may read the source's remote resource there (a repository's collaborators, a channel's
   * members). The host replaces an organization-scope source's permission list with it, so
   * organization documents stay readable by exactly those people. A page carrying `membership`
   * from a provider that did not declare it is refused.
   */
  membership?: ProviderMembershipDescriptor;
  /**
   * What the owner sets up by hand on the provider's Integrations card (plan
   * cupboard-distributable-integrations-2026-10-10). Pure data: the host renders the fields,
   * checks each value, stores it, and never hands it back.
   */
  setup?: ProviderSetupDescriptor;
  /**
   * Inbound delivery the HOST holds open for each connected source (cupboard-distributable-
   * integrations P-003, D-009), e.g. a Slack Socket Mode connection. Pure data: the host opens the
   * connection with a credential the owner stored, acknowledges each envelope, and hands it to the
   * provider's {@link PROVIDER_INGRESS_NORMALIZE_CAPABILITY} capability, which turns it into records.
   * Provider code never sees the credential or the socket.
   */
  ingress?: ProviderIngressDescriptor;
}

export interface ProviderQuotaBucket {
  appliesTo: string;
  perDay: number;
  unit: 'calls' | 'units';
  /** Content operations drawing on this non-fungible bucket (e.g. read, reply). */
  verbs?: string[];
  notes?: string;
}

export interface ProviderRateBudget {
  verifiedAt: string | null;
  sources: string[];
  requestsPerMinute?: number;
  quotaUnitsPerDay?: number;
  budgetHeaders?: string[];
  buckets?: Record<string, ProviderQuotaBucket>;
  dynamicQuota?: {
    formula: string;
    driver: string;
    usageHeader?: string;
    assumedDailyFloor: number;
    throttleCodes?: number[];
    retryExtendsBlock?: boolean;
  };
  notes?: string;
}

function providerRateBudgetIssues(value: unknown): string[] {
  const prefix = 'provider.rateBudget';
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
  if (!object(value)) return [`${prefix} must be an object`];
  const issues: string[] = [];
  const keys = (v: Record<string, unknown>, allowed: string[], path: string) => {
    for (const key of Object.keys(v)) if (!allowed.includes(key)) issues.push(`${path}.${key} is not supported`);
  };
  const positive = (v: unknown, path: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) issues.push(`${path} must be a finite positive number`);
  };
  const text = (v: unknown, path: string) => { if (!isNonEmptyString(v)) issues.push(`${path} must be a nonempty string`); };
  keys(value, ['verifiedAt', 'sources', 'requestsPerMinute', 'quotaUnitsPerDay', 'budgetHeaders', 'buckets', 'dynamicQuota', 'notes'], prefix);
  issues.push(...providerVerificationIssues({ verifiedAt: value.verifiedAt, sources: value.sources }, []).map((issue) => issue.replace('provider.verification', prefix)));
  for (const key of ['requestsPerMinute', 'quotaUnitsPerDay']) if (value[key] !== undefined) positive(value[key], `${prefix}.${key}`);
  if (value.notes !== undefined) text(value.notes, `${prefix}.notes`);
  if (value.budgetHeaders !== undefined && (!Array.isArray(value.budgetHeaders) || value.budgetHeaders.some((header) => typeof header !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)))) issues.push(`${prefix}.budgetHeaders must contain HTTP header names`);
  if (value.buckets !== undefined) {
    if (!object(value.buckets) || Object.keys(value.buckets).length === 0) issues.push(`${prefix}.buckets must be a nonempty object`);
    else for (const [name, bucket] of Object.entries(value.buckets)) {
      const path = `${prefix}.buckets.${name}`;
      if (!isNonEmptyString(name) || !object(bucket)) { issues.push(`${path} must be a named quota bucket`); continue; }
      keys(bucket, ['appliesTo', 'perDay', 'unit', 'verbs', 'notes'], path);
      text(bucket.appliesTo, `${path}.appliesTo`);
      positive(bucket.perDay, `${path}.perDay`);
      if (!['calls', 'units'].includes(String(bucket.unit))) issues.push(`${path}.unit must be calls or units`);
      if (bucket.verbs !== undefined && (!Array.isArray(bucket.verbs) || bucket.verbs.some((verb) => !isNonEmptyString(verb)) || new Set(bucket.verbs).size !== bucket.verbs.length)) issues.push(`${path}.verbs must contain distinct nonempty operations`);
      if (bucket.notes !== undefined) text(bucket.notes, `${path}.notes`);
    }
  }
  if (value.dynamicQuota !== undefined) {
    const path = `${prefix}.dynamicQuota`;
    const dynamic = value.dynamicQuota;
    if (!object(dynamic)) issues.push(`${path} must be an object`);
    else {
      keys(dynamic, ['formula', 'driver', 'usageHeader', 'assumedDailyFloor', 'throttleCodes', 'retryExtendsBlock'], path);
      text(dynamic.formula, `${path}.formula`);
      text(dynamic.driver, `${path}.driver`);
      positive(dynamic.assumedDailyFloor, `${path}.assumedDailyFloor`);
      if (dynamic.usageHeader !== undefined && (typeof dynamic.usageHeader !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(dynamic.usageHeader))) issues.push(`${path}.usageHeader must be an HTTP header name`);
      if (dynamic.retryExtendsBlock !== undefined && typeof dynamic.retryExtendsBlock !== 'boolean') issues.push(`${path}.retryExtendsBlock must be a boolean`);
      if (dynamic.throttleCodes !== undefined && (!Array.isArray(dynamic.throttleCodes) || dynamic.throttleCodes.some((code) => !Number.isSafeInteger(code) || code < 0))) issues.push(`${path}.throttleCodes must contain nonnegative integer codes`);
    }
  }
  return issues;
}

export interface ProviderVerificationDescriptor {
  verifiedAt: string | null;
  sources: string[];
  /** Only declared capabilities may be attested. Missing/null means unverified. */
  capabilities?: Record<string, string | null>;
  /** A contract-level wall; connection credentials and consent remain host-owned. */
  blockedOn?: string;
}

function isVerificationDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function providerVerificationIssues(value: unknown, capabilities: readonly string[]): string[] {
  const prefix = 'provider.verification';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${prefix} must be an object`];
  const v = value as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(v)) {
    if (!['verifiedAt', 'sources', 'capabilities', 'blockedOn'].includes(key)) issues.push(`${prefix}.${key} is not supported`);
  }
  if (v.verifiedAt !== null && !isVerificationDate(v.verifiedAt)) issues.push(`${prefix}.verifiedAt must be an ISO calendar date or null`);
  if (!Array.isArray(v.sources)) issues.push(`${prefix}.sources must be a list of HTTPS source URLs`);
  else {
    if (v.verifiedAt !== null && v.sources.length === 0) issues.push(`${prefix}.sources must cite the verified contract`);
    for (const source of v.sources) {
      let valid = false;
      try {
        const url = new URL(source);
        valid = typeof source === 'string' && url.protocol === 'https:' && !url.username && !url.password;
      } catch { /* invalid source is reported below */ }
      if (!valid) issues.push(`${prefix}.sources must contain only HTTPS source URLs without credentials`);
    }
  }
  if (v.blockedOn !== undefined && !isNonEmptyString(v.blockedOn)) issues.push(`${prefix}.blockedOn must explain the contract wall`);
  if (v.capabilities !== undefined) {
    if (!v.capabilities || typeof v.capabilities !== 'object' || Array.isArray(v.capabilities)) issues.push(`${prefix}.capabilities must map declared capabilities to dates or null`);
    else for (const [capability, date] of Object.entries(v.capabilities)) {
      if (!capabilities.includes(capability)) issues.push(`${prefix}.capabilities.${capability} is not a declared capability`);
      if (date !== null && !isVerificationDate(date)) issues.push(`${prefix}.capabilities.${capability} must be an ISO calendar date or null`);
      if (date !== null && !isVerificationDate(v.verifiedAt)) issues.push(`${prefix}.capabilities.${capability} requires a verified contract`);
    }
  }
  return issues;
}

/** Fail closed for absent or malformed contract evidence, even before registration. */
export function providerCapabilityVerificationIssue(
  descriptor: ProviderDescriptor,
  capability?: string,
): 'capability-unsupported' | 'unverified' | 'owner-blocked' | 'capability-unverified' | null {
  if (capability !== undefined && !descriptor.capabilities.includes(capability)) return 'capability-unsupported';
  const verification = descriptor.verification;
  if (!verification || providerVerificationIssues(verification, descriptor.capabilities).length || !verification.verifiedAt) return 'unverified';
  if (verification.blockedOn) return 'owner-blocked';
  if (capability !== undefined && !verification.capabilities?.[capability]) return 'capability-unverified';
  return null;
}

/** Inbound channels a provider declares (P-003). */
export interface ProviderIngressDescriptor {
  socket: ProviderSocketIngressDescriptor;
}

/**
 * A socket the host opens per connected source. Socket URLs are usually single-use, so the host
 * calls `open` before every connect and reconnect.
 */
export interface ProviderSocketIngressDescriptor {
  /**
   * `setup.credentials` key whose stored value authenticates `open`, sent as
   * `Authorization: Bearer <value>`. Typically a credential with no `hosts`, used only here.
   */
  credential: string;
  /** The request that returns a fresh socket URL. */
  open: {
    /** https endpoint; its host must be allowed by `egressHosts`. */
    url: string;
    /** Default `POST`. */
    method?: 'GET' | 'POST';
    /** Dot path of the `wss://` URL in the JSON response, e.g. `url`. */
    urlField: string;
  };
  /**
   * Top-level envelope field whose value the host sends back as `{ [ackField]: value }` as soon as
   * an envelope arrives, before normalizing it (Slack: `envelope_id`). Omit when the protocol has no acks.
   */
  ackField?: string;
  /**
   * Top-level envelope `field` whose value in `values` means the server is about to drop the
   * socket (Slack: `type` = `disconnect`); the host opens a fresh one instead of waiting for the close.
   */
  reconnect?: ProviderSocketEnvelopeMatch;
  /**
   * Envelopes whose top-level `field` value is in `values` are normalized at once, instead of
   * waiting behind the source's serialized envelope chain. For interactions with a short response
   * window (Slack: `type` = `interactive`, whose trigger_id opens a form for only 3 seconds).
   * Their records are admitted in arrival order among themselves, not among other envelopes.
   */
  immediate?: ProviderSocketEnvelopeMatch;
}

/** A top-level envelope field and the values that select an envelope. */
export interface ProviderSocketEnvelopeMatch {
  field: string;
  values: string[];
}

/**
 * Capability a socket-ingress provider must declare: `invoke({ capability: 'ingress.normalize',
 * args: { envelope, sourceConfig } })` returns {@link ProviderIngressNormalizeResult}. An envelope
 * that carries no data (a hello, a ping, an event the provider ignores) returns `records: []`.
 */
export const PROVIDER_INGRESS_NORMALIZE_CAPABILITY = 'ingress.normalize';

/** Arguments the host passes to {@link PROVIDER_INGRESS_NORMALIZE_CAPABILITY}. */
export interface ProviderIngressNormalizeArgs {
  /** One envelope exactly as the socket delivered it. */
  envelope: unknown;
  /**
   * The connected source's non-secret config (e.g. Slack's channels and a declared drill-bot
   * identity), so a provider can apply source-scoped admission rules
   * (cupboard-distributable-integrations-2026-10-10 D-023). Credentials are never in it.
   * Always an object; a provider that has no such rules ignores it.
   */
  sourceConfig: Record<string, unknown>;
}

/** Result of the {@link PROVIDER_INGRESS_NORMALIZE_CAPABILITY} capability: records shaped like a sync page's. */
export interface ProviderIngressNormalizeResult {
  records: ProviderRecord[];
}

/** Envelope field names `ackField` and `reconnect.field` may use. */
export const PROVIDER_INGRESS_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Dot path `open.urlField` may use. */
export const PROVIDER_INGRESS_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$/;

/** Owner-performed setup a provider declares (cupboard-distributable-integrations P-001, P-002). */
export interface ProviderSetupDescriptor {
  /** Secrets the owner pastes (e.g. a bot token). Shown as masked fields; never readable back. */
  credentials?: ProviderCredentialField[];
  /** Host-held session obtained from the pasted credentials; never exposed through host.fetch. */
  session?: ProviderCredentialSessionDescriptor;
  /** The vendor app the owner creates first, when the vendor needs one (P-002). */
  appRegistration?: ProviderAppRegistration;
}

/** JSON session login and bearer refresh, using the existing protected credential store. */
export interface ProviderCredentialSessionDescriptor {
  url: string;
  refreshUrl: string;
  /** JSON request parameter -> setup.credentials key. No literal values. */
  parameters: Record<string, string>;
  hosts: string[];
  accessTokenField: string;
  refreshTokenField: string;
  /** Optional boolean response field. Explicit false refuses an inactive account. */
  activeField?: string;
  /** Conservative upper bound; a JWT's earlier exp is also respected. */
  maxAgeSeconds: number;
  identity: { idField: string; displayNameField?: string; /** Pasted public account identifier, excluded from secret redaction. */ credentialKey?: string };
}

/**
 * The app the owner registers in the vendor's console before connecting (P-002), e.g. a Slack app
 * created from a manifest. The card offers a "Create app" link that opens `createUrl` with the
 * definition filled in, plus a "Copy definition" fallback for vendors whose prefill is partial or
 * undocumented. Pure data, published to the Cupboard: it never carries a credential.
 */
export interface ProviderAppRegistration {
  /**
   * HTTPS page in the vendor's console where the app is created. Instance OAuth descriptors
   * may use an absolute-path reference, bound by the host to the selected instance. May contain the placeholder
   * {@link PROVIDER_APP_DEFINITION_PLACEHOLDER}, which the host replaces with the URL-encoded JSON
   * of `definition` (e.g. `https://api.slack.com/apps?new_app=1&manifest_json={definition}`).
   */
  createUrl: string;
  /** The app definition the vendor accepts (e.g. a Slack app manifest); a JSON object. */
  definition?: Record<string, unknown>;
  /** https page documenting how to create the app. */
  docsUrl?: string;
  /** One line telling the owner what to do with a copied definition, e.g. "Create New App → From a manifest". */
  copyHint?: string;
}

/** The one placeholder `createUrl` may contain. */
export const PROVIDER_APP_DEFINITION_PLACEHOLDER = '{definition}';
/** Longest serialized `definition` accepted; it travels in a URL. */
export const PROVIDER_APP_DEFINITION_MAX_LENGTH = 16_384;

/** The vendor page the "Create app" link opens, with the definition filled in where declared. */
export function providerAppRegistrationUrl(registration: Pick<ProviderAppRegistration, 'createUrl' | 'definition'>): string {
  if (!registration.createUrl.includes(PROVIDER_APP_DEFINITION_PLACEHOLDER)) return registration.createUrl;
  const encoded = encodeURIComponent(JSON.stringify(registration.definition ?? {}));
  return registration.createUrl.split(PROVIDER_APP_DEFINITION_PLACEHOLDER).join(encoded);
}

/** The definition as the owner pastes it into the vendor console (pretty JSON), or null when none is declared. */
export function providerAppDefinitionText(registration: Pick<ProviderAppRegistration, 'definition'>): string | null {
  return registration.definition === undefined ? null : JSON.stringify(registration.definition, null, 2);
}

/** What an Integrations card needs to offer "Create app" and "Copy definition" (P-002). */
export interface ProviderAppRegistrationView {
  /** The vendor page to open, with the definition already filled in where the descriptor asks. */
  createUrl: string;
  /** The definition as pretty JSON for the copy fallback, or null when none is declared. */
  definitionText: string | null;
  docsUrl: string | null;
  copyHint: string | null;
}

/** The card's view of a descriptor's `setup.appRegistration`, or null when it declares none. */
export function providerAppRegistrationView(descriptor: Pick<ProviderDescriptor, 'setup'>): ProviderAppRegistrationView | null {
  const registration = descriptor.setup?.appRegistration;
  if (!registration) return null;
  return {
    createUrl: providerAppRegistrationUrl(registration),
    definitionText: providerAppDefinitionText(registration),
    docsUrl: registration.docsUrl ?? null,
    copyHint: registration.copyHint ?? null,
  };
}

/**
 * One paste-a-secret field (P-001). The descriptor carries only the field's shape, never a value.
 * The host stores the value next to the provider's OAuth tokens and uses it in exactly two places:
 * `host.fetch` injects it as `Authorization: Bearer <value>` for requests to `hosts`, and host-held
 * ingress (a socket connection the host opens for the provider) reads it by `key`. Provider code
 * never receives it, and no read surface returns it after it is saved.
 */
export interface ProviderCredentialField {
  /** Stable key the value is stored under; lowercase, matches {@link PROVIDER_CREDENTIAL_KEY_PATTERN}. */
  key: string;
  /** Field label on the Integrations card. */
  label: string;
  /**
   * Regular-expression source (no flags) the WHOLE value must match, e.g. `xoxb-[A-Za-z0-9-]+`.
   * The page refuses a non-matching value before it is sent and the host refuses it again.
   */
  pattern?: string;
  /** One line under the field, e.g. where in the vendor's console the value is found. */
  help?: string;
  /** https link with more help. */
  helpUrl?: string;
  /** Shape hint shown inside the empty field, e.g. `xoxb-…`. Never a real value. */
  placeholder?: string;
  /**
   * Hosts whose `host.fetch` requests carry this value as a bearer token. Each must be allowed by
   * `egressHosts` and claimed by no other credential or service credential. Omit for a value that
   * only host-held ingress uses.
   */
  hosts?: string[];
  /** Host-owned authentication for these hosts; omitted preserves Authorization: Bearer.
   * Only authentication headers are accepted, never arbitrary HTTP header injection.
   * `bot` sends `Bot <value>` (Discord bot tokens). */
  auth?: { header: 'authorization' | 'api-key' | 'x-api-key'; scheme: ProviderCredentialAuthScheme };
  /**
   * Each person stores their own value (e.g. a Slack user token), instead of the owner storing one
   * for the source (D-026). The host injects it only into `host.fetch` calls made on that person's
   * behalf ({@link PROVIDER_SEARCH_LIVE_CAPABILITY}), where it takes precedence over the source
   * credential for the same host. Requires `hosts`; never an ingress credential.
   */
  perPrincipal?: boolean;
}

/** How the host writes a pasted credential into its authentication header. */
export type ProviderCredentialAuthScheme = 'bearer' | 'raw' | 'bot';
export const PROVIDER_CREDENTIAL_AUTH_SCHEMES: readonly ProviderCredentialAuthScheme[] = ['bearer', 'raw', 'bot'];

/** The header value the host sends for a pasted credential under `scheme`. */
export function providerCredentialHeaderValue(scheme: ProviderCredentialAuthScheme, value: string): string {
  if (scheme === 'raw') return value;
  if (scheme === 'bot') return `Bot ${value}`;
  return `Bearer ${value}`;
}

/** Credential keys: lowercase, start with a letter, `-`/`_` allowed. */
export const PROVIDER_CREDENTIAL_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
/** Longest value the host stores for one credential. */
export const PROVIDER_CREDENTIAL_MAX_LENGTH = 4096;
const PROVIDER_CREDENTIAL_PATTERN_MAX_LENGTH = 500;

/**
 * Why `value` is not acceptable for `field`, or null when it is. The ONE check both the
 * Integrations page (before sending) and the host (before storing) run, so they cannot disagree.
 * The value is trimmed first; callers store the trimmed value.
 */
export function providerCredentialValueIssue(field: Pick<ProviderCredentialField, 'label' | 'pattern'>, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return `${field.label} is required`;
  const trimmed = value.trim();
  if (trimmed.length > PROVIDER_CREDENTIAL_MAX_LENGTH) {
    return `${field.label} is longer than ${PROVIDER_CREDENTIAL_MAX_LENGTH} characters`;
  }
  // A stored value becomes an HTTP header; whitespace and control characters never belong in one.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return `${field.label} must not contain spaces or line breaks`;
  if (field.pattern !== undefined) {
    let matcher: RegExp;
    try {
      matcher = new RegExp(`^(?:${field.pattern})$`);
    } catch {
      return `${field.label} cannot be checked: the provider's format is invalid`;
    }
    if (!matcher.test(trimmed)) return `${field.label} does not have the expected format`;
  }
  return null;
}

/** The declared source credential (not per-person) whose `hosts` include `hostname`, if any. */
export function providerCredentialForHost(
  descriptor: Pick<ProviderDescriptor, 'setup'>,
  hostname: string,
): ProviderCredentialField | null {
  const host = hostname.toLowerCase();
  for (const field of descriptor.setup?.credentials ?? []) {
    if (field.perPrincipal) continue;
    if ((field.hosts ?? []).some((h) => h.toLowerCase() === host)) return field;
  }
  return null;
}

/** The declared per-person credential whose `hosts` include `hostname`, if any (D-026). */
export function providerPrincipalCredentialForHost(
  descriptor: Pick<ProviderDescriptor, 'setup'>,
  hostname: string,
): ProviderCredentialField | null {
  const host = hostname.toLowerCase();
  for (const field of descriptor.setup?.credentials ?? []) {
    if (!field.perPrincipal) continue;
    if ((field.hosts ?? []).some((h) => h.toLowerCase() === host)) return field;
  }
  return null;
}

/**
 * Capability for searching a source live, storing nothing (D-026): `invoke({ capability:
 * 'search.live', args: { query, limit } })` returns {@link ProviderLiveSearchResult}. The host makes
 * the call on behalf of the person searching, so per-person credentials apply and the vendor itself
 * enforces what that person can see.
 */
export const PROVIDER_SEARCH_LIVE_CAPABILITY = 'search.live';

/** Arguments the host passes to {@link PROVIDER_SEARCH_LIVE_CAPABILITY}. */
export interface ProviderLiveSearchArgs {
  query: string;
  /** Most hits wanted; the provider may return fewer. */
  limit: number;
}

/** One hit of a live search, best first. */
export interface ProviderLiveSearchHit {
  /** Provider-native id, unique within the source. */
  externalId: string;
  title: string;
  text: string;
  /** ISO-8601 time of the hit, or null. */
  occurredAt: string | null;
  participants: string[];
  /** https link to the hit at the vendor, or null. */
  permalink: string | null;
}

export interface ProviderLiveSearchResult {
  hits: ProviderLiveSearchHit[];
}

/** Why `value` is not a well-formed {@link ProviderLiveSearchResult}, or null when it is. */
export function providerLiveSearchResultIssue(value: unknown): string | null {
  const hits = (value as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) return 'search.live result must carry a hits list';
  for (const [index, hit] of hits.entries()) {
    const h = (hit ?? {}) as Partial<ProviderLiveSearchHit>;
    if (!isNonEmptyString(h.externalId)) return `search.live hits[${index}].externalId must be a non-empty string`;
    if (typeof h.title !== 'string' || typeof h.text !== 'string') return `search.live hits[${index}] needs title and text strings`;
    if (!(h.occurredAt === null || typeof h.occurredAt === 'string')) return `search.live hits[${index}].occurredAt must be a string or null`;
    if (!Array.isArray(h.participants) || !h.participants.every((p) => typeof p === 'string')) {
      return `search.live hits[${index}].participants must be a list of strings`;
    }
    if (!(h.permalink === null || typeof h.permalink === 'string')) return `search.live hits[${index}].permalink must be a string or null`;
  }
  return null;
}

/** A provider's membership feed (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05, D-015.4). */
export interface ProviderMembershipDescriptor {
  /**
   * Identity namespace the member ids belong to: the `provider` key of the workspace's
   * provider-identity mappings (e.g. `github`), which resolve a member id to a workspace user.
   */
  identityProvider: string;
  /**
   * The source is made of containers with their own members (Slack channels, shared folders), so
   * snapshots may carry {@link ProviderMembershipSnapshot.containers} and records may name the
   * container they belong to with {@link ProviderRecord.aclRef} (cupboard-distributable-integrations-2026-10-10 D-026).
   */
  containers?: boolean;
}

/**
 * The COMPLETE current membership of the source's remote resource. A provider emits it only once
 * it has enumerated everyone; the host treats it as a full replacement, so a member missing from
 * it loses access. A provider that cannot enumerate members (access denied) emits an empty list:
 * unverifiable readership fails closed.
 */
export interface ProviderMembershipSnapshot {
  /** Who may read the source's records that name no container. */
  members: Array<{ providerUserId: string }>;
  /**
   * Every container the source currently has, each with its complete members. Only a provider
   * whose descriptor declares `membership.containers` may send it. A container the previous
   * snapshot named and this one does not loses every reader (fail closed).
   */
  containers?: ProviderMembershipContainer[];
}

/** One container of a source and who may read it (D-026). */
export interface ProviderMembershipContainer {
  /** Provider-native container id; records name it as their `aclRef`. Matches {@link PROVIDER_ACL_REF_PATTERN}. */
  ref: string;
  /** Human name of the container, e.g. `#general`. */
  title?: string;
  members: Array<{ providerUserId: string }>;
}

/** Container refs: printable, no spaces, at most 200 characters. */
export const PROVIDER_ACL_REF_PATTERN = /^[A-Za-z0-9._:@#\/-]{1,200}$/;

/**
 * Push-wake scheme (plan linear-asana-task-sync-2026-10-05, D-016).
 *
 * `handshake`: the provider's service sends a new subscription's secret in this header while the
 * subscription is being created (Asana `X-Hook-Secret`); the host stores it and echoes the header.
 * The host accepts a handshake only inside a window it opens around `push.subscribe`.
 *
 * `signature`: each delivery carries `hex(HMAC-SHA256(secret, raw body))` in this header.
 */
export interface ProviderPushDescriptor {
  handshake?: { header: string };
  signature: {
    header: string; algorithm: 'hmac-sha256'; encoding: 'hex';
    /** Literal header prefix before the hex digest, e.g. sha256=. */
    prefix?: string;
    /** Use the existing host-held OAuth client registration secret instead of handshake secrets. */
    oauthClientSecret?: boolean;
  };
  /** GET verification challenge; the host compares a declared setup credential and echoes the challenge. */
  verification?: { modeParam: string; modeValue: string; tokenParam: string; challengeParam: string; credentialRef: string };
  /** Default wake; normalize uses ingress.normalize and ordinary connector record admission. */
  delivery?: 'wake' | 'normalize';
}

/** One remote webhook the provider holds for a source. `resource` is the provider's own id for what it watches. */
export interface ProviderPushSubscription {
  id: string;
  resource: string;
}

/**
 * `invoke({ capability: 'push.subscribe', args: { targetUrl, subscriptions } })` (D-016): make the
 * remote webhooks match the source config and point at `targetUrl`, given the set the host stored
 * last time; return the resulting set. Creating, keeping and deleting are the provider's business.
 */
export interface ProviderPushSubscribeResult {
  subscriptions: ProviderPushSubscription[];
  /**
   * Resources the provider could not subscribe this time. Their siblings in `subscriptions` still
   * exist remotely, so the host stores them and retries the rest later instead of losing track of
   * webhooks that were created before the failure.
   */
  failures?: Array<{ resource: string; error: string }>;
}

/** Capability that reconciles a source's remote webhooks (D-016). */
export const PROVIDER_PUSH_SUBSCRIBE_CAPABILITY = 'push.subscribe';
/** Capability that deletes every remote webhook in `args.subscriptions` (D-016). Returns nothing. */
export const PROVIDER_PUSH_UNSUBSCRIBE_CAPABILITY = 'push.unsubscribe';
/** HTTP header names a push scheme may name: lowercase token characters. */
export const PROVIDER_PUSH_HEADER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ProviderServiceCredential {
  ref: string;
  hosts: string[];
}

/** Non-secret parameters of each configured service credential, keyed by ref. Unconfigured refs are absent. */
export type ProviderServices = Record<string, Record<string, string>>;

/** Result of `invoke({ capability: 'sync.wake', args: { state } })` (D-018.2). */
export interface ProviderWakeResult {
  /** True when the source has new remote changes and should sync soon. */
  wake: boolean;
  /** Opaque wake state the host stores and passes back as `args.state` next time. */
  state?: string | null;
}

/** Capability a provider declares to be asked, on each driver tick, whether a source should sync now. */
export const PROVIDER_SYNC_WAKE_CAPABILITY = 'sync.wake';

/**
 * Result of `invoke({ capability: 'sync.adopt', args: { prior } })` (D-020). `prior` is the
 * source's pre-provider cursor state: its cursor object without the host-owned `provider` and
 * `wake` keys, e.g. what a retired host path wrote before this provider existed. The host asks
 * once, before the first page of a source whose cursor has no `provider` key.
 */
export interface ProviderAdoptResult {
  /** Provider cursor to start from, or null when there is nothing to adopt (a normal fresh start). */
  cursor: string | null;
  /** False when the adopted position still owes a historical backfill. */
  backfillComplete: boolean;
}

/** Capability a provider declares to adopt a source's pre-provider cursor state on its first pass. */
export const PROVIDER_SYNC_ADOPT_CAPABILITY = 'sync.adopt';

/** Sync request issued by the host-owned connector driver. */
export interface ProviderSyncRequest {
  /** Opaque source id. The provider never learns the account's credentials. */
  source: string;
  /** Opaque cursor returned by the previous page, or null for a fresh backfill. */
  cursor: string | null;
  mode: 'backfill' | 'incremental';
  /** Cursor rejected earlier in this pass. A reset can still report what history was lost. */
  catchUpFrom?: string;
  /** Per-source configuration validated against the descriptor's configSchema. */
  config?: Record<string, unknown>;
  /** Parameters of the descriptor's configured service credentials (D-018.1). */
  services?: ProviderServices;
  /**
   * Whose data the source is (D-026): `personal` (one person's account), `organization` (readers
   * follow the provider's membership snapshots) or `pot`. Absent from hosts older than D-026.
   */
  scope?: ProviderSourceScope;
}

/** The scopes a data source can have. */
export type ProviderSourceScope = 'personal' | 'organization' | 'pot';

export interface ProviderRecord {
  /** One of the descriptor's declared datatypes. */
  datatype: string;
  /** Provider-native id, unique within the source. Host keys include the source id. */
  nativeId: string;
  /** Provider-native event name used for `ext:<provider>:<event>` provenance. */
  event: string;
  /** Canonical payload for the datatype. Provider-specific fields live under `extensions.<provider>`. */
  payload: Record<string, unknown>;
  /** ISO-8601 time the remote object last changed. */
  occurredAt?: string;
  /** True when the remote object was deleted. */
  deleted?: boolean;
  /**
   * Delivery identity of this record (D-017.3). When present the host dedupes
   * on it instead of a hash of the payload, so a once-only event (e.g. a mail
   * `message.received`) is never re-delivered when the payload changes (a label
   * edit) or the cursor replays. Omit it for version-scoped objects whose edits
   * are new deliveries.
   */
  version?: string;
  /**
   * The container this record belongs to (a {@link ProviderMembershipContainer.ref}), when the
   * descriptor declares `membership.containers`. An organization source's document is readable by
   * that container's members only; a record without one follows the source-wide members (D-026).
   */
  aclRef?: string;
}

export interface ProviderSyncPage {
  records: ProviderRecord[];
  /** Cursor to commit after the host durably admits `records`. */
  nextCursor: string | null;
  /** True when more pages are immediately available. */
  hasMore: boolean;
  /** How this page attempted to close the gap; opaque cursors remain package-owned. */
  catchUp?: ProviderCatchUp;
  /** Positive evidence of an unrecoverable gap, never an inference from an empty page. */
  lossRisk?: ProviderLossRisk;
  /**
   * The source's complete current membership, when this page finished enumerating it. Only a
   * provider whose descriptor declares `membership` may set it. The host applies it before it
   * commits `nextCursor`; a full replacement is idempotent, so a replayed page converges.
   */
  membership?: ProviderMembershipSnapshot;
  /**
   * Windows this page read COMPLETELY from the remote (WI-6554700010012278). Each entry says
   * "these are every live object of `datatype` in this window right now", so the host tombstones
   * what it stored for the window that `nativeIds` does not name — the only way a delete made
   * while no live feed was listening (the daemon offline, a socket gap) ever reaches the store.
   * Emit a window only after every remote page for it was read: a partial window would erase
   * live objects. The host applies coverage after the page's records and before `nextCursor`.
   */
  coverage?: ProviderCoverage[];
}

export interface ProviderCatchUp {
  path: 'cold-start' | 'cursor-replay' | 'backfill' | 'live-only';
  /** Required only for backfill. */
  reason?: 'cursor-expired' | 'cursor-rejected' | 'no-replay-supported';
}

export interface ProviderLossRisk {
  kind: 'retention-window-exceeded' | 'capped-window-overflow';
  /** Oldest instant still reachable through the remote API, not the host's sync time. */
  oldestReachableAt: string;
  detail: string;
}

/** Host-owned sync freshness; the provider cursor stays opaque to readers. */
export interface ProviderCursorFreshness {
  state: 'synced' | 'position-only' | 'never-synced' | 'unrecognized';
  at: string | null;
  ageMs: number | null;
  position: string | null;
  detail: string;
  lossRisk?: ProviderLossRisk;
}

/** Null for a legacy source not yet using the provider cursor contract. */
export function providerCursorFreshness(cursor: unknown, nowMs: number): ProviderCursorFreshness | null {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
    || !Object.prototype.hasOwnProperty.call(cursor, 'provider')) return null;
  const row = cursor as { provider?: unknown; providerSync?: unknown };
  const progress = row.providerSync && typeof row.providerSync === 'object' && !Array.isArray(row.providerSync)
    ? row.providerSync as { lastSyncedAt?: unknown; lossRisk?: ProviderLossRisk } : {};
  const at = typeof progress.lastSyncedAt === 'string' && Number.isFinite(Date.parse(progress.lastSyncedAt))
    ? progress.lastSyncedAt : null;
  const position = typeof row.provider === 'string' && row.provider !== '' ? row.provider : null;
  return {
    state: at ? 'synced' : position ? 'position-only' : row.provider === null ? 'never-synced' : 'unrecognized',
    at,
    ageMs: at ? nowMs - Date.parse(at) : null,
    position,
    detail: at ? 'host last committed a provider sync page at this instant'
      : position ? 'provider cursor is present; its internal shape is opaque'
      : 'no successfully committed provider page is recorded',
    ...(providerSyncProgressIssues(progress).length === 0 && progress.lossRisk ? { lossRisk: progress.lossRisk } : {}),
  };
}

/** The runtime and kit share the same validation of optional sync progress. */
export function providerSyncProgressIssues(page: { catchUp?: unknown; lossRisk?: unknown }): string[] {
  const issues: string[] = [];
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (page.catchUp !== undefined) {
    const progress = page.catchUp;
    if (!object(progress)) issues.push('catchUp must be an object');
    else {
      if (!['cold-start', 'cursor-replay', 'backfill', 'live-only'].includes(String(progress.path))) {
        issues.push('catchUp.path must name a supported reconciliation path');
      }
      if (progress.path === 'backfill') {
        if (!['cursor-expired', 'cursor-rejected', 'no-replay-supported'].includes(String(progress.reason))) {
          issues.push('catchUp.reason must explain a backfill');
        }
      } else if (progress.reason !== undefined) issues.push('catchUp.reason is only valid for backfill');
    }
  }
  if (page.lossRisk !== undefined) {
    const loss = page.lossRisk;
    if (!object(loss)) issues.push('lossRisk must be an object');
    else {
      if (!['retention-window-exceeded', 'capped-window-overflow'].includes(String(loss.kind))) {
        issues.push('lossRisk.kind must name a retention or capped-window gap');
      }
      if (typeof loss.oldestReachableAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(loss.oldestReachableAt)
        || !Number.isFinite(Date.parse(loss.oldestReachableAt))) {
        issues.push('lossRisk.oldestReachableAt must be an ISO-8601 instant');
      }
      if (typeof loss.detail !== 'string' || loss.detail.trim() === '' || loss.detail.length > 2000) {
        issues.push('lossRisk.detail must be non-empty and at most 2000 characters');
      }
    }
  }
  return issues;
}

/**
 * One completely read window of a container (WI-6554700010012278). Without `threadRef` it covers
 * the container's objects that sit outside any thread; with it, the whole thread, root included.
 * `from`/`to` bound the window by the object's post time (inclusive); omit them for no bound.
 */
export interface ProviderCoverage {
  /** One of the descriptor's declared datatypes. */
  datatype: string;
  /** The container read; for chat, the channel. Matches {@link PROVIDER_ACL_REF_PATTERN}. */
  containerRef: string;
  /** The thread read, when the window is one thread. */
  threadRef?: string;
  /** ISO-8601 lower bound of the window (inclusive). */
  from?: string;
  /** ISO-8601 upper bound of the window (inclusive). */
  to?: string;
  /** The native id of every live object in the window. Anything else stored there was deleted. */
  nativeIds: string[];
}

/**
 * Why a page's `coverage` is unusable, or [] when it is well formed. The host's connector runtime
 * and the conformance kit both validate coverage through this one function.
 */
export function providerCoverageIssues(coverage: unknown, datatypes: readonly string[]): string[] {
  if (coverage === undefined) return [];
  if (!Array.isArray(coverage)) return ['coverage must be an array'];
  const issues: string[] = [];
  const isTime = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
  coverage.forEach((entry: Partial<ProviderCoverage> | null, index) => {
    const at = `coverage[${index}]`;
    if (!entry || typeof entry !== 'object') {
      issues.push(`${at} must be an object`);
      return;
    }
    if (typeof entry.datatype !== 'string' || !datatypes.includes(entry.datatype)) {
      issues.push(`${at}.datatype must be one of the descriptor's datatypes`);
    }
    if (typeof entry.containerRef !== 'string' || !PROVIDER_ACL_REF_PATTERN.test(entry.containerRef)) {
      issues.push(`${at}.containerRef must match ${PROVIDER_ACL_REF_PATTERN}`);
    }
    if (entry.threadRef !== undefined && (typeof entry.threadRef !== 'string' || entry.threadRef.trim() === '')) {
      issues.push(`${at}.threadRef must be a non-empty string`);
    }
    for (const bound of ['from', 'to'] as const) {
      if (entry[bound] !== undefined && !isTime(entry[bound])) issues.push(`${at}.${bound} must be an ISO-8601 time`);
    }
    if (isTime(entry.from) && isTime(entry.to) && Date.parse(entry.from!) > Date.parse(entry.to!)) {
      issues.push(`${at}.from must not be after ${at}.to`);
    }
    if (!Array.isArray(entry.nativeIds) || !entry.nativeIds.every((id) => typeof id === 'string' && id !== '')) {
      issues.push(`${at}.nativeIds must be an array of non-empty native ids`);
    }
  });
  return issues;
}

/** Signals the host interprets; a provider throws or returns these instead of retrying itself. */
export type ProviderSyncError =
  | { kind: 'cursor-expired'; message: string }
  | { kind: 'rate-limited'; retryAfterSeconds?: number; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'transient'; message: string };

/** The four {@link ProviderSyncError} kinds, in the order the host documents them. */
export const PROVIDER_SYNC_ERROR_KINDS = ['cursor-expired', 'rate-limited', 'auth', 'transient'] as const;

/**
 * Read a {@link ProviderSyncError} out of whatever a provider threw: the error object itself, an
 * `Error` carrying a `kind`, or a daemon JSON-RPC error carrying one in `data`. Returns null when
 * nothing recognisable was thrown; the host treats that as `transient`. The host's connector
 * runtime and the provider conformance kit both read errors through this one function, so a
 * package that passes the kit is read the same way in production.
 */
export function providerSyncErrorOf(cause: unknown): ProviderSyncError | null {
  const candidates = [cause, (cause as { data?: unknown } | null)?.data];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const kind = (candidate as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !(PROVIDER_SYNC_ERROR_KINDS as readonly string[]).includes(kind)) continue;
    const message = String((candidate as { message?: unknown }).message ?? (cause as { message?: unknown })?.message ?? kind);
    if (kind === 'rate-limited') {
      const retry = Number((candidate as { retryAfterSeconds?: unknown }).retryAfterSeconds);
      return Number.isFinite(retry) && retry >= 0 ? { kind, retryAfterSeconds: retry, message } : { kind, message };
    }
    return { kind: kind as 'cursor-expired' | 'auth' | 'transient', message };
  }
  return null;
}

/**
 * Social write capabilities (provider-adapters-to-packages-2026-10-11 P-002). The host runs its
 * rails (destination trust, disclosure, the registry write gate, the publish flag) BEFORE it
 * invokes one of these, so a package only performs the platform call.
 */
export const PROVIDER_SOCIAL_POST_CAPABILITY = 'social.post';
export const PROVIDER_SOCIAL_REPLY_CAPABILITY = 'social.reply';
export const PROVIDER_SOCIAL_DELETE_CAPABILITY = 'social.delete';

/** Result of `social.post` and `social.reply`: the platform id of the created post. */
export interface ProviderSocialWriteResult {
  externalId: string;
  /** Public permalink, when the platform returns or documents one. */
  url?: string;
}

/** Result of `social.delete`. `deleted:false` means the platform reported nothing to delete. */
export interface ProviderSocialDeleteResult {
  deleted: boolean;
  detail?: string;
}

/** Why `value` is not a {@link ProviderSocialWriteResult}, or null when it is one. */
export function providerSocialWriteResultIssue(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'result must be an object';
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.externalId)) return 'externalId must be a non-empty string';
  if (v.url !== undefined && !isHttpsUrl(v.url)) return 'url, when present, must be an https URL';
  return null;
}

/** Why `value` is not a {@link ProviderSocialDeleteResult}, or null when it is one. */
export function providerSocialDeleteResultIssue(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'result must be an object';
  const v = value as Record<string, unknown>;
  if (typeof v.deleted !== 'boolean') return 'deleted must be a boolean';
  if (v.detail !== undefined && typeof v.detail !== 'string') return 'detail, when present, must be a string';
  return null;
}

export interface ProviderInvokeRequest {
  source: string;
  capability: string;
  args: Record<string, unknown>;
  /**
   * The source's config, as `syncPage` receives it, when the host invokes on behalf of a data
   * source (record write-back). A write may need it to map a canonical value onto the source's own
   * vocabulary (Asana: which section is the `in-progress` column).
   */
  config?: Record<string, unknown>;
  /** Parameters of the descriptor's configured service credentials (D-018.1). */
  services?: ProviderServices;
}

export interface HostFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** UTF-8 body. Binary payloads are base64 with `bodyEncoding: 'base64'`. */
  body?: string;
  bodyEncoding?: 'utf8' | 'base64';
}

export interface HostFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
}

/** The only network path a provider has. The host enforces egress and injects the source's token. */
export type HostFetch = (input: { source: string; request: HostFetchRequest }) => Promise<HostFetchResponse>;

export interface ProviderHost {
  fetch: HostFetch;
}

/** Adapter a provider plugin implements. All three methods are request/response. */
export interface ProviderAdapter {
  describe(): ProviderDescriptor | Promise<ProviderDescriptor>;
  syncPage(request: ProviderSyncRequest, host: ProviderHost): Promise<ProviderSyncPage>;
  invoke(request: ProviderInvokeRequest, host: ProviderHost): Promise<unknown>;
}

/**
 * JSON-RPC wire protocol between the host and a `daemon` provider (D-006).
 * Newline-delimited JSON-RPC 2.0 on the daemon's stdin/stdout.
 *
 * host→daemon: `describe` (no params) → ProviderDescriptor;
 *   `syncPage` / `invoke` with {@link ProviderDaemonCallParams}.
 * daemon→host: `hostFetch` with {@link ProviderDaemonFetchParams} →
 *   HostFetchResponse. The `callToken` is valid only while the host call that
 *   issued it is in flight, and only for that call's `source`; the host
 *   injects the credential, so the daemon never sees a token.
 * The daemon must also answer `papercup.ping` (supervisor health check).
 */
export const PROVIDER_DAEMON_METHODS = {
  describe: 'provider.describe',
  syncPage: 'provider.syncPage',
  invoke: 'provider.invoke',
  hostFetch: 'host.fetch',
} as const;

export interface ProviderDaemonCallParams<R = ProviderSyncRequest | ProviderInvokeRequest> {
  request: R;
  callToken: string;
}

export interface ProviderDaemonFetchParams {
  callToken: string;
  source: string;
  request: HostFetchRequest;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpsUrl(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
  } catch {
    return false;
  }
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dups.add(value);
    seen.add(value);
  }
  return [...dups];
}

/** True when `host` is allowed by one of the descriptor's egress patterns. */
export function providerEgressAllows(egressHosts: readonly string[], host: string): boolean {
  const target = host.toLowerCase();
  return egressHosts.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === p;
  });
}

/**
 * Semantic validation of a provider descriptor. Returns a list of issues (empty = valid).
 * The JSON schema enforces shape; this enforces identity, version and value rules.
 */
export function normalizeProviderInstanceOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || /[\\\s]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
    host.length > 253 || !PROVIDER_EGRESS_HOST_PATTERN.test(host) || host.startsWith('*.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)) return null;
  return url.origin;
}

/** An instance endpoint cannot name a second origin, scheme or fragment. */
export function providerInstanceEndpointIssue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\s#]/.test(value)) {
    return 'must be an absolute-path reference without a host, whitespace, backslash or fragment';
  }
  return null;
}

/** A descriptor bound by the host to one saved instance registration. The original stays pure data. */
export function bindProviderInstance(descriptor: ProviderDescriptor, value: unknown): ProviderDescriptor {
  if (!descriptor.oauth?.instance) return descriptor;
  const origin = normalizeProviderInstanceOrigin(value);
  if (!origin) throw new Error('provider_instance_origin_invalid');
  const { instance: _instance, ...oauth } = descriptor.oauth;
  const endpoint = (path: string): string => {
    if (providerInstanceEndpointIssue(path)) throw new Error('provider_instance_endpoint_invalid');
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error('provider_instance_endpoint_invalid');
    return url.href;
  };
  if (descriptor.egressHosts.length || oauth.resourceToken) throw new Error('provider_instance_static_egress_refused');
  return {
    ...descriptor,
    egressHosts: [new URL(origin).hostname],
    ...(descriptor.setup?.appRegistration?.createUrl.startsWith('/') ? { setup: { ...descriptor.setup,
      appRegistration: { ...descriptor.setup.appRegistration, createUrl: endpoint(descriptor.setup.appRegistration.createUrl) },
    } } : {}),
    oauth: { ...oauth, authorizeUrl: endpoint(oauth.authorizeUrl), tokenUrl: endpoint(oauth.tokenUrl),
      ...(oauth.identity ? { identity: { ...oauth.identity, url: endpoint(oauth.identity.url) } } : {}),
    },
  };
}

/** The source's persisted connection origin is the whole egress budget for an instance grant. */
export function providerSourceEgressAllows(
  descriptor: Pick<ProviderDescriptor, 'oauth' | 'egressHosts'>,
  url: URL,
  config?: Record<string, unknown>,
): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (!descriptor.oauth?.instance) return providerEgressAllows(descriptor.egressHosts, url.hostname);
  const origin = normalizeProviderInstanceOrigin(config?.connectionOrigin);
  return origin !== null && url.origin === origin;
}

export function validateProviderDescriptor(descriptor: unknown): string[] {
  const issues: string[] = [];
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return ['provider descriptor must be an object'];
  }
  const d = descriptor as Partial<ProviderDescriptor>;
  if (!isNonEmptyString(d.id) || !PROVIDER_ID_PATTERN.test(d.id)) {
    issues.push(`provider.id must match ${PROVIDER_ID_PATTERN}`);
  }
  if (!PROVIDER_CONTRACT_VERSIONS.includes(d.contractVersion as ProviderContractVersion)) {
    issues.push(
      `provider.contractVersion ${String(d.contractVersion)} is unsupported (supported: ${PROVIDER_CONTRACT_VERSIONS.join(', ')})`,
    );
  }
  const datatypes = Array.isArray(d.datatypes) ? d.datatypes : [];
  if (datatypes.length === 0) issues.push('provider.datatypes must declare at least one canonical datatype');
  for (const datatype of datatypes) {
    if (!isNonEmptyString(datatype) || !PROVIDER_DATATYPE_PATTERN.test(datatype)) {
      issues.push(`provider.datatypes entry "${String(datatype)}" is not a canonical datatype id`);
    }
  }
  for (const dup of duplicates(datatypes.filter(isNonEmptyString))) issues.push(`provider.datatypes repeats "${dup}"`);
  if (d.sync !== undefined && typeof d.sync !== 'boolean') issues.push('provider.sync must be a boolean');
  const capabilities = Array.isArray(d.capabilities) ? d.capabilities : [];
  for (const capability of capabilities) {
    if (!isNonEmptyString(capability) || !PROVIDER_CAPABILITY_PATTERN.test(capability)) {
      issues.push(`provider.capabilities entry "${String(capability)}" must be <domain>.<verb>`);
    }
  }
  for (const dup of duplicates(capabilities.filter(isNonEmptyString))) issues.push(`provider.capabilities repeats "${dup}"`);
  if (d.verification !== undefined) issues.push(...providerVerificationIssues(d.verification, capabilities));
  if (d.rateBudget !== undefined) issues.push(...providerRateBudgetIssues(d.rateBudget));
  const egress = Array.isArray(d.egressHosts) ? d.egressHosts : [];
  if (egress.length === 0 && d.oauth?.instance !== true) issues.push('provider.egressHosts must declare at least one host');
  if (d.oauth?.instance === true && egress.length !== 0) issues.push('provider.egressHosts must be empty for an instance-scoped OAuth grant');
  for (const host of egress) {
    if (!isNonEmptyString(host) || !PROVIDER_EGRESS_HOST_PATTERN.test(host.toLowerCase())) {
      issues.push(`provider.egressHosts entry "${String(host)}" must be a hostname or *.domain`);
    }
  }
  if (d.oauth !== undefined) {
    const oauth = d.oauth as Partial<ProviderOAuthDescriptor>;
    if (oauth.userAgentRequired !== undefined && oauth.userAgentRequired !== true) issues.push('provider.oauth.userAgentRequired must be true when present');
    if (oauth.instance !== undefined && oauth.instance !== true) issues.push('provider.oauth.instance must be true when present');
    const endpointIssue = (url: unknown) => oauth.instance === true ? providerInstanceEndpointIssue(url) : isHttpsUrl(url) ? null : 'must be an https URL';
    for (const key of ['authorizeUrl', 'tokenUrl'] as const) {
      const issue = endpointIssue(oauth[key]);
      if (issue) issues.push(`provider.oauth.${key} ${issue}`);
    }
    if (oauth.instance && oauth.resourceToken) issues.push('provider.oauth.resourceToken is not supported with instance-scoped OAuth');
    if (!Array.isArray(oauth.scopes) || !oauth.scopes.every(isNonEmptyString)) {
      issues.push('provider.oauth.scopes must be a list of scope strings');
    }
    if (oauth.scopeSeparator !== undefined && oauth.scopeSeparator !== ' ' && oauth.scopeSeparator !== ',') {
      issues.push('provider.oauth.scopeSeparator must be " " or ","');
    }
    if (oauth.clientIdParameter !== undefined && oauth.clientIdParameter !== 'client_id' && oauth.clientIdParameter !== 'client_key') {
      issues.push('provider.oauth.clientIdParameter must be client_id or client_key');
    }
    if (oauth.tokenEndpointAuthMethod !== undefined && !['client_secret_post', 'client_secret_basic'].includes(oauth.tokenEndpointAuthMethod)) {
      issues.push('provider.oauth.tokenEndpointAuthMethod must be client_secret_post or client_secret_basic');
    }
    if (oauth.refreshPolicy !== undefined && oauth.refreshPolicy !== 'refresh-token' && oauth.refreshPolicy !== 'reauthorize') {
      issues.push('provider.oauth.refreshPolicy must be refresh-token or reauthorize');
    }
    for (const key of Object.keys(oauth)) {
      if (/secret/i.test(key)) issues.push(`provider.oauth.${key} must not carry a secret; use clientRegistrationRef`);
    }
    if (oauth.identity !== undefined) {
      const identity = oauth.identity as Partial<ProviderOAuthIdentity>;
      const issue = endpointIssue(identity.url);
      if (issue) issues.push(`provider.oauth.identity.url ${issue}`);
      if (!isNonEmptyString(identity.idField)) issues.push('provider.oauth.identity.idField must name the account id field');
      if (identity.method !== undefined && identity.method !== 'GET' && identity.method !== 'POST') {
        issues.push('provider.oauth.identity.method must be GET or POST');
      }
      if (identity.body !== undefined) {
        if (identity.method !== 'POST') issues.push('provider.oauth.identity.body needs method POST');
        let parsed = false;
        try {
          JSON.parse(String(identity.body));
          parsed = typeof identity.body === 'string';
        } catch {
          parsed = false;
        }
        if (!parsed) issues.push('provider.oauth.identity.body must be a JSON string');
      }
    }
    if (oauth.resourceToken !== undefined) {
      const exchange: Partial<ProviderOAuthResourceToken> = oauth.resourceToken &&
        typeof oauth.resourceToken === 'object' && !Array.isArray(oauth.resourceToken) ? oauth.resourceToken : {};
      if (!isHttpsUrl(exchange.url)) issues.push('provider.oauth.resourceToken.url must be an https URL');
      else {
        const endpoint = new URL(exchange.url!);
        if (endpoint.username || endpoint.password || endpoint.hash) {
          issues.push('provider.oauth.resourceToken.url must not contain credentials or a fragment');
        }
      }
      if (!Array.isArray(exchange.hosts) || exchange.hosts.length === 0 ||
        exchange.hosts.some((host) => !isNonEmptyString(host) || host.includes('*') || host !== host.toLowerCase() ||
          !providerEgressAllows(egress.filter(isNonEmptyString), host))) {
        issues.push('provider.oauth.resourceToken.hosts must be nonempty and inside provider.egressHosts');
      }
      const path = (value: unknown) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(value) &&
        !value.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part));
      for (const key of ['collectionField', 'idField', 'tokenField', 'configKey'] as const) {
        if (!path(exchange[key]) || (key === 'configKey' && exchange[key]?.includes('.'))) {
          issues.push(`provider.oauth.resourceToken.${key} must name a field`);
        }
      }
      if (exchange.nextUrlField !== undefined && !path(exchange.nextUrlField)) {
        issues.push('provider.oauth.resourceToken.nextUrlField must name a field');
      }
      if (exchange.permissions !== undefined && (!path(exchange.permissions?.field) ||
        !Array.isArray(exchange.permissions?.required) || exchange.permissions.required.length === 0 ||
        !exchange.permissions.required.every(isNonEmptyString))) {
        issues.push('provider.oauth.resourceToken.permissions must name a field and required permissions');
      }
    }
    for (const url of [oauth.authorizeUrl, oauth.tokenUrl, oauth.identity?.url, oauth.resourceToken?.url]) {
      if (!isHttpsUrl(url)) continue;
      const host = new URL(url as string).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && !providerEgressAllows(egress.filter(isNonEmptyString), host)) {
        issues.push(`provider.oauth endpoint host "${host}" is not in provider.egressHosts`);
      }
    }
  }
  if (d.configSchema !== undefined && (typeof d.configSchema !== 'object' || d.configSchema === null || Array.isArray(d.configSchema))) {
    issues.push('provider.configSchema must be a JSON Schema object');
  }
  if (d.defaultDestinations !== undefined) {
    const defaults = d.defaultDestinations as unknown;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
      issues.push('provider.defaultDestinations must map datatypes to destination lists');
    } else {
      for (const [datatype, destinations] of Object.entries(defaults as Record<string, unknown>)) {
        if (!datatypes.includes(datatype)) {
          issues.push(`provider.defaultDestinations key "${datatype}" is not one of provider.datatypes`);
        }
        const list = Array.isArray(destinations) ? destinations : [];
        if (list.length === 0) issues.push(`provider.defaultDestinations.${datatype} must list at least one destination`);
        for (const destination of list) {
          if (!(PROVIDER_DESTINATIONS as readonly unknown[]).includes(destination)) {
            issues.push(`provider.defaultDestinations.${datatype} entry "${String(destination)}" must be one of ${PROVIDER_DESTINATIONS.join(', ')}`);
          }
        }
        for (const dup of duplicates(list.filter(isNonEmptyString))) {
          issues.push(`provider.defaultDestinations.${datatype} repeats "${dup}"`);
        }
      }
    }
  }
  if (d.serviceCredentials !== undefined) {
    if (!Array.isArray(d.serviceCredentials)) {
      issues.push('provider.serviceCredentials must be a list of { ref, hosts }');
    } else {
      for (const [index, entry] of d.serviceCredentials.entries()) {
        const credential = (entry ?? {}) as Partial<ProviderServiceCredential>;
        if (!isNonEmptyString(credential.ref) || !PROVIDER_ID_PATTERN.test(credential.ref)) {
          issues.push(`provider.serviceCredentials[${index}].ref must be a lowercase credential reference`);
        }
        if (!Array.isArray(credential.hosts) || credential.hosts.length === 0) {
          issues.push(`provider.serviceCredentials[${index}].hosts must list at least one host`);
          continue;
        }
        for (const host of credential.hosts) {
          if (!isNonEmptyString(host) || !PROVIDER_EGRESS_HOST_PATTERN.test(host)) {
            issues.push(`provider.serviceCredentials[${index}].hosts entry '${String(host)}' is not a hostname`);
          } else if (!egress.includes(host)) {
            issues.push(`provider.serviceCredentials[${index}] host '${host}' is not in provider.egressHosts`);
          }
        }
      }
    }
  }
  if (d.push !== undefined) issues.push(...pushDescriptorIssues(d.push, capabilities.filter(isNonEmptyString), d));
  if (d.setup !== undefined) {
    const serviceHosts = (Array.isArray(d.serviceCredentials) ? d.serviceCredentials : []).flatMap((c) =>
      Array.isArray(c?.hosts) ? c.hosts.filter(isNonEmptyString) : [],
    );
    issues.push(...setupDescriptorIssues(d.setup, egress.filter(isNonEmptyString), serviceHosts, d.oauth?.instance === true));
  }
  if (d.ingress !== undefined) {
    const fields = (Array.isArray(d.setup?.credentials) ? d.setup.credentials : [])
      .filter((field): field is ProviderCredentialField => !!field && typeof field === 'object');
    const credentialKeys = fields.map((field) => field.key).filter(isNonEmptyString);
    const principalCredentialKeys = fields.filter((field) => field.perPrincipal === true).map((field) => field.key).filter(isNonEmptyString);
    issues.push(...ingressDescriptorIssues(
      d.ingress,
      capabilities.filter(isNonEmptyString),
      egress.filter(isNonEmptyString),
      credentialKeys,
      principalCredentialKeys,
    ));
  }
  if (d.membership !== undefined) {
    const membership = d.membership as unknown;
    const identityProvider = membership && typeof membership === 'object' && !Array.isArray(membership)
      ? (membership as { identityProvider?: unknown }).identityProvider
      : undefined;
    if (!isNonEmptyString(identityProvider) || !PROVIDER_ID_PATTERN.test(identityProvider)) {
      issues.push(`provider.membership.identityProvider must match ${PROVIDER_ID_PATTERN}`);
    }
    const containers = membership && typeof membership === 'object' ? (membership as { containers?: unknown }).containers : undefined;
    if (containers !== undefined && typeof containers !== 'boolean') {
      issues.push('provider.membership.containers must be true or false');
    }
  }
  return issues;
}

function pushDescriptorIssues(push: unknown, capabilities: string[], descriptor: Partial<ProviderDescriptor>): string[] {
  if (!push || typeof push !== 'object' || Array.isArray(push)) return ['provider.push must be an object'];
  const p = push as Partial<ProviderPushDescriptor>;
  const issues: string[] = [];
  const header = (value: unknown) => isNonEmptyString(value) && PROVIDER_PUSH_HEADER_PATTERN.test(value);
  const signature = (p.signature ?? {}) as Partial<ProviderPushDescriptor['signature']>;
  if (!header(signature.header)) issues.push('provider.push.signature.header must be a lowercase header name');
  if (signature.algorithm !== 'hmac-sha256') issues.push('provider.push.signature.algorithm must be hmac-sha256');
  if (signature.encoding !== 'hex') issues.push('provider.push.signature.encoding must be hex');
  if (signature.prefix !== undefined && (typeof signature.prefix !== 'string' || !/^[A-Za-z0-9=_-]{1,32}$/.test(signature.prefix))) issues.push('provider.push.signature.prefix must be a short literal prefix');
  if (signature.oauthClientSecret !== undefined && typeof signature.oauthClientSecret !== 'boolean') issues.push('provider.push.signature.oauthClientSecret must be true or false');
  if (signature.oauthClientSecret === true && (!descriptor.oauth || p.handshake)) issues.push('provider.push.signature.oauthClientSecret needs OAuth and cannot use a handshake');
  if (p.delivery !== undefined && !['wake', 'normalize'].includes(p.delivery)) issues.push('provider.push.delivery must be wake or normalize');
  if (p.delivery === 'normalize' && !capabilities.includes(PROVIDER_INGRESS_NORMALIZE_CAPABILITY)) issues.push('provider.push.delivery normalize needs capability ingress.normalize');
  if (p.verification !== undefined) {
    const v = p.verification;
    for (const key of ['modeParam', 'tokenParam', 'challengeParam'] as const) {
      if (typeof v?.[key] !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(v[key])) issues.push(`provider.push.verification.${key} must be a query parameter name`);
    }
    if (!isNonEmptyString(v?.modeValue) || v.modeValue.length > 100) issues.push('provider.push.verification.modeValue must be a short string');
    if (new Set([v?.modeParam, v?.tokenParam, v?.challengeParam]).size !== 3) issues.push('provider.push.verification parameter names must differ');
    const fields = descriptor.setup?.credentials;
    if (!Array.isArray(fields) || !fields.some((field) => field?.key === v?.credentialRef && !field.perPrincipal)) issues.push('provider.push.verification.credentialRef must name a host-held setup credential');
  }
  if (p.handshake !== undefined) {
    if (!header((p.handshake as { header?: unknown } | null)?.header)) {
      issues.push('provider.push.handshake.header must be a lowercase header name');
    } else if (p.handshake.header === signature.header) {
      issues.push('provider.push.handshake.header must differ from provider.push.signature.header');
    }
    // A handshake secret only ever arrives while the host is creating a subscription.
    for (const required of [PROVIDER_PUSH_SUBSCRIBE_CAPABILITY, PROVIDER_PUSH_UNSUBSCRIBE_CAPABILITY]) {
      if (!capabilities.includes(required)) issues.push(`provider.push.handshake needs capability ${required}`);
    }
  }
  return issues;
}

function ingressDescriptorIssues(
  ingress: unknown,
  capabilities: string[],
  egress: string[],
  credentialKeys: string[],
  principalCredentialKeys: string[] = [],
): string[] {
  if (!ingress || typeof ingress !== 'object' || Array.isArray(ingress)) return ['provider.ingress must be an object'];
  const issues: string[] = [];
  for (const key of Object.keys(ingress)) {
    if (key !== 'socket') issues.push(`provider.ingress.${key} is not a known ingress kind (known: socket)`);
  }
  const socket = (ingress as { socket?: unknown }).socket;
  const at = 'provider.ingress.socket';
  if (!socket || typeof socket !== 'object' || Array.isArray(socket)) {
    issues.push(`${at} must be an object`);
    return issues;
  }
  const s = socket as Partial<ProviderSocketIngressDescriptor> & Record<string, unknown>;
  // Published to the Cupboard: names the credential, never carries it.
  for (const forbidden of ['token', 'secret', 'value', 'appToken']) {
    if (forbidden in s) issues.push(`${at}.${forbidden} is not allowed: a descriptor never carries a credential value`);
  }
  if (!isNonEmptyString(s.credential)) {
    issues.push(`${at}.credential must name a provider.setup.credentials key`);
  } else if (!credentialKeys.includes(s.credential)) {
    issues.push(`${at}.credential '${s.credential}' is not a provider.setup.credentials key`);
  } else if (principalCredentialKeys.includes(s.credential)) {
    issues.push(`${at}.credential '${s.credential}' is a per-person credential; the host's connection needs the source's own`);
  }
  const open = s.open as Partial<ProviderSocketIngressDescriptor['open']> | undefined;
  if (!open || typeof open !== 'object' || Array.isArray(open)) {
    issues.push(`${at}.open must be an object`);
  } else {
    if (!isHttpsUrl(open.url)) {
      issues.push(`${at}.open.url must be an https URL`);
    } else {
      const host = new URL(open.url as string).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && !providerEgressAllows(egress, host)) {
        issues.push(`${at}.open.url host '${host}' is not in provider.egressHosts`);
      }
    }
    if (open.method !== undefined && open.method !== 'GET' && open.method !== 'POST') {
      issues.push(`${at}.open.method must be GET or POST`);
    }
    if (!isNonEmptyString(open.urlField) || !PROVIDER_INGRESS_PATH_PATTERN.test(open.urlField)) {
      issues.push(`${at}.open.urlField must be a dot path to the socket URL in the response`);
    }
  }
  if (s.ackField !== undefined && (!isNonEmptyString(s.ackField) || !PROVIDER_INGRESS_FIELD_PATTERN.test(s.ackField))) {
    issues.push(`${at}.ackField must be a top-level envelope field name`);
  }
  for (const key of ['reconnect', 'immediate'] as const) {
    if (s[key] === undefined) continue;
    const match = s[key] as Partial<ProviderSocketEnvelopeMatch> | null;
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      issues.push(`${at}.${key} must be an object`);
      continue;
    }
    if (!isNonEmptyString(match.field) || !PROVIDER_INGRESS_FIELD_PATTERN.test(match.field)) {
      issues.push(`${at}.${key}.field must be a top-level envelope field name`);
    }
    const values = Array.isArray(match.values) ? match.values : [];
    if (values.length === 0 || !values.every(isNonEmptyString)) {
      issues.push(`${at}.${key}.values must list at least one value`);
    }
    for (const dup of duplicates(values.filter(isNonEmptyString))) issues.push(`${at}.${key}.values repeats "${dup}"`);
  }
  if (!capabilities.includes(PROVIDER_INGRESS_NORMALIZE_CAPABILITY)) {
    issues.push(`${at} needs capability ${PROVIDER_INGRESS_NORMALIZE_CAPABILITY}`);
  }
  return issues;
}

function setupDescriptorIssues(setup: unknown, egress: string[], serviceHosts: string[], instance = false): string[] {
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return ['provider.setup must be an object'];
  const s = setup as Partial<ProviderSetupDescriptor>;
  return [
    ...(s.appRegistration === undefined ? [] : appRegistrationIssues(s.appRegistration, instance)),
    ...(s.credentials === undefined ? [] : credentialFieldIssues(s.credentials, egress, serviceHosts)),
    ...(s.session === undefined ? [] : credentialSessionIssues(s.session, s.credentials, egress, serviceHosts)),
  ];
}

function credentialSessionIssues(raw: unknown, fields: unknown, egress: string[], serviceHosts: string[]): string[] {
  const at = 'provider.setup.session';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [`${at} must be an object`];
  const s = raw as Partial<ProviderCredentialSessionDescriptor>;
  const issues: string[] = [];
  const path = (v: unknown): v is string => typeof v === 'string' && PROVIDER_INGRESS_PATH_PATTERN.test(v) &&
    !v.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part));
  const credentials = (Array.isArray(fields) ? fields : []).filter((f): f is ProviderCredentialField => !!f && typeof f === 'object');
  const hosts = Array.isArray(s.hosts) ? s.hosts : [];
  if (!hosts.length) issues.push(`${at}.hosts must list at least one host`);
  for (const host of hosts) {
    if (typeof host !== 'string' || host.startsWith('*.') || !PROVIDER_EGRESS_HOST_PATTERN.test(host) || !providerEgressAllows(egress, host)) {
      issues.push(`${at}.hosts must be exact hosts in provider.egressHosts`);
    }
    if (serviceHosts.includes(host) || credentials.some((f) => f.hosts?.includes(host))) {
      issues.push(`${at}.hosts cannot overlap another credential`);
    }
  }
  for (const key of ['url', 'refreshUrl'] as const) {
    if (!isHttpsUrl(s[key])) { issues.push(`${at}.${key} must be an https URL`); continue; }
    const url = new URL(s[key]!);
    if (url.username || url.password || url.port || url.search || url.hash || !hosts.includes(url.hostname)) {
      issues.push(`${at}.${key} must be a credential-free endpoint on a session host`);
    }
  }
  if (isHttpsUrl(s.url) && isHttpsUrl(s.refreshUrl) && new URL(s.url!).origin !== new URL(s.refreshUrl!).origin) {
    issues.push(`${at}.refreshUrl must use the login origin`);
  }
  const parameters = s.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || !Object.keys(parameters).length) {
    issues.push(`${at}.parameters must map request parameters to credential keys`);
  } else for (const [parameter, key] of Object.entries(parameters)) {
    if (!path(parameter) || parameter.includes('.') || !credentials.some((f) => f.key === key && !f.perPrincipal)) {
      issues.push(`${at}.parameters must reference declared source credential keys`);
    }
  }
  for (const key of ['accessTokenField', 'refreshTokenField'] as const) {
    if (!path(s[key])) issues.push(`${at}.${key} must be a safe JSON field path`);
  }
  if (s.activeField !== undefined && !path(s.activeField)) issues.push(`${at}.activeField must be a safe JSON field path`);
  if (s.accessTokenField === s.refreshTokenField) issues.push(`${at} access and refresh fields must differ`);
  if (!Number.isInteger(s.maxAgeSeconds) || s.maxAgeSeconds! < 60 || s.maxAgeSeconds! > 86400) {
    issues.push(`${at}.maxAgeSeconds must be an integer from 60 to 86400`);
  }
  if (!s.identity || !path(s.identity.idField) || (s.identity.displayNameField !== undefined && !path(s.identity.displayNameField))) {
    issues.push(`${at}.identity must name safe public identity fields`);
  }
  const secretPaths = [s.accessTokenField, s.refreshTokenField];
  if (s.identity?.credentialKey !== undefined && !credentials.some((f) => f.key === s.identity!.credentialKey && !f.perPrincipal)) {
    issues.push(`${at}.identity.credentialKey must name a declared source credential`);
  }
  if (secretPaths.includes(s.identity?.idField) || (s.identity?.displayNameField && secretPaths.includes(s.identity.displayNameField))) {
    issues.push(`${at}.identity cannot expose a token field`);
  }
  return issues;
}

function appRegistrationIssues(registration: unknown, instance = false): string[] {
  const at = 'provider.setup.appRegistration';
  if (!registration || typeof registration !== 'object' || Array.isArray(registration)) return [`${at} must be an object`];
  const r = registration as Partial<ProviderAppRegistration> & Record<string, unknown>;
  const issues: string[] = [];
  for (const forbidden of ['clientSecret', 'secret', 'token', 'signingSecret']) {
    if (forbidden in r) issues.push(`${at}.${forbidden} is not allowed: a descriptor never carries a credential value`);
  }
  const createUrl = r.createUrl;
  const relative = instance && typeof createUrl === 'string' && createUrl.startsWith('/') && providerInstanceEndpointIssue(createUrl) === null;
  if (typeof createUrl !== 'string' || (!isHttpsUrl(createUrl) && !relative)) {
    issues.push(`${at}.createUrl must be an https URL`);
  } else {
    const placeholders: string[] = createUrl.match(/\{[^}]*\}/g) ?? [];
    for (const placeholder of placeholders) {
      if (placeholder !== PROVIDER_APP_DEFINITION_PLACEHOLDER) {
        issues.push(`${at}.createUrl placeholder '${placeholder}' is unknown; only ${PROVIDER_APP_DEFINITION_PLACEHOLDER} is filled in`);
      }
    }
    if (placeholders.includes(PROVIDER_APP_DEFINITION_PLACEHOLDER) && r.definition === undefined) {
      issues.push(`${at}.createUrl uses ${PROVIDER_APP_DEFINITION_PLACEHOLDER} but no definition is declared`);
    }
  }
  if (r.definition !== undefined) {
    if (!r.definition || typeof r.definition !== 'object' || Array.isArray(r.definition)) {
      issues.push(`${at}.definition must be a JSON object`);
    } else {
      let text: string | undefined;
      try {
        text = JSON.stringify(r.definition);
      } catch {
        issues.push(`${at}.definition must be serializable as JSON`);
      }
      if (text !== undefined && text.length > PROVIDER_APP_DEFINITION_MAX_LENGTH) {
        issues.push(`${at}.definition is longer than ${PROVIDER_APP_DEFINITION_MAX_LENGTH} characters as JSON`);
      }
    }
  }
  if (r.docsUrl !== undefined && !isHttpsUrl(r.docsUrl)) issues.push(`${at}.docsUrl must be an https URL`);
  if (r.copyHint !== undefined && typeof r.copyHint !== 'string') issues.push(`${at}.copyHint must be a string`);
  return issues;
}

function credentialFieldIssues(credentials: unknown, egress: string[], serviceHosts: string[]): string[] {
  if (!Array.isArray(credentials) || credentials.length === 0) {
    return ['provider.setup.credentials must list at least one field'];
  }
  const issues: string[] = [];
  const keys: string[] = [];
  const claimedHosts = new Map<string, string>();
  // Per-person credentials claim hosts among themselves only: on a call made for a person they
  // take precedence over the source credential for the same host (D-026).
  const claimedPrincipalHosts = new Map<string, string>();
  for (const host of serviceHosts) claimedHosts.set(host.toLowerCase(), 'provider.serviceCredentials');
  for (const [index, entry] of (credentials as unknown[]).entries()) {
    const at = `provider.setup.credentials[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`${at} must be an object`);
      continue;
    }
    const field = entry as Partial<ProviderCredentialField> & Record<string, unknown>;
    // A descriptor is published to the Cupboard; it may describe a secret but never carry one.
    for (const forbidden of ['value', 'default', 'secret', 'token']) {
      if (forbidden in field) issues.push(`${at}.${forbidden} is not allowed: a descriptor never carries a credential value`);
    }
    if (!isNonEmptyString(field.key) || !PROVIDER_CREDENTIAL_KEY_PATTERN.test(field.key)) {
      issues.push(`${at}.key must match ${PROVIDER_CREDENTIAL_KEY_PATTERN}`);
    } else {
      keys.push(field.key);
    }
    if (!isNonEmptyString(field.label)) issues.push(`${at}.label must be a non-empty string`);
    if (field.pattern !== undefined) {
      if (!isNonEmptyString(field.pattern) || field.pattern.length > PROVIDER_CREDENTIAL_PATTERN_MAX_LENGTH) {
        issues.push(`${at}.pattern must be a regular expression of at most ${PROVIDER_CREDENTIAL_PATTERN_MAX_LENGTH} characters`);
      } else {
        try {
          new RegExp(field.pattern);
        } catch {
          issues.push(`${at}.pattern is not a valid regular expression`);
        }
      }
    }
    for (const text of ['help', 'placeholder'] as const) {
      if (field[text] !== undefined && typeof field[text] !== 'string') issues.push(`${at}.${text} must be a string`);
    }
    if (field.helpUrl !== undefined && !isHttpsUrl(field.helpUrl)) issues.push(`${at}.helpUrl must be an https URL`);
    if (field.perPrincipal !== undefined && typeof field.perPrincipal !== 'boolean') {
      issues.push(`${at}.perPrincipal must be true or false`);
    }
    if (field.auth !== undefined) {
      const auth = field.auth;
      if (!auth || typeof auth !== 'object' || Array.isArray(auth) ||
        !['authorization', 'api-key', 'x-api-key'].includes(auth.header) ||
        !PROVIDER_CREDENTIAL_AUTH_SCHEMES.includes(auth.scheme) ||
        Object.keys(auth).some((key) => !['header', 'scheme'].includes(key))) {
        issues.push(`${at}.auth must declare an authentication header and a bearer, raw or bot scheme`);
      }
      if (!Array.isArray(field.hosts) || field.hosts.length === 0) issues.push(`${at}.auth requires hosts`);
    }
    const perPrincipal = field.perPrincipal === true;
    if (perPrincipal && field.hosts === undefined) {
      issues.push(`${at}.perPrincipal needs hosts: a per-person credential is only ever injected into host.fetch`);
    }
    const claims = perPrincipal ? claimedPrincipalHosts : claimedHosts;
    if (field.hosts !== undefined) {
      if (!Array.isArray(field.hosts) || field.hosts.length === 0) {
        issues.push(`${at}.hosts must list at least one host when present`);
        continue;
      }
      for (const host of field.hosts) {
        if (!isNonEmptyString(host) || !PROVIDER_EGRESS_HOST_PATTERN.test(host.toLowerCase()) || host.startsWith('*.')) {
          issues.push(`${at}.hosts entry '${String(host)}' is not a hostname`);
          continue;
        }
        if (!providerEgressAllows(egress, host)) issues.push(`${at} host '${host}' is not in provider.egressHosts`);
        const lower = host.toLowerCase();
        const owner = claims.get(lower);
        // One host, one injected credential: otherwise which token a request carries is ambiguous.
        if (owner) issues.push(`${at} host '${host}' is already given a credential by ${owner}`);
        else claims.set(lower, at);
      }
    }
  }
  for (const dup of duplicates(keys)) issues.push(`provider.setup.credentials repeats key "${dup}"`);
  return issues;
}

/**
 * Option sources (cupboard-distributable-integrations-2026-10-10 P-004, D-005).
 *
 * A workflow setting can take its choices from a connected provider: a trigger-pack `inputs`
 * property declares `x-options: { capability, args? }`, and the host lists the choices by invoking
 * that capability on each connected source whose provider declares it. A capability used this way
 * returns `{ options: [{ value, label, description? }], truncated? }`. The host also reads the
 * established `ticket.containers` result (`containers: [{ id, name }]`, D-014.3), so a ticket
 * provider that already lists its projects serves as an option source unchanged.
 */
export const PROVIDER_OPTIONS_KEY = 'x-options';
export const PROVIDER_OPTIONS_MAX = 1000;

export interface ProviderOptionSource {
  /** Capability that lists the choices, `<domain>.<verb>` (e.g. `chat.channels`, `ticket.containers`). */
  capability: string;
  /** Passed to the capability as `invoke({ args })`. */
  args?: Record<string, unknown>;
}

export interface ProviderOption {
  /** Stored as the setting's value. */
  value: string;
  /** Shown in the dropdown. */
  label: string;
  description?: string;
}

export interface ProviderOptionList {
  options: ProviderOption[];
  /** True when the provider listed only part of the choices (or more than PROVIDER_OPTIONS_MAX). */
  truncated: boolean;
}

/** Problems with one `x-options` declaration; `at` names it in the messages. */
export function providerOptionSourceIssues(source: unknown, at: string): string[] {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [`${at} must be an object`];
  const s = source as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(s)) {
    if (key !== 'capability' && key !== 'args') issues.push(`${at}.${key} is not a known option-source key`);
  }
  if (!isNonEmptyString(s.capability) || !PROVIDER_CAPABILITY_PATTERN.test(s.capability)) {
    issues.push(`${at}.capability must be <domain>.<verb>`);
  }
  if (s.args !== undefined && (!s.args || typeof s.args !== 'object' || Array.isArray(s.args))) {
    issues.push(`${at}.args must be an object`);
  }
  return issues;
}

/** The option source a JSON-schema property declares, or null (malformed declarations included). */
export function providerOptionSourceOf(property: unknown): ProviderOptionSource | null {
  if (!property || typeof property !== 'object' || Array.isArray(property)) return null;
  const source = (property as Record<string, unknown>)[PROVIDER_OPTIONS_KEY];
  if (providerOptionSourceIssues(source, PROVIDER_OPTIONS_KEY).length > 0) return null;
  const s = source as { capability: string; args?: Record<string, unknown> };
  return s.args === undefined ? { capability: s.capability } : { capability: s.capability, args: s.args };
}

/** A capability result kept to the documented option shape; malformed and repeated entries are dropped. */
export function normalizeProviderOptions(raw: unknown): ProviderOptionList {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const options: ProviderOption[] = [];
  const seen = new Set<string>();
  let truncated = body.truncated === true;
  const push = (value: unknown, label: unknown, description?: unknown) => {
    if (!isNonEmptyString(value) || seen.has(value)) return;
    if (options.length >= PROVIDER_OPTIONS_MAX) {
      truncated = true;
      return;
    }
    seen.add(value);
    const option: ProviderOption = { value, label: isNonEmptyString(label) ? label : value };
    if (isNonEmptyString(description)) option.description = description;
    options.push(option);
  };
  if (Array.isArray(body.options)) {
    for (const item of body.options) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      push(o.value, o.label, o.description);
    }
  } else if (Array.isArray(body.containers)) {
    for (const item of body.containers) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      push(c.id, c.name);
    }
  }
  return { options, truncated };
}

/** Manifest-level check run by the loader and the Cupboard installer. */
export function validateProviderDeclaration(manifest: { provider?: unknown }): string[] {
  if (manifest.provider === undefined) return [];
  return validateProviderDescriptor(manifest.provider);
}

/** True when `value` structurally implements the adapter (used before registering a js provider). */
export function isProviderAdapter(value: unknown): value is ProviderAdapter {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return typeof a.describe === 'function' && typeof a.syncPage === 'function' && typeof a.invoke === 'function';
}
