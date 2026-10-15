/**
 * Ticket integrations: what Settings → Integrations reads and writes (plan
 * linear-asana-task-sync-2026-10-05 P-007, design D-014).
 *
 * The page is composed from surfaces that already own their state; nothing here is a second path
 * to any of it:
 *   - providers: the live registry's ticket providers that declare an `oauth` block (D-014.1),
 *     connected through the existing `/api/oauth/start` flow, returning to this page (D-014.2);
 *   - sources: the signed-in owner's data sources of those kinds (source-store ownership seam);
 *   - containers: the provider's `ticket.containers` capability (D-014.3), invoked through the one
 *     token path (createSourceHostFetch bound to exactly the one source, its credential read from
 *     the install that connected it: sourceTokenHarness, WI-10006662);
 *   - config: merged, validated against the descriptor's configSchema (json-schema-validation),
 *     then the source is made due so the connector driver reads with it now (D-014.4);
 *   - rules: admission_rules through setAdmissionRuleAndBackfill / disableAdmissionRule, the same
 *     path `work_items:admit` rules-set uses (D-012, D-014.5).
 * Every read and write is scoped to a source the signed-in owner holds.
 */
import type postgres from 'postgres';
import type { HostFetch, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { providerAppRegistrationView, type ProviderAppRegistrationView } from '@papercusp/plugin-sdk/provider';
import {
  ProviderRegistryNotReadyError,
  readyProviderRegistry,
  type ProviderRegistry,
  type RegisteredProvider,
} from './provider-registry';
import { createSourceHostFetch } from './source-host-fetch';
import { descriptorOAuthPlugin } from './connection-lifecycle';
import { providerCredentialStatus, type ProviderCredentialStatus } from './provider-credentials';
import { providerSourceSettingsOffer, type ProviderSourceSettingsOffer } from './provider-source-settings';
import {
  clientRegistrationRefOf,
  oauthClientRegistrationStatuses,
  type OAuthClientRegistrationStatus,
} from './oauth-client-registration';
import type { TokenStorage } from '../oauth/token';
import {
  listAvailableTriggerPacks,
  listTriggerPackSettings,
  type AvailableTriggerPack,
  type TriggerPackSettings,
} from '../cupboard/trigger-pack-lifecycle';
import {
  DEFAULT_SOURCE_TOKEN_HARNESS,
  listOwnedExternalTriggerSources,
  sourceTokenHarness,
} from '../external-triggers/source-store';
import { checkAgainstJsonSchema, missingRequiredJsonSchemaKeys, withoutTopLevelRequired } from '../json-schema-validation';
import { ProviderCapabilityUnsupported } from '../capability-verbs/provider-dispatch';
import {
  disableAdmissionRule,
  listAdmissionRules,
  setAdmissionRuleAndBackfill,
  ticketRulePreset,
  TICKET_RULE_PRESETS,
  type AdmissionRule,
  type SetAdmissionRuleResult,
  type TicketRulePreset,
} from '../work-admission/admission-rules';
import { ADMITTED_KINDS, type AdmittedKind } from '../work-admission/admit';

export const TICKET_DATATYPE = 'ticket';
export const TICKET_CONTAINERS_CAPABILITY = 'ticket.containers';
export const INTEGRATIONS_SETTINGS_PATH = '/settings/integrations';

/**
 * Config keys the page has its own controls and labels for. Not the settable set: what a source
 * may set comes from its provider's configSchema (settableTicketConfigKeys).
 */
export const TICKET_SOURCE_CONFIG_KEYS = ['teamIds', 'workspaceGid', 'projectGids', 'sectionCategories', 'harnessSlug'] as const;
export type TicketSourceConfigKey = (typeof TICKET_SOURCE_CONFIG_KEYS)[number];

/** Config the connection flow owns. It is reported back but never settable from the page. */
const CONNECTION_OWNED_CONFIG_KEYS = ['accountLabel'] as const;

/**
 * The config keys a source of this provider may set: the properties its descriptor's configSchema
 * declares, plus `harnessSlug` (the harness is ours, so no descriptor can declare it). Derived from
 * the descriptor so a new provider's keys (GitHub's owner/repo) are settable without a hand-kept
 * list here (WI-10006213).
 */
export function settableTicketConfigKeys(schema: Record<string, unknown> | null): string[] {
  const properties = isPlainObject(schema?.properties) ? Object.entries(schema.properties)
    .filter(([, property]) => !isPlainObject(property) || (!property.secret && !property.writeOnly && !property.readOnly))
    .map(([key]) => key) : [];
  const keys = new Set([...properties, 'harnessSlug']);
  for (const owned of CONNECTION_OWNED_CONFIG_KEYS) keys.delete(owned);
  return [...keys];
}

export const TICKET_CONTAINER_KINDS = ['team', 'workspace', 'project'] as const;
export type TicketContainerKind = (typeof TICKET_CONTAINER_KINDS)[number];

export interface TicketContainer {
  id: string;
  name: string;
  kind: TicketContainerKind;
  parentId?: string;
  key?: string;
  sections?: Array<{ id: string; name: string }>;
}

export interface TicketContainerList {
  containers: TicketContainer[];
  /** The provider stopped before listing everything; the page says so instead of implying a full list. */
  truncated: boolean;
}

export interface TicketProviderSummary {
  id: string;
  displayName: string;
  capabilities: string[];
  /** The datatypes the provider syncs, as its descriptor declares them. */
  datatypes: string[];
  /**
   * True when the provider's connected accounts are ticket sources the page manages (scope,
   * status mapping, rules). Derived from the descriptor (ticket datatype + OAuth), never a name.
   */
  tracksTickets: boolean;
  canListContainers: boolean;
  /**
   * How workflow states map onto the canonical columns: `sections` when the descriptor's config
   * takes a section mapping the user edits (Asana, D-011); `provider-defined` when the provider's
   * own state types decide (Linear, D-010). Derived from the descriptor, never from a provider name.
   */
  statusMapping: 'sections' | 'provider-defined';
  /** Top-level config keys the source needs before it can sync (descriptor configSchema.required). */
  requiredConfig: string[];
  /** Non-secret source fields, rendered by the generic configuration form. */
  sourceConfigSchema?: Record<string, unknown> | null;
  /**
   * Starts the existing OAuth flow for this provider and lands back on this page; null when the
   * provider signs in with pasted credentials only.
   */
  connectHref: string | null;
  /**
   * The paste-a-secret fields the provider declares (`setup.credentials`) and whether each is
   * configured. Status only: never a stored value. Empty when the provider declares none.
   */
  credentials: ProviderCredentialStatus[];
  /**
   * The source settings the descriptor offers on this page (D-026 ruling 4): organization-wide
   * sharing when it declares membership, live search when it also declares `search.live`.
   */
  sourceSettings: ProviderSourceSettingsOffer;
  /**
   * The vendor app the owner creates before connecting (`setup.appRegistration`, P-002), or null
   * when the provider declares none.
   */
  appRegistration: ProviderAppRegistrationView | null;
  /**
   * The owner's OAuth app registration for an OAuth provider (P-009): whether one is saved, its
   * client ID and the redirect URL to give the vendor. Never the client secret. Null when the
   * provider does not sign in through OAuth.
   */
  oauthClient: ProviderOAuthClientSummary | null;
}

/** An OAuth provider's client registration status, plus whether its flow needs a client secret. */
export interface ProviderOAuthClientSummary extends OAuthClientRegistrationStatus {
  /** False when the provider's flow uses PKCE and can run with a client ID alone. */
  secretRequired: boolean;
}

export interface TicketSourceSummary {
  id: string;
  provider: string;
  providerAccountId: string | null;
  accountLabel: string | null;
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
  nextAttemptAt: string | null;
  failureCount: number;
  /** Who can read what the source syncs (D-026 ruling 4): the owner alone, the organization, or one pot. */
  scope: string;
  /** Searched live at read time instead of copied (`sync_mode = 'federated'`). */
  liveSearch: boolean;
  /** The reported config keys only (REPORTED_CONFIG_KEYS); never credentials or cursors. */
  config: Record<string, unknown>;
  /** Required config the source still lacks; it cannot sync until these are set. */
  missingConfig: string[];
  /** Ticket records this source has mirrored. */
  mirrored: number;
  /** Work items admitted from this source. */
  admitted: number;
  /** Every rule on this source, enabled or not. */
  rules: AdmissionRule[];
}

export interface TicketIntegrationsOverview {
  providers: TicketProviderSummary[];
  sources: TicketSourceSummary[];
  /** Installed trigger packs: inputs form, review and arm (P-005). */
  triggerPacks: TriggerPackSettings[];
  /**
   * Packages installed from the Cupboard whose trigger pack is not set up in this workspace yet:
   * the owner picks the project here (cupboard-distributable-integrations-2026-10-10 D-017).
   */
  availableTriggerPacks: AvailableTriggerPack[];
}

export interface TicketIntegrationsScope {
  workspaceId: string;
  ownerUserId: string;
}

export interface TicketIntegrationsDeps {
  registry?: ProviderRegistry;
  /** Where pasted provider credentials are read from. Production: the OAuth token store. */
  credentialStorage?: TokenStorage;
  /** host.fetch bound to exactly one source. Production: createSourceHostFetch. */
  hostFetchFor?: (
    sql: postgres.Sql,
    input: { workspaceId: string; providerId: string; sourceId: string; harness: string },
  ) => HostFetch;
  /** Where installed plugins live, for packs not set up yet (D-017). Production: GLOBAL_PLUGINS_DIR(). */
  pluginsDir?: string;
}

/** A refusal the route maps to a 4xx: the caller asked for something it cannot have. */
export class TicketIntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(`${code}: ${message}`);
    this.name = 'TicketIntegrationError';
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Ticket providers that can be connected from the page: they produce tickets and declare OAuth. */
/**
 * The registry a request reads: the injected one, else the process registry once plugin discovery
 * has registered its providers. A request-only host discovers plugins on first need, so reading the
 * registry bare could list no providers at all (WI-10006703); not-ready answers 503, never an empty list.
 */
export async function requestRegistry(deps: { registry?: ProviderRegistry }): Promise<ProviderRegistry> {
  if (deps.registry) return deps.registry;
  try {
    return await readyProviderRegistry();
  } catch (e) {
    if (e instanceof ProviderRegistryNotReadyError) throw new TicketIntegrationError(e.code, e.message, 503);
    throw e;
  }
}

const byDisplayName = (a: RegisteredProvider, b: RegisteredProvider): number =>
  (a.descriptor.displayName ?? a.descriptor.id).localeCompare(b.descriptor.displayName ?? b.descriptor.id);

/** Providers whose connected accounts are ticket sources (scope, status mapping, rules). */
export function ticketProviders(registry: ProviderRegistry): RegisteredProvider[] {
  return registry
    .list()
    .filter((entry) => entry.descriptor.datatypes.includes(TICKET_DATATYPE) && entry.descriptor.oauth)
    .sort(byDisplayName);
}

/**
 * Every installed provider the owner can set up from Settings → Integrations (P-005): one that
 * signs in through OAuth or takes pasted credentials (`setup.credentials`, P-001). Derived from the
 * descriptor alone, so a provider installed from the Cupboard gets a card without app changes.
 */
export function integrationProviders(registry: ProviderRegistry): RegisteredProvider[] {
  return registry
    .list()
    .filter((entry) => Boolean(entry.descriptor.oauth) || (entry.descriptor.setup?.credentials?.length ?? 0) > 0)
    .sort(byDisplayName);
}

const tracksTickets = (descriptor: ProviderDescriptor): boolean =>
  descriptor.datatypes.includes(TICKET_DATATYPE) && Boolean(descriptor.oauth);

/** The existing OAuth start link for a descriptor provider, returning to Settings → Integrations. */
export function ticketConnectHref(descriptor: ProviderDescriptor): string {
  const plugin = descriptorOAuthPlugin(descriptor);
  const params = new URLSearchParams({
    provider: plugin,
    plugin,
    harness: DEFAULT_SOURCE_TOKEN_HARNESS,
    field: 'owner',
    return: INTEGRATIONS_SETTINGS_PATH,
  });
  return `/api/oauth/start?${params.toString()}`;
}

function configSchemaOf(descriptor: ProviderDescriptor): Record<string, unknown> | null {
  const schema = (descriptor as { configSchema?: unknown }).configSchema;
  return isPlainObject(schema) ? schema : null;
}

export function summarizeIntegrationProvider(
  entry: RegisteredProvider,
  credentials: ProviderCredentialStatus[],
  oauthClient: OAuthClientRegistrationStatus | null = null,
): TicketProviderSummary {
  const d = entry.descriptor;
  const schema = configSchemaOf(d);
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  return {
    id: d.id,
    displayName: d.displayName ?? d.id,
    capabilities: [...d.capabilities],
    datatypes: [...d.datatypes],
    tracksTickets: tracksTickets(d),
    canListContainers: d.capabilities.includes(TICKET_CONTAINERS_CAPABILITY),
    statusMapping: 'sectionCategories' in properties ? 'sections' : 'provider-defined',
    requiredConfig: missingRequiredJsonSchemaKeys(schema, {}),
    sourceConfigSchema: schema ? {
      ...schema,
      properties: {
        ...Object.fromEntries(Object.entries(properties).filter(([key]) => settableTicketConfigKeys(schema).includes(key))),
        harnessSlug: { type: 'string', title: 'Project to store activity in', minLength: 1 },
      },
      required: [...new Set([...missingRequiredJsonSchemaKeys(schema, {}), 'harnessSlug'])],
    } : null,
    connectHref: d.oauth ? ticketConnectHref(d) : null,
    credentials,
    sourceSettings: providerSourceSettingsOffer(d),
    appRegistration: providerAppRegistrationView(d),
    oauthClient: d.oauth && oauthClient ? { ...oauthClient, secretRequired: !d.oauth.pkce } : null,
  };
}

interface SourceSyncRow {
  id: string;
  scope: string;
  sync_mode: string;
  sync_last_success_at: Date | string | null;
  sync_next_attempt_at: Date | string | null;
  sync_failure_count: number | null;
}

const isoOrNull = (v: Date | string | null | undefined): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

/** The settable keys plus the account label the connect flow wrote; never credentials or cursors. */
function reportedConfig(schema: Record<string, unknown> | null, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...settableTicketConfigKeys(schema), ...CONNECTION_OWNED_CONFIG_KEYS]) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  return out;
}

