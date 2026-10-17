/**
 * Shared, secret-free connection inventory for the cloud and remote-access
 * surfaces.
 *
 * The inventory is a presentation contract only. Each source keeps its own
 * credential and trust model; these adapters expose stable identity,
 * lifecycle, liveness, authority and class-specific actions without copying
 * tokens, keys, pairing codes or other credential material into the UI model.
 */

export const CONNECTION_CLASSES = [
  'ssh-profile',
  'portal-relay',
  'hosted-connector',
  'browser-session',
  'mobile-device',
] as const;
export type ConnectionClass = (typeof CONNECTION_CLASSES)[number];

export const CONNECTION_ACTIONS = [
  'forget-local',
  'revoke-remote-key',
  'disconnect-relay',
  'revoke-connector',
  'revoke-session',
  'pause-device',
  'revoke-device',
] as const;
export type ConnectionAction = (typeof CONNECTION_ACTIONS)[number];

export type ConnectionTransport = 'ssh' | 'websocket' | 'https' | 'device-http';
export type ConnectionState = 'active' | 'paused' | 'expired' | 'revoked' | 'unavailable' | 'unknown';
export type ConnectionHealth = 'healthy' | 'degraded' | 'offline' | 'unknown';

/** The shared inventory row. No source credential or secret is represented here. */
export interface ConnectionInventoryEntry {
  id: string;
  class: ConnectionClass;
  label: string;
  scope: string;
  transport: ConnectionTransport;
  state: ConnectionState;
  health: ConnectionHealth;
  lastSeen: string | null;
  authoritySummary: string;
  actions: readonly ConnectionAction[];
  /** A stable, non-secret pointer back to the source adapter. */
  sourceRef: string;
}

export interface SshProfileConnectionSource {
  id: string;
  label?: string | null;
  host?: string | null;
  scope?: string | null;
  state?: 'active' | 'unavailable' | 'unknown';
  health?: ConnectionHealth;
  lastSeen?: string | null;
  sourceRef?: string;
}

export interface PortalRelayConnectionSource {
  id?: string;
  workspaceId?: string | null;
  state: 'off' | 'linking' | 'linked';
  available?: boolean;
  health?: 'off' | 'linking' | 'starting' | 'up' | 'down';
  linkedAt?: string | null;
  sourceRef?: string;
}

/** Shape returned by `portalRelayStatus`; pending approval details stay out. */
export interface PortalRelayStatusConnectionSource {
  workspaceId?: string | null;
  state: 'off' | 'linking' | 'linked';
  available: boolean;
  health: 'off' | 'linking' | 'starting' | 'up' | 'down';
  linked?: { linkedAt?: string | null } | null;
  sourceRef?: string;
}

export interface HostedConnectorConnectionSource {
  id: string;
  label?: string | null;
  scope?: string | null;
  transport?: 'websocket' | 'https';
  state?: 'connected' | 'connecting' | 'disconnected' | 'unknown';
  health?: ConnectionHealth;
  lastSeen?: string | null;
  sourceRef?: string;
}

/** Redacted hosted connector/tunnel projection. Heartbeats are liveness only. */
export interface HostedConnectorStatusConnectionSource {
  id: string;
  routeLabel?: string | null;
  transport?: 'websocket' | 'https';
  state?: 'connected' | 'connecting' | 'disconnected' | 'unknown';
  health?: ConnectionHealth;
  lastSeenAt?: string | null;
  sourceRef?: string;
}

export interface BrowserSessionConnectionSource {
  id: string;
  label?: string | null;
  scope?: string | null;
  transport?: 'websocket' | 'https';
  state?: 'active' | 'expired' | 'revoked' | 'unknown';
  health?: ConnectionHealth;
  lastSeen?: string | null;
  sourceRef?: string;
}

export interface MobileDeviceConnectionSource {
  id: string;
  label?: string | null;
  creator?: string | null;
  scope?: string | null;
  pairedAt?: string | null;
  lastSeen?: string | null;
  expiresAt?: string | null;
  pausedAt?: string | null;
  revokedAt?: string | null;
  health?: ConnectionHealth;
  sourceRef?: string;
}

/** The redacted connected_apps projection used by Settings → Remote access. */
export interface RemoteAccessEntryConnectionSource {
  id: string;
  kind: 'mobile' | 'app' | 'service';
  label?: string | null;
  creator?: string | null;
  pairedAt?: string | null;
  lastSeen?: string | null;
  expiresAt?: string | null;
  pausedAt?: string | null;
  rotatedAt?: string | null;
  previousKeyValidUntil?: string | null;
  sourceRef?: string;
}

export interface ConnectionInventorySources {
  sshProfiles?: readonly SshProfileConnectionSource[];
  portalRelays?: readonly PortalRelayConnectionSource[];
  hostedConnectors?: readonly HostedConnectorConnectionSource[];
  browserSessions?: readonly BrowserSessionConnectionSource[];
  mobileDevices?: readonly MobileDeviceConnectionSource[];
}

export interface ConnectionInventoryOptions {
  now?: number;
  staleAfterMs?: number;
}

export interface ConnectionStatusCopy {
  status: string;
  revokeLabel: string;
  revokeBody: string;
}

export interface ConnectionConfirmationCopy {
  titleVerb: string;
  confirmLabel: string;
  body: string;
}

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? value : null;
}

function sourceRef(value: string | undefined, prefix: ConnectionClass, id: string): string {
  return text(value, `${prefix}:${id}`);
}

function health(value: ConnectionHealth | undefined, lastSeen: string | null, now: number, staleAfterMs: number): ConnectionHealth {
  if (value) return value;
  if (!lastSeen) return 'unknown';
  const seen = Date.parse(lastSeen);
  if (!Number.isFinite(seen)) return 'unknown';
  return now - seen > staleAfterMs ? 'degraded' : 'healthy';
}

function base(
  input: Omit<ConnectionInventoryEntry, 'lastSeen'> & { lastSeen?: string | null },
): ConnectionInventoryEntry {
  return { ...input, lastSeen: input.lastSeen ?? null };
}

export function normalizeSshProfile(source: SshProfileConnectionSource): ConnectionInventoryEntry {
  const id = text(source.id, 'ssh-profile');
  const label = text(source.label, source.host ? `SSH · ${source.host}` : `SSH profile · ${id}`);
  const lastSeen = isoOrNull(source.lastSeen);
  return base({
    id,
    class: 'ssh-profile',
    label,
    scope: text(source.scope, 'Local machine'),
    transport: 'ssh',
    state: source.state ?? 'unknown',
    health: source.health ?? (source.state === 'unavailable' ? 'offline' : 'unknown'),
    authoritySummary: 'SSH machine access',
    actions: ['forget-local', 'revoke-remote-key'],
    sourceRef: sourceRef(source.sourceRef, 'ssh-profile', id),
    lastSeen,
  });
}

export function normalizePortalRelay(source: PortalRelayConnectionSource): ConnectionInventoryEntry {
  const id = text(source.id, source.workspaceId ? `workspace-${source.workspaceId}` : 'portal-relay');
  const relayHealth = source.health ?? (source.state === 'linked' ? 'up' : source.state === 'off' ? 'off' : 'linking');
  const state: ConnectionState = !source.available || source.state === 'off'
    ? 'unavailable'
    : source.state === 'linked'
      ? 'active'
      : 'unknown';
  const normalizedHealth: ConnectionHealth = relayHealth === 'up'
    ? 'healthy'
    : relayHealth === 'down' || relayHealth === 'off'
      ? 'offline'
      : relayHealth === 'starting' || relayHealth === 'linking'
        ? 'degraded'
        : 'unknown';
  return base({
    id,
    class: 'portal-relay',
    label: 'Papercusp portal relay',
    scope: text(source.workspaceId, 'Current workspace'),
    transport: 'websocket',
    state,
    health: normalizedHealth,
    authoritySummary: 'Portal relay app channels',
    actions: ['disconnect-relay'],
    sourceRef: sourceRef(source.sourceRef, 'portal-relay', id),
    lastSeen: isoOrNull(source.linkedAt),
  });
}

export function normalizePortalRelayStatus(source: PortalRelayStatusConnectionSource): ConnectionInventoryEntry {
  return normalizePortalRelay({
    id: source.workspaceId ? `workspace-${source.workspaceId}` : undefined,
    workspaceId: source.workspaceId,
    state: source.state,
    available: source.available,
    health: source.health,
    linkedAt: source.linked?.linkedAt ?? null,
    sourceRef: source.sourceRef,
  });
}