/** Everything the page shows, for one owner: providers, their sources, counts, rules. */
export async function ticketIntegrationsOverview(
  sql: postgres.Sql,
  scope: TicketIntegrationsScope,
  deps: Pick<TicketIntegrationsDeps, 'registry' | 'credentialStorage' | 'pluginsDir'> = {},
): Promise<TicketIntegrationsOverview> {
  const registry = await requestRegistry(deps);
  const providers = integrationProviders(registry);
  // Every offered provider's connected accounts are listed (account, status, last error), so a
  // credentials-only provider shows the source its saved credentials created (D-006). Only ticket
  // providers' accounts carry the scope, counts and rules this page also manages.
  const byKind = new Map(providers.map((entry) => [entry.descriptor.id, entry]));
  const offered = new Set([...providers.map((entry) => entry.descriptor.id), ...byKind.keys()]);
  const owned = (await listOwnedExternalTriggerSources(sql, scope.workspaceId, scope.ownerUserId)).filter((s) => offered.has(s.kind));
  const ids = owned.map((s) => s.id);
  const [syncRows, mirroredRows, admittedRows, rules] = ids.length === 0
    ? [[], [], [], []] as const
    : await Promise.all([
      sql<SourceSyncRow[]>`
        SELECT id::text, scope, sync_mode, sync_last_success_at, sync_next_attempt_at, sync_failure_count
          FROM harness_shared.data_sources
         WHERE workspace_id = ${scope.workspaceId} AND id::text = ANY(${sql.array(ids)}::text[])`,
      sql<Array<{ id: string; n: number }>>`
        SELECT payload->>'dataSourceId' AS id, count(*)::int AS n
          FROM harness_shared.work_items
         WHERE workspace_id = ${scope.workspaceId} AND nature = 'record' AND item_kind = ${TICKET_DATATYPE}
           AND payload->>'dataSourceId' = ANY(${sql.array(ids)}::text[])
         GROUP BY 1`,
      sql<Array<{ id: string; n: number }>>`
        SELECT data_source_id::text AS id, count(*)::int AS n
          FROM harness_shared.work_admissions
         WHERE workspace_id = ${scope.workspaceId} AND data_source_id::text = ANY(${sql.array(ids)}::text[])
         GROUP BY 1`,
      listAdmissionRules(scope.workspaceId, { includeDisabled: true }, sql),
    ]);
  const sync = new Map(syncRows.map((r) => [r.id, r]));
  const mirrored = new Map(mirroredRows.map((r) => [r.id, r.n]));
  const admitted = new Map(admittedRows.map((r) => [r.id, r.n]));
  const sources = owned.map((source): TicketSourceSummary => {
    const s = sync.get(source.id);
    const config = isPlainObject(source.config) ? source.config : {};
    const ticket = byKind.get(source.kind);
    const schema = ticket ? configSchemaOf(ticket.descriptor) : null;
    return {
      id: source.id,
      provider: source.kind,
      providerAccountId: source.providerAccountId,
      accountLabel: str(config.accountLabel) || null,
      status: source.status,
      lastError: source.lastError,
      lastSyncAt: isoOrNull(s?.sync_last_success_at),
      nextAttemptAt: isoOrNull(s?.sync_next_attempt_at),
      failureCount: s?.sync_failure_count ?? 0,
      scope: s?.scope ?? 'personal',
      liveSearch: s?.sync_mode === 'federated',
      config: schema ? reportedConfig(schema, config) : {},
      missingConfig: schema ? missingTicketConfig(schema, config) : [],
      mirrored: mirrored.get(source.id) ?? 0,
      admitted: admitted.get(source.id) ?? 0,
      rules: rules.filter((rule) => rule.dataSourceId === source.id),
    };
  });
  // Pasted credentials live under the harness the connect link writes tokens to, the same one the
  // credentials route reads and writes. OAuth client registrations come from one read of the
  // host's oauth-apps.json, keyed the way the connect flow keys them.
  const registered = registry.list().map((entry) => entry.descriptor);
  const clientRefs = new Map(providers.map((entry) => [entry.descriptor.id, clientRegistrationRefOf(entry.descriptor, registered)]));
  const [summaries, triggerPacks, availableTriggerPacks] = await Promise.all([
    oauthClientRegistrationStatuses([...new Set([...clientRefs.values()].filter((ref): ref is string => ref !== null))]).then((clients) =>
      Promise.all(
        providers.map(async (entry) => {
          const ref = clientRefs.get(entry.descriptor.id);
          return summarizeIntegrationProvider(
            entry,
            // The viewer's own per-person values read as configured for them alone (D-026).
            await providerCredentialStatus(entry.descriptor, DEFAULT_SOURCE_TOKEN_HARNESS, deps.credentialStorage, scope.ownerUserId),
            ref ? (clients.get(ref) ?? null) : null,
          );
        }),
      ),
    ),
    listTriggerPackSettings(sql, scope.workspaceId),
    listAvailableTriggerPacks(sql, scope.workspaceId, { pluginsDir: deps.pluginsDir }),
  ]);
  return { providers: summaries, sources, triggerPacks, availableTriggerPacks };
}

interface OwnedTicketSource {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  provider: RegisteredProvider;
}

/** The owner's ticket source, with its registered provider, or a refusal (404 for anything not theirs). */
async function ownedTicketSource(
  sql: postgres.Sql,
  scope: TicketIntegrationsScope & { sourceId: string },
  registry: ProviderRegistry,
  allowNonTicket = false,
): Promise<OwnedTicketSource> {
  const sourceId = str(scope.sourceId);
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new TicketIntegrationError('ticket_source_not_found', `no source '${sourceId}'`, 404);
  const [row] = await sql<Array<{ id: string; kind: string; config: Record<string, unknown> | null }>>`
    SELECT id::text, kind, config FROM harness_shared.data_sources
     WHERE workspace_id = ${scope.workspaceId} AND id = ${sourceId}::uuid AND owner_user_id = ${scope.ownerUserId}::uuid`;
  if (!row) throw new TicketIntegrationError('ticket_source_not_found', `no source '${sourceId}' of yours`, 404);
  const provider = (allowNonTicket ? integrationProviders(registry) : ticketProviders(registry)).find((p) => p.descriptor.id === row.kind) ?? null;
  if (!provider) throw new TicketIntegrationError('ticket_provider_not_registered', `'${row.kind}' is not a registered ticket provider`, 409);
  return { id: row.id, kind: row.kind, config: isPlainObject(row.config) ? row.config : {}, provider };
}