export function normalizeHostedConnector(source: HostedConnectorConnectionSource, options: ConnectionInventoryOptions = {}): ConnectionInventoryEntry {
  const id = text(source.id, 'hosted-connector');
  const lastSeen = isoOrNull(source.lastSeen);
  const state: ConnectionState = source.state === 'connected'
    ? 'active'
    : source.state === 'disconnected'
      ? 'unavailable'
      : source.state === 'connecting'
        ? 'unknown'
        : 'unknown';
  return base({
    id,
    class: 'hosted-connector',
    label: text(source.label, `Hosted connector · ${id}`),
    scope: text(source.scope, 'Hosted workspace'),
    transport: source.transport ?? 'websocket',
    state,
    health: health(source.health, lastSeen, options.now ?? Date.now(), options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    authoritySummary: 'Hosted workspace connector',
    actions: ['revoke-connector'],
    sourceRef: sourceRef(source.sourceRef, 'hosted-connector', id),
    lastSeen,
  });
}

export function normalizeHostedConnectorStatus(source: HostedConnectorStatusConnectionSource, options: ConnectionInventoryOptions = {}): ConnectionInventoryEntry {
  return normalizeHostedConnector({
    id: source.id,
    label: source.routeLabel,
    transport: source.transport,
    state: source.state,
    health: source.health,
    lastSeen: source.lastSeenAt,
    sourceRef: source.sourceRef,
  }, options);
}

export function normalizeBrowserSession(source: BrowserSessionConnectionSource, options: ConnectionInventoryOptions = {}): ConnectionInventoryEntry {
  const id = text(source.id, 'browser-session');
  const lastSeen = isoOrNull(source.lastSeen);
  const state: ConnectionState = source.state === 'expired'
    ? 'expired'
    : source.state === 'revoked'
      ? 'revoked'
      : source.state === 'active'
        ? 'active'
        : 'unknown';
  return base({
    id,
    class: 'browser-session',
    label: text(source.label, `Browser session · ${id}`),
    scope: text(source.scope, 'Current workspace'),
    transport: source.transport ?? 'websocket',
    state,
    health: state === 'expired' || state === 'revoked'
      ? 'offline'
      : health(source.health, lastSeen, options.now ?? Date.now(), options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    authoritySummary: 'Authenticated browser session',
    actions: ['revoke-session'],
    sourceRef: sourceRef(source.sourceRef, 'browser-session', id),
    lastSeen,
  });
}

export function normalizeMobileDevice(source: MobileDeviceConnectionSource, options: ConnectionInventoryOptions = {}): ConnectionInventoryEntry {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const id = text(source.id, 'mobile-device');
  const lastSeen = isoOrNull(source.lastSeen);
  const expiresAt = isoOrNull(source.expiresAt);
  const state: ConnectionState = source.revokedAt
    ? 'revoked'
    : expiresAt && Date.parse(expiresAt) <= now
      ? 'expired'
      : source.pausedAt
        ? 'paused'
        : 'active';
  return base({
    id,
    class: 'mobile-device',
    label: text(source.label, source.creator ? `Phone · ${source.creator}` : `Paired phone · ${id}`),
    scope: text(source.scope, 'Current workspace'),
    transport: 'device-http',
    state,
    health: state === 'revoked' || state === 'expired'
      ? 'offline'
      : state === 'paused'
        ? 'degraded'
        : health(source.health, lastSeen, now, staleAfterMs),
    authoritySummary: 'Paired mobile device',
    actions: ['pause-device', 'revoke-device'],
    sourceRef: sourceRef(source.sourceRef, 'mobile-device', id),
    lastSeen,
  });
}

/**
 * Adapt the existing connected_apps row without exposing its scopes, key
 * material, IP address or client-auth details. App/service keys use the
 * browser-session class in the shared inventory because they are remote
 * application sessions; their authority summary still names the key class.
 */
export function normalizeRemoteAccessEntry(source: RemoteAccessEntryConnectionSource, options: ConnectionInventoryOptions = {}): ConnectionInventoryEntry {
  if (source.kind === 'mobile') {
    return normalizeMobileDevice({
      id: source.id,
      label: source.label,
      creator: source.creator,
      pairedAt: source.pairedAt,
      lastSeen: source.lastSeen,
      expiresAt: source.expiresAt,
      pausedAt: source.pausedAt,
      sourceRef: source.sourceRef ?? `connected_apps:${source.id}`,
    }, options);
  }
  const now = options.now ?? Date.now();
  const lastSeen = isoOrNull(source.lastSeen);
  const expiresAt = isoOrNull(source.expiresAt);
  const state: ConnectionState = expiresAt && Date.parse(expiresAt) <= now
    ? 'expired'
    : source.pausedAt
      ? 'paused'
      : 'active';
  return base({
    id: source.id,
    class: 'browser-session',
    label: text(source.label, source.kind === 'service' ? `Service key · ${source.id}` : `App key · ${source.id}`),
    scope: 'Current workspace',
    transport: 'https',
    state,
    health: state === 'expired' ? 'offline' : state === 'paused' ? 'degraded' : health(undefined, lastSeen, now, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    authoritySummary: source.kind === 'service' ? 'Workspace service key access' : 'User app key access',
    actions: ['revoke-session'],
    sourceRef: sourceRef(source.sourceRef, 'browser-session', source.id),
    lastSeen,
  });
}

export const normalizeConnectedAppEntry = normalizeRemoteAccessEntry;
export const normalizeConnectedAppDevice = normalizeRemoteAccessEntry;

/** Stable wording for status and destructive-action confirmation surfaces. */
export function connectionStatusCopy(entry: ConnectionInventoryEntry): ConnectionStatusCopy {
  const serviceKey = entry.authoritySummary.toLowerCase().includes('service');
  if (entry.class === 'mobile-device') {
    if (entry.state === 'paused') {
      return { status: 'Paused', revokeLabel: 'Unpair phone', revokeBody: 'The phone is signed out on its next request and has to be paired again.' };
    }
    if (entry.state === 'expired') {
      return { status: 'Pairing expired', revokeLabel: 'Unpair phone', revokeBody: 'The pairing has expired. Unpairing removes the remaining device grant.' };
    }
    if (entry.state === 'revoked') {
      return { status: 'Revoked', revokeLabel: 'Unpair phone', revokeBody: 'The phone is already revoked and must be paired again to regain access.' };
    }
    return { status: entry.health === 'degraded' ? 'Connected · stale' : 'Connected', revokeLabel: 'Unpair phone', revokeBody: 'The phone is signed out on its next request and has to be paired again.' };
  }
  if (entry.state === 'paused') {
    return { status: 'Paused', revokeLabel: serviceKey ? 'Revoke service key' : 'Revoke app access', revokeBody: 'Its next request is refused. This cannot be undone — connect the app again to give it access back.' };
  }
  if (entry.state === 'expired') {
    return { status: 'Expired', revokeLabel: serviceKey ? 'Revoke service key' : 'Revoke app access', revokeBody: 'This key has expired and cannot be used again.' };
  }
  return { status: entry.health === 'degraded' ? 'Connected · stale' : 'Connected', revokeLabel: serviceKey ? 'Revoke service key' : 'Revoke app access', revokeBody: 'Its next request is refused. This cannot be undone — connect the app again to give it access back.' };
}

export function connectionConfirmationCopy(entry: ConnectionInventoryEntry): ConnectionConfirmationCopy {
  const status = connectionStatusCopy(entry);
  return {
    titleVerb: entry.class === 'mobile-device' ? 'Unpair' : 'Revoke',
    confirmLabel: status.revokeLabel,
    body: status.revokeBody,
  };
}

/** Normalize every supplied source while preserving source and input order. */
export function normalizeConnectionInventory(
  sources: ConnectionInventorySources,
  options: ConnectionInventoryOptions = {},
): ConnectionInventoryEntry[] {
  return [
    ...(sources.sshProfiles ?? []).map(normalizeSshProfile),
    ...(sources.portalRelays ?? []).map(normalizePortalRelay),
    ...(sources.hostedConnectors ?? []).map((source) => normalizeHostedConnector(source, options)),
    ...(sources.browserSessions ?? []).map((source) => normalizeBrowserSession(source, options)),
    ...(sources.mobileDevices ?? []).map((source) => normalizeMobileDevice(source, options)),
  ];
}