export function defaultHostFetchFor(
  sql: postgres.Sql,
  input: { workspaceId: string; providerId: string; sourceId: string; harness: string },
): HostFetch {
  return createSourceHostFetch(sql, {
    providerId: input.providerId,
    workspaceId: input.workspaceId,
    harness: input.harness,
    sourceIds: [input.sourceId],
  });
}

/** A provider's container list, kept to the documented shape (malformed entries are dropped). */
export function normalizeTicketContainers(raw: unknown): TicketContainerList {
  const body = isPlainObject(raw) ? raw : {};
  const containers: TicketContainer[] = [];
  for (const item of Array.isArray(body.containers) ? body.containers : []) {
    if (!isPlainObject(item)) continue;
    const id = str(item.id);
    const kind = str(item.kind) as TicketContainerKind;
    if (!id || !(TICKET_CONTAINER_KINDS as readonly string[]).includes(kind)) continue;
    const container: TicketContainer = { id, name: str(item.name) || id, kind };
    if (str(item.parentId)) container.parentId = str(item.parentId);
    if (str(item.key)) container.key = str(item.key);
    if (Array.isArray(item.sections)) {
      container.sections = item.sections
        .filter(isPlainObject)
        .map((s) => ({ id: str(s.id), name: str(s.name) || str(s.id) }))
        .filter((s) => s.id);
    }
    containers.push(container);
  }
  return { containers, truncated: body.truncated === true };
}

/**
 * What the source can be configured with, from its provider's `ticket.containers` (D-014.3).
 * A provider without the capability is refused by name before any host.fetch exists, so the page
 * can fall back to a plain id field.
 */
export async function listTicketSourceContainers(
  sql: postgres.Sql,
  input: TicketIntegrationsScope & { sourceId: string; args?: Record<string, unknown> },
  deps: TicketIntegrationsDeps = {},
): Promise<TicketContainerList> {
  const registry = await requestRegistry(deps);
  const source = await ownedTicketSource(sql, input, registry);
  const { descriptor, adapter } = source.provider;
  const invoke = (adapter as { invoke?: RegisteredProvider['adapter']['invoke'] }).invoke;
  if (!descriptor.capabilities.includes(TICKET_CONTAINERS_CAPABILITY) || !invoke) {
    throw new ProviderCapabilityUnsupported(descriptor.id, TICKET_CONTAINERS_CAPABILITY);
  }
  const fetch = (deps.hostFetchFor ?? defaultHostFetchFor)(sql, {
    workspaceId: input.workspaceId,
    providerId: descriptor.id,
    sourceId: source.id,
    harness: sourceTokenHarness(source.config),
  });
  const result = await invoke.call(
    adapter,
    { source: source.id, capability: TICKET_CONTAINERS_CAPABILITY, args: input.args ?? {}, config: source.config },
    { fetch },
  );
  return normalizeTicketContainers(result);
}

export interface TicketSourceConfigResult {
  config: Record<string, unknown>;
  missingConfig: string[];
}

/**
 * Merge `patch` into the source config (a `null` value removes the key), validate the result
 * against the provider's configSchema, save it, and make the source due (D-014.4). Required keys
 * are reported, not demanded, so the page can save in steps; the connector refuses to sync until
 * they are set. A config change answers the failures that missing config caused, so it also
 * lifts their backoff.
 */
export async function setTicketSourceConfig(
  sql: postgres.Sql,
  input: TicketIntegrationsScope & { sourceId: string; patch: Record<string, unknown> },
  deps: Pick<TicketIntegrationsDeps, 'registry'> = {},
): Promise<TicketSourceConfigResult> {
  const source = await ownedTicketSource(sql, input, await requestRegistry(deps), true);
  if (!isPlainObject(input.patch)) throw new TicketIntegrationError('ticket_source_config_invalid', 'patch must be an object');
  const schema = configSchemaOf(source.provider.descriptor);
  const settable = settableTicketConfigKeys(schema);
  const merged: Record<string, unknown> = { ...source.config };
  for (const [key, value] of Object.entries(input.patch)) {
    if (!settable.includes(key)) {
      throw new TicketIntegrationError('ticket_source_config_invalid', `'${key}' is not settable here (${settable.join(', ')})`);
    }
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const check = checkAgainstJsonSchema(schema ? withoutTopLevelRequired(schema) : null, merged);
  if (!check.ok) throw new TicketIntegrationError('ticket_source_config_invalid', check.errors.join('; '));
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.data_sources
       SET config = ${sql.json(merged as never)},
           sync_wake_requested_at = now(),
           sync_next_attempt_at = NULL,
           updated_at = now()
     WHERE workspace_id = ${input.workspaceId} AND id = ${source.id}::uuid AND owner_user_id = ${input.ownerUserId}::uuid
    RETURNING id::text`;
  if (rows.length !== 1) throw new TicketIntegrationError('ticket_source_not_found', `no source '${source.id}' of yours`, 404);
  return { config: reportedConfig(schema, merged), missingConfig: missingTicketConfig(schema, merged) };
}

/**
 * The config a ticket source still lacks before it can sync: its descriptor's required keys, plus
 * `harnessSlug`. A ticket record is written under its source's harness and the connector gives
 * non-graph datatypes no fallback (providers/connector-runtime.ts; harnessOf in
 * data-sources/datatype-destination-sink.ts), so without it every sync fails
 * `data_source_harness_missing`. No descriptor can say that, because the harness is ours.
 */
function missingTicketConfig(
  schema: Parameters<typeof missingRequiredJsonSchemaKeys>[0],
  config: Record<string, unknown>,
): string[] {
  const missing = missingRequiredJsonSchemaKeys(schema, config);
  return str(config.harnessSlug) || missing.includes('harnessSlug') ? missing : [...missing, 'harnessSlug'];
}

const PRESET_TITLES: Record<TicketRulePreset, string> = {
  'delegated-to-papercusp': 'Delegated to Papercusp',
  'assigned-to-papercusp': 'Assigned to Papercusp',
  label: 'Label',
  team: 'Team',
  project: 'Project',
};

export interface SetTicketRuleInput extends TicketIntegrationsScope {
  sourceId: string;
  preset: string;
  value?: string;
  harness: string;
  workKind?: string;
  createdBy: string;
}

/**
 * Add an admission rule from a preset (D-012) and admit what the source already holds, through
 * setAdmissionRuleAndBackfill: the same path `work_items:admit` rules-set uses.
 */
export async function setTicketSourceRule(
  sql: postgres.Sql,
  input: SetTicketRuleInput,
  deps: Pick<TicketIntegrationsDeps, 'registry'> = {},
): Promise<SetAdmissionRuleResult> {
  const source = await ownedTicketSource(sql, input, await requestRegistry(deps));
  if (!(TICKET_RULE_PRESETS as readonly string[]).includes(input.preset)) {
    throw new TicketIntegrationError('admission_rule_invalid', `preset must be one of ${TICKET_RULE_PRESETS.join(', ')}`);
  }
  const preset = input.preset as TicketRulePreset;
  const harness = str(input.harness);
  if (!harness) throw new TicketIntegrationError('admission_rule_invalid', 'a target harness is required');
  const workKind = str(input.workKind) || 'change';
  if (!(ADMITTED_KINDS as readonly string[]).includes(workKind)) {
    throw new TicketIntegrationError('admission_rule_invalid', `workKind must be one of ${ADMITTED_KINDS.join(', ')}`);
  }
  let match;
  try {
    match = ticketRulePreset(preset, input.value);
  } catch (error) {
    throw new TicketIntegrationError('admission_rule_invalid', error instanceof Error ? error.message : String(error));
  }
  const value = str(input.value);
  return setAdmissionRuleAndBackfill(
    {
      workspaceId: input.workspaceId,
      dataSourceId: source.id,
      title: value ? `${PRESET_TITLES[preset]}: ${value}` : PRESET_TITLES[preset],
      match,
      harness,
      workKind: workKind as AdmittedKind,
      createdBy: input.createdBy,
    },
    { sql },
  );
}

/** Disable one of the source's rules (rules are never deleted: admissions name them). */
export async function disableTicketSourceRule(
  sql: postgres.Sql,
  input: TicketIntegrationsScope & { sourceId: string; ruleId: string },
  deps: Pick<TicketIntegrationsDeps, 'registry'> = {},
): Promise<AdmissionRule> {
  const source = await ownedTicketSource(sql, input, await requestRegistry(deps));
  const rules = await listAdmissionRules(input.workspaceId, { dataSourceId: source.id, includeDisabled: true }, sql);
  if (!rules.some((rule) => rule.id === input.ruleId)) {
    throw new TicketIntegrationError('admission_rule_not_found', `no rule '${input.ruleId}' on this source`, 404);
  }
  return disableAdmissionRule(input.workspaceId, input.ruleId, sql);
}
